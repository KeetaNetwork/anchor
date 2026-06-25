import type { Logger } from '../log/index.js';
import type * as KeetaNet from '@keetanetwork/keetanet-client';
import type { Resolver } from '../index.js';
import type { AnchorGraph } from './graph.js';
import type {
	AnchorChainingAccountOverrides,
	AnchorChainingPathEventMap,
	AnchorChainingPathExecuteOptions,
	AnchorChainingPathExecuteResult,
	AnchorChainingPathInput,
	AnchorChainingPathState,
	AnchorChainingPreview,
	AnchorChainingStepLike,
	PlanDisclaimers,
	PreviewKnownValue,
	PreviewStep,
	ProviderDisclaimers
} from './types.js';
import type { StepExecutor } from './steps/executor.js';
import type { StepContext } from './steps/context.js';
import type { AnchorChainingStore } from './store.js';
import { AnchorChainingError } from './errors.js';
import { classifyForwardedSteps } from './steps/context.js';
import { createStepExecutor } from './steps/executor.js';
import { AnchorChainingExecution } from './execution.js';
import { AnchorChainingStoreMemory } from './store.js';

/**
 * The minimal surface {@link AnchorChainingPath}/{@link AnchorChainingPlan}
 * need from the owning chaining instance. Decouples the plan from the facade so
 * there is no import cycle.
 */
export interface ChainingHost {
	readonly client: KeetaNet.UserClient;
	readonly resolver: Resolver;
	readonly logger?: Logger | undefined;
	readonly graph: AnchorGraph;
}

/**
 * Options governing plan computation.
 */
export interface ComputePlanOptions {
	overrides?: AnchorChainingAccountOverrides;
	/**
	 * Limit the number of plans to calculate, defaults to 3.
	 */
	limit?: number;
	/**
	 * Per-leg slippage tolerance in basis points used to derive each leg's
	 * minimum acceptable output. Omitted means no per-leg floor.
	 */
	slippageBps?: number;
	/**
	 * Durable store backing execution state for resume. Defaults to an
	 * in-memory store scoped to the plan instance.
	 */
	store?: AnchorChainingStore;
}

/**
 * Resolve the affinity (whether the source or destination amount is fixed) and
 * the fixed amount from a request.
 */
function resolveAffinity(request: AnchorChainingPathInput): { affinity: 'from' | 'to'; amount: bigint } {
	if (request.source.value !== undefined && request.destination.value !== undefined) {
		throw(new AnchorChainingError('INVALID_REQUEST', 'Must have source.value or destination.value but not both'));
	}

	if (request.source.value !== undefined) {
		return({ affinity: 'from', amount: request.source.value });
	}

	if (request.destination.value !== undefined) {
		return({ affinity: 'to', amount: request.destination.value });
	}

	throw(new AnchorChainingError('INVALID_REQUEST', 'Must have source.value or destination.value'));
}

/**
 * A discovered path between a source and destination. Carries provider-legal
 * disclaimers and the context the engine and preview share, but performs no
 * irreversible work.
 */
export class AnchorChainingPath {
	readonly request: AnchorChainingPathInput;
	readonly path: AnchorChainingStepLike[];
	readonly host: ChainingHost;

	constructor(input: {
		request: AnchorChainingPathInput;
		path: AnchorChainingStepLike[];
		host: ChainingHost;
	}) {
		this.request = input.request;
		this.path = input.path;
		this.host = input.host;
	}

	get logger(): Logger | undefined {
		return(this.host.logger);
	}

	/**
	 * Build the shared {@link StepContext} for this path under the given
	 * options. Side-effect-free: resolves affinity and forwarded-step
	 * classification only.
	 */
	buildContext(options?: ComputePlanOptions): StepContext {
		const { affinity, amount } = resolveAffinity(this.request);

		const context: StepContext = {
			client: this.host.client,
			resolver: this.host.resolver,
			logger: this.host.logger,
			fxClient: this.host.graph.fxClient,
			assetMovementClient: this.host.graph.assetMovementClient,
			request: this.request,
			path: this.path,
			affinity,
			affinityAmount: amount,
			overrides: options?.overrides,
			slippageBps: options?.slippageBps,
			forwardedIndexes: classifyForwardedSteps(this.path)
		};

		return(context);
	}

	async getProviderLegalDisclaimers(): Promise<PlanDisclaimers | null> {
		const legalDisclaimerPromises: { key: string; promise: () => Promise<ProviderDisclaimers | null> }[] = [];

		for (const step of this.path) {
			if (step.type === 'keetaSend') {
				continue;
			}

			const key = `${step.type}:${step.providerID}`;
			if (legalDisclaimerPromises.some(entry => entry.key === key)) {
				continue;
			}

			const promise = async () => {
				try {
					let disclaimers: ProviderDisclaimers['disclaimers'] | null | undefined = null;
					if (step.type === 'assetMovement') {
						const provider = await this.host.graph.getAssetMovementProviderById(step.providerID);
						disclaimers = provider?.getLegalDisclaimers();
					} else {
						disclaimers = await this.host.graph.fxClient.getLegalDisclaimersById(step.providerID);
					}

					if (!disclaimers) {
						return(null);
					}

					return({ providerID: step.providerID, disclaimers });
				} catch (error) {
					this.logger?.debug(`AnchorChainingPath::getProviderLegalDisclaimers`, `Error getting provider disclaimers for providerId: ${step.providerID}`, error);
					throw(error);
				}
			};

			legalDisclaimerPromises.push({ key, promise });
		}

		try {
			const disclaimersOrNull = await Promise.all(legalDisclaimerPromises.map((entry) => entry.promise()));
			const disclaimers = disclaimersOrNull.filter((entry) => entry !== null);
			return(disclaimers);
		} catch (error) {
			this.logger?.debug(`AnchorChainingPath::getProviderLegalDisclaimers`, 'Error getting legal disclaimers for path', error);
			return(null);
		}
	}
}

/**
 * A path together with its computed, side-effect-free preview. Computing a plan
 * estimates each leg's amounts and per-leg output floor; it never initiates a
 * transfer, creates an exchange, or reserves a persistent-forwarding address.
 */
export class AnchorChainingPlan extends AnchorChainingPath {
	#preview: AnchorChainingPreview | null = null;
	readonly #options: ComputePlanOptions | undefined;
	readonly #store: AnchorChainingStore;
	#execution: AnchorChainingExecution | null = null;

	private constructor(path: AnchorChainingPath, options?: ComputePlanOptions) {
		super({ request: path.request, path: path.path, host: path.host });
		this.#options = options;
		this.#store = options?.store ?? new AnchorChainingStoreMemory();
	}

	get preview(): AnchorChainingPreview {
		if (!this.#preview) {
			throw(new AnchorChainingError('INVALID_STATE', `Preview has not been computed yet`));
		}

		return(this.#preview);
	}

	get options(): ComputePlanOptions | undefined {
		return(this.#options);
	}

	/**
	 * The execution engine bound to this plan's preview and store. Created once
	 * so event listeners attached via {@link on} observe the same instance that
	 * {@link execute}/{@link resume} drive.
	 */
	#getExecution(): AnchorChainingExecution {
		if (!this.#execution) {
			this.#execution = new AnchorChainingExecution({
				ctx: this.buildContext(this.#options),
				preview: this.preview,
				store: this.#store
			});
		}

		return(this.#execution);
	}

	get state(): AnchorChainingPathState {
		return(this.#getExecution().state);
	}

	on<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		this.#getExecution().on(event, listener);
	}

	off<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		this.#getExecution().off(event, listener);
	}

	/**
	 * Execute the plan, driving each leg from the actual output the prior leg
	 * delivered. Returns the correlation id (via the result) for {@link resume}.
	 */
	async execute(options: AnchorChainingPathExecuteOptions = {}): Promise<AnchorChainingPathExecuteResult> {
		return(await this.#getExecution().execute(options));
	}

	/**
	 * Resume a previously-interrupted execution, skipping settled legs and
	 * driving the remainder forward.
	 */
	async resume(correlationID: string, options: AnchorChainingPathExecuteOptions = {}): Promise<AnchorChainingPathExecuteResult> {
		return(await this.#getExecution().resume(correlationID, options));
	}

	/**
	 * Resolve every leg's side-effect-free estimate, threading the known value
	 * along the path. Affinity `from` drives input forward (leg 0 to last);
	 * affinity `to` drives output backward (last to leg 0), each feeding the
	 * next leg's known side.
	 */
	async #resolvePreviewSteps(executors: StepExecutor[], ctx: StepContext): Promise<Map<number, PreviewStep>> {
		const resolved = new Map<number, PreviewStep>();
		const forward = ctx.affinity === 'from';
		const indices = executors.map((_, offset) => forward ? offset : executors.length - 1 - offset);

		let known: PreviewKnownValue = { side: forward ? 'in' : 'out', value: ctx.affinityAmount };
		for (const index of indices) {
			const executor = executors[index];
			if (!executor) {
				throw(new AnchorChainingError('STEP_NOT_DEFINED', `Step ${index} is not defined`));
			}

			const step = await executor.preview(known);
			resolved.set(index, step);
			known = forward ? { side: 'in', value: step.estimatedValueOut } : { side: 'out', value: step.estimatedValueIn };
		}

		return(resolved);
	}

	async #computePreview(): Promise<AnchorChainingPreview> {
		const ctx = this.buildContext(this.#options);

		if (this.path.length === 0) {
			throw(new AnchorChainingError('INVALID_PATH', `Cannot compute a preview for an empty path`));
		}

		const executors = this.path.map((_, index) => createStepExecutor(ctx, index));
		const resolved = await this.#resolvePreviewSteps(executors, ctx);

		const previewSteps: PreviewStep[] = [];
		for (let index = 0; index < executors.length; index++) {
			const step = resolved.get(index);
			if (!step) {
				throw(new AnchorChainingError('STEP_NOT_DEFINED', `Preview step ${index} was not resolved`));
			}
			previewSteps.push(step);
		}

		const firstStep = previewSteps[0];
		const lastStep = previewSteps.at(-1);
		if (!firstStep || !lastStep) {
			throw(new AnchorChainingError('INVALID_PATH', `Preview produced no steps`));
		}

		if (lastStep.estimatedValueOut <= 0n) {
			throw(new AnchorChainingError('INVALID_PATH', `Estimated output for last step must be greater than 0, got ${lastStep.estimatedValueOut}`));
		}

		const minDestinationValue = ctx.affinity === 'to' ? ctx.affinityAmount : lastStep.minOutput;

		return({
			affinity: ctx.affinity,
			steps: previewSteps,
			totalValueIn: firstStep.estimatedValueIn,
			totalValueOut: lastStep.estimatedValueOut,
			minDestinationValue
		});
	}

	static async create(path: AnchorChainingPath, options?: ComputePlanOptions): Promise<AnchorChainingPlan> {
		const instance = new this(path, options);
		instance.#preview = await instance.#computePreview();
		return(instance);
	}
}
