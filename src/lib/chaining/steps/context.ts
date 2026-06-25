import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as KeetaNet from '@keetanetwork/keetanet-client';

import type { Resolver } from '../../index.js';
import type { Logger } from '../../log/index.js';
import type KeetaFXAnchorClient from '../../../services/fx/client.js';
import type KeetaAssetMovementAnchorClient from '../../../services/asset-movement/client.js';
import type {
	AnchorChainingAccountOverrides,
	AnchorChainingPathInput,
	AnchorChainingStepLike,
	GetAccountForActionPayload
} from '../types.js';
import { AnchorChainingError } from '../errors.js';

/**
 * Everything a {@link StepExecutor} needs to preview and execute one leg of a
 * chain. Resolved once per execution and shared (read-only) across steps.
 */
export interface StepContext {
	client: KeetaNet.UserClient;
	resolver: Resolver;
	logger?: Logger | undefined;
	fxClient: KeetaFXAnchorClient;
	assetMovementClient: KeetaAssetMovementAnchorClient;
	request: AnchorChainingPathInput;
	path: AnchorChainingStepLike[];
	affinity: 'from' | 'to';
	affinityAmount: bigint;
	overrides?: AnchorChainingAccountOverrides | undefined;
	slippageBps?: number | undefined;
	/**
	 * Indexes of asset-movement steps that deposit into a persistent-forwarding
	 * address rather than initiating a managed transfer.
	 */
	forwardedIndexes: ReadonlySet<number>;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Apply a slippage tolerance (in basis points) to an estimated output to derive
 * the per-leg floor. With no tolerance (or a non-positive one) there is no
 * floor and `0n` is returned, so drift is absorbed by re-pricing downstream.
 */
export function applySlippage(estimatedValueOut: bigint, slippageBps?: number): bigint {
	if (slippageBps === undefined || slippageBps <= 0) {
		return(0n);
	}
	if (slippageBps >= Number(BPS_DENOMINATOR)) {
		return(0n);
	}

	const keepBps = BPS_DENOMINATOR - BigInt(Math.floor(slippageBps));
	return((estimatedValueOut * keepBps) / BPS_DENOMINATOR);
}

/**
 * Resolve a single account-like value for a provider action, honoring an
 * explicit override (value or resolver function) before falling back to the
 * client's account or signer.
 */
export async function resolveAccountLike(
	client: KeetaNet.UserClient,
	action: GetAccountForActionPayload,
	override?: AnchorChainingAccountOverrides['account']
): Promise<InstanceType<typeof KeetaNetLib.Account>> {
	let found: InstanceType<typeof KeetaNetLib.Account> | undefined = undefined;

	if (client.account.isAccount()) {
		found = client.account;
	} else if (client.signer !== null) {
		found = client.signer;
	}

	if (override) {
		if (typeof override === 'function') {
			found = await override(action);
		} else {
			found = override;
		}
	}

	if (!found) {
		throw(new AnchorChainingError('INVALID_REQUEST', `Could not get account for ${action.type} action ${action.providerMethod}`));
	}

	return(found);
}

/**
 * Resolve both the signer and account for a provider action.
 */
export async function resolveAccountsForAction(
	client: KeetaNet.UserClient,
	action: GetAccountForActionPayload,
	overrides?: AnchorChainingAccountOverrides
): Promise<{ account: InstanceType<typeof KeetaNetLib.Account>; signer: InstanceType<typeof KeetaNetLib.Account> }> {
	const [signer, account] = await Promise.all([
		resolveAccountLike(client, action, overrides?.signer),
		resolveAccountLike(client, action, overrides?.account)
	]);

	return({ signer, account });
}

/**
 * Classify which asset-movement steps deposit into a persistent-forwarding
 * address. Pure over the path's resolved rail metadata; performs no I/O and
 * creates no forwarding address.
 */
export function classifyForwardedSteps(path: AnchorChainingStepLike[]): Set<number> {
	const forwarded = new Set<number>();
	for (let index = 0; index < path.length; index++) {
		const step = path[index];
		if (!step || step.type !== 'assetMovement') {
			continue;
		}

		const priorStep = index > 0 ? path[index - 1] : null;
		const isAmpToAmpTransition = priorStep?.type === 'assetMovement';
		const pfrSupported = step.from.supportedOperations?.createPersistentForwarding === true;
		const initiateForbidden = step.from.supportedOperations?.initiateTransfer === false;

		const shouldUsePFR = initiateForbidden || (isAmpToAmpTransition && pfrSupported);
		if (!shouldUsePFR) {
			continue;
		}

		if (!pfrSupported) {
			throw(new AnchorChainingError('INVALID_PATH', `Asset movement provider ${step.providerID} source rail ${step.from.rail} declares initiateTransfer:false but does not support createPersistentForwarding`));
		}

		if (index !== path.length - 1) {
			throw(new AnchorChainingError('INVALID_PATH', `Persistent-forwarding asset movement steps are currently only supported as the last step in a chain (step ${index} of ${path.length})`));
		}

		forwarded.add(index);
	}

	return(forwarded);
}
