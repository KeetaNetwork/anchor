import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Resolver } from '../index.js';
import type { Logger } from '../log/index.js';
import type { ChainingHost, ComputePlanOptions } from './plan.js';
import type {
	AnchorChainingAssetInfo,
	AnchorChainingAssetInfoWithMetadata,
	AnchorChainingConfig,
	AnchorChainingListAssetsFilter,
	AnchorChainingPathInput,
	AnchorChainingResolveAssetsFilter,
	AnchorChainingResolveAssetsResult,
	AnchorChainingResolveAssetsWithMetadataResult,
	AnchorChainingStepLike,
	AnchorChainingWithMetadataOptions
} from './types.js';
import { AnchorGraph } from './graph.js';
import { AnchorChainingPath, AnchorChainingPlan } from './plan.js';
import { convertAssetLocationToString, isChainLocation, toAssetLocation } from '../../services/asset-movement/common.js';
import { getDefaultResolver } from '../../config.js';
import { isAnchorChainingAssetEqual } from './types.js';

/**
 * A plan-computation outcome that preserves failures alongside successes, for
 * callers that pass `includeAllOutput`.
 */
export type AnchorChainingFullPlanResult = (({ success: true; plan: AnchorChainingPlan } | { success: false; error: unknown }) & { path: AnchorChainingPath });

const DEFAULT_PLAN_LIMIT = 3;
const MAX_PLAN_ATTEMPT_LOOPS = 3;

/**
 * Entry point for anchor chaining. Discovers routes between a source and
 * destination asset, computes side-effect-free plans over them, and hands back
 * {@link AnchorChainingPlan}s whose durable, actual-driven engine executes and
 * can resume the chain. Backwards-compatible facade over the engine.
 */
export class AnchorChaining implements ChainingHost {
	readonly client: KeetaNet.UserClient;
	readonly resolver: Resolver;
	readonly graph: AnchorGraph;
	readonly logger?: Logger | undefined;

	constructor(config: AnchorChainingConfig) {
		this.client = config.client;
		this.resolver = config.resolver ?? getDefaultResolver(config.client);
		this.logger = config.logger;
		this.graph = new AnchorGraph({
			resolver: this.resolver,
			client: this.client,
			...(this.logger ? { logger: this.logger } : {})
		});
	}

	async resolveAssets(filter: AnchorChainingResolveAssetsFilter = {}): Promise<AnchorChainingResolveAssetsResult> {
		return(await this.graph.resolveAssets(filter));
	}

	async listAssets(filter: AnchorChainingListAssetsFilter = {}): Promise<AnchorChainingAssetInfo[]> {
		return(await this.graph.listAssets(filter));
	}

	async resolveAssetsWithMetadata(filter: AnchorChainingResolveAssetsFilter = {}, options?: AnchorChainingWithMetadataOptions): Promise<AnchorChainingResolveAssetsWithMetadataResult> {
		return(await this.graph.resolveAssetsWithMetadata(filter, options));
	}

	async listAssetsWithMetadata(filter: AnchorChainingListAssetsFilter = {}, options?: AnchorChainingWithMetadataOptions): Promise<AnchorChainingAssetInfoWithMetadata[]> {
		return(await this.graph.listAssetsWithMetadata(filter, options));
	}

	/**
	 * Discover candidate paths between the request's source and destination. A
	 * same-asset, same-Keeta-location request resolves to a single direct send.
	 */
	async getPaths(input: AnchorChainingPathInput): Promise<AnchorChainingPath[] | null> {
		const sourceLocation = toAssetLocation(input.source.location);
		const destinationLocation = toAssetLocation(input.destination.location);

		let foundPaths: AnchorChainingStepLike[][] | null;

		if (
			input.source.rail === 'KEETA_SEND' &&
			input.destination.rail === 'KEETA_SEND' &&
			convertAssetLocationToString(sourceLocation) === convertAssetLocationToString(destinationLocation) &&
			isChainLocation(sourceLocation, 'keeta') &&
			isChainLocation(destinationLocation, 'keeta') &&
			isAnchorChainingAssetEqual(input.source.asset, input.destination.asset)
		) {
			const fromTo = {
				asset: input.source.asset,
				location: sourceLocation,
				rail: 'KEETA_SEND'
			} as const;

			foundPaths = [
				[ { type: 'keetaSend', from: fromTo, to: fromTo } ]
			];
		} else {
			foundPaths = await this.graph.findPaths(input);
		}

		foundPaths = foundPaths?.filter(path => {
			for (let i = 0; i < path.length - 1; i++) {
				const item = path[i];
				if (!item) {
					continue;
				}

				const toLocation = toAssetLocation(item.to.location);
				if (toLocation.type !== 'chain' && i < path.length - 1) {
					return(false);
				}
			}

			return(true);
		}) ?? null;

		if (!foundPaths || foundPaths.length === 0) {
			return(null);
		}

		return(foundPaths.map(path => new AnchorChainingPath({ request: input, path, host: this })));
	}

	async getPlans(input: AnchorChainingPathInput, options?: ComputePlanOptions & { includeAllOutput?: false }): Promise<AnchorChainingPlan[] | null>;
	async getPlans(input: AnchorChainingPathInput, options: ComputePlanOptions & { includeAllOutput: true }): Promise<AnchorChainingFullPlanResult[] | null>;
	async getPlans(input: AnchorChainingPathInput, options?: ComputePlanOptions & { includeAllOutput?: boolean }): Promise<(AnchorChainingPlan | AnchorChainingFullPlanResult)[] | null> {
		const paths = await this.getPaths(input);
		if (!paths) {
			return(null);
		}

		const limit = options?.limit ?? DEFAULT_PLAN_LIMIT;
		const sortedPaths = paths.sort((a, b) => a.path.length - b.path.length);

		const allOutput: PromiseSettledResult<AnchorChainingPlan>[] = [];
		let successCount = 0;
		let lowestStepsSuccessCount = Infinity;
		let lastAttemptedPathIdx = -1;
		let currentAttemptLoop = 0;
		while (successCount < limit && lastAttemptedPathIdx < sortedPaths.length - 1 && currentAttemptLoop < MAX_PLAN_ATTEMPT_LOOPS) {
			currentAttemptLoop++;

			const pathsToTry = sortedPaths.slice(lastAttemptedPathIdx + 1, lastAttemptedPathIdx + 1 + (limit - successCount));
			const firstToTry = pathsToTry[0];
			if (!firstToTry || firstToTry.path.length > lowestStepsSuccessCount) {
				break;
			}

			const currentTry = await Promise.allSettled(pathsToTry.map(path => AnchorChainingPlan.create(path, options)));
			allOutput.push(...currentTry);

			for (let i = 0; i < currentTry.length; i++) {
				const result = currentTry[i];
				const path = pathsToTry[i];
				if (!result || !path) {
					continue;
				}

				if (result.status === 'fulfilled') {
					successCount++;
					if (path.path.length < lowestStepsSuccessCount) {
						lowestStepsSuccessCount = path.path.length;
					}
				}
			}

			lastAttemptedPathIdx += pathsToTry.length;
		}

		const ret: (AnchorChainingPlan | AnchorChainingFullPlanResult)[] = [];
		for (let i = 0; i < allOutput.length; i++) {
			const path = sortedPaths[i];
			const plan = allOutput[i];
			if (!path || !plan) {
				continue;
			}

			if (options?.includeAllOutput) {
				if (plan.status === 'rejected') {
					ret.push({ success: false, error: plan.reason, path });
				} else {
					ret.push({ success: true, plan: plan.value, path });
				}
			} else if (plan.status === 'rejected') {
				this.logger?.debug(`AnchorChaining::getPlans`, `Error computing plan for a path:`, plan.reason);
			} else {
				ret.push(plan.value);
			}
		}

		return(ret);
	}
}
