import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { randomUUID } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';

import type {
	AnchorChainingPathEventMap,
	AnchorChainingPathExecuteOptions,
	AnchorChainingPathExecuteResult,
	AnchorChainingPathState,
	AnchorChainingPreview,
	AnchorChainingStepLike,
	AssetMovementGraphNode,
	ExecutedStep,
	StepNeededActionEventPayload
} from './types.js';
import type { FiatPushRails, KeetaPersistentForwardingAddressDetails, SimulatedAssetTransferInstructions } from '../../services/asset-movement/common.js';
import type { Logger } from '../log/index.js';
import type { AnchorChainingStore, ChainingStepRecord, ExecutionState } from './store.js';
import type { StepContext } from './steps/context.js';
import type { PollSettings, ResolvedRecipient, StepRunInput, WithdrawRef } from './steps/run.js';
import { AnchorChainingError } from './errors.js';
import { convertAssetLocationToString } from '../../services/asset-movement/common.js';
import { isFiatRail } from '../../services/asset-movement/common.generated.js';
import { stepIdempotencyKey } from './store.js';
import { resolveAccountsForAction } from './steps/context.js';
import { createStepExecutor } from './steps/executor.js';
import { recoverableSend } from './retry.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

/**
 * The completion-callback argument tuple for each action type, keyed by the
 * action's discriminant. Derived from the event payloads so the engine's
 * `markCompleted` contract stays in lockstep with {@link StepNeededActionEventPayload}.
 */
type StepCompletedArgs = {
	[Payload in StepNeededActionEventPayload as Payload['type']]: Parameters<Payload['markCompleted']>;
};

/**
 * Configuration for an {@link AnchorChainingExecution}.
 */
export interface AnchorChainingExecutionConfig {
	ctx: StepContext;
	preview: AnchorChainingPreview;
	store: AnchorChainingStore;
}

/**
 * The durable, resume-forward execution engine for one path.
 *
 * Execution is driven by the output of each leg: every leg is priced
 * and initiated from the real amount the prior leg delivered, so provider
 * slippage never strands an intermediate asset.
 */
export class AnchorChainingExecution {
	readonly #ctx: StepContext;
	readonly #preview: AnchorChainingPreview;
	readonly #store: AnchorChainingStore;
	readonly #logger: Logger | undefined;

	#state: AnchorChainingPathState = { status: 'idle' };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();
	readonly #forwardedAddresses = new Map<number, KeetaPersistentForwardingAddressDetails>();

	constructor(config: AnchorChainingExecutionConfig) {
		this.#ctx = config.ctx;
		this.#preview = config.preview;
		this.#store = config.store;
		this.#logger = config.ctx.logger;
	}

	get state(): AnchorChainingPathState {
		return(this.#state);
	}

	on<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		let listenerSet = this.#listeners.get(event);
		if (!listenerSet) {
			listenerSet = new Set();
			this.#listeners.set(event, listenerSet);
		}

		listenerSet.add(listener);
	}

	off<E extends keyof AnchorChainingPathEventMap>(event: E, listener: (...args: AnchorChainingPathEventMap[E]) => void): void {
		this.#listeners.get(event)?.delete(listener);
	}

	#emit<E extends keyof AnchorChainingPathEventMap>(event: E, ...args: AnchorChainingPathEventMap[E]): { sendCount: number } {
		let sendCount = 0;

		for (const listener of (this.#listeners.get(event) ?? [])) {
			try {
				listener(...args);
				sendCount++;
			} catch (err) {
				this.#logger?.debug(`AnchorChainingExecution::emit`, `Error in listener for event '${event}'`, err);
			}
		}

		return({ sendCount });
	}

	#setState(state: AnchorChainingPathState): void {
		this.#state = state;
		this.#emit('stateChange', state);
	}

	async #awaitStepCompletion<Type extends StepNeededActionEventPayload['type']>(
		step: Pick<Extract<StepNeededActionEventPayload, { type: Type }>, 'action' | 'type'>
	): Promise<StepCompletedArgs[Type]> {
		type Ret = StepCompletedArgs[Type];

		let didComplete = false;

		function assertDidNotComplete() {
			if (didComplete) {
				throw(new AnchorChainingError('INVALID_STATE', `Step was already marked as completed or failed`));
			}

			didComplete = true;
		}

		let resolveFn: undefined | ((...args: Ret) => void);
		let rejectFn: undefined | StepNeededActionEventPayload['markFailed'];

		const promise = new Promise<Ret>(function(resolve, reject) {
			resolveFn = (...args: Ret) => {
				assertDidNotComplete();
				resolve(args);
			};

			rejectFn = (error) => {
				assertDidNotComplete();

				let usingErr = error;
				if (!usingErr) {
					usingErr = new AnchorChainingError('INVALID_STATE', `Step marked as failed without error`);
				}

				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
				reject(usingErr);
			};
		});

		if (!resolveFn || !rejectFn) {
			throw(new AnchorChainingError('INTERNAL', `Failed to create step completion promise`));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const payload = {
			...step,
			markCompleted: resolveFn,
			markFailed: rejectFn
		} as unknown as Extract<StepNeededActionEventPayload, { type: Type }>;

		const { sendCount } = this.#emit('stepNeedsAction', payload);

		if (sendCount === 0) {
			throw(new AnchorChainingError('NO_LISTENER', `No listeners for stepNeedsAction event, but a step (actionType=${step.type}) is awaiting completion`));
		}

		return(await promise);
	}

	/**
	 * Perform a Keeta send, optionally gating on caller authorization first,
	 * then publishing with ledger recovery and retry.
	 */
	async #authorizedSend(options: AnchorChainingPathExecuteOptions, args: { to: string | GenericAccount; value: bigint; token: TokenAddress | string; external?: string | undefined }): Promise<string | undefined> {
		if (options.requireSendAuth) {
			await this.#awaitStepCompletion({
				type: 'keetaSendAuthRequired',
				action: {
					sendToAddress: KeetaNet.lib.Account.toAccount(args.to),
					value: args.value,
					token: KeetaNet.lib.Account.toAccount(args.token).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN),
					...(args.external === undefined ? {} : { external: args.external })
				}
			});
		}

		const { account } = await resolveAccountsForAction(this.#ctx.client, { type: 'assetMovement', providerMethod: 'initiateTransfer' }, this.#ctx.overrides);

		return(await recoverableSend(this.#ctx.client, {
			to: args.to,
			value: args.value,
			token: args.token,
			external: args.external,
			account
		}, { logger: this.#logger }));
	}

	/**
	 * Resolve and (lazily) create the persistent-forwarding address for the
	 * forwarded leg at `index`, reusing an existing one when the provider can
	 * list it so resume does not create duplicates.
	 */
	async #ensureForwardedAddress(index: number): Promise<KeetaPersistentForwardingAddressDetails> {
		const cached = this.#forwardedAddresses.get(index);
		if (cached) {
			return(cached);
		}

		const step = this.#ctx.path[index];
		if (step?.type !== 'assetMovement') {
			throw(new AnchorChainingError('INVALID_PATH', `Step ${index} is not an asset-movement step`));
		}

		const destinationAddress = this.#ctx.request.destination.recipient;
		if (typeof destinationAddress !== 'string') {
			throw(new AnchorChainingError('INVALID_REQUEST', `Persistent-forwarding step ${index} requires the destination recipient to be a resolved address string`));
		}

		const providers = await this.#ctx.assetMovementClient.getProvidersForTransfer(
			{ asset: { from: step.from.asset, to: step.to.asset }, from: step.from.location, to: step.to.location },
			{ providerIDs: [ step.providerID ] }
		);
		const provider = providers?.[0];
		if (!provider) {
			throw(new AnchorChainingError('PROVIDER_UNAVAILABLE', `Could not get asset movement provider ${step.providerID} for forwarded step ${index}`));
		}

		if (!await provider.isOperationSupported('createPersistentForwarding')) {
			throw(new AnchorChainingError('INVALID_PATH', `Asset movement provider ${step.providerID} does not support createPersistentForwarding`));
		}

		const { signer } = await resolveAccountsForAction(this.#ctx.client, { type: 'assetMovement', providerMethod: 'initiateTransfer', provider }, this.#ctx.overrides);
		const assetPair = { from: step.from.asset, to: step.to.asset };

		let persistentAddress: KeetaPersistentForwardingAddressDetails | undefined;
		if (await provider.isOperationSupported('listPersistentForwarding')) {
			try {
				const existing = await provider.listForwardingAddresses({
					account: signer,
					search: [ { sourceLocation: step.from.location, destinationLocation: step.to.location, asset: step.from.asset, destinationAddress } ]
				});

				const sourceLocationString = convertAssetLocationToString(step.from.location);
				const destLocationString = convertAssetLocationToString(step.to.location);
				persistentAddress = existing.addresses.find(addr => {
					if (addr.destinationAddress !== destinationAddress) {
						return(false);
					}
					if (!addr.sourceLocation || convertAssetLocationToString(addr.sourceLocation) !== sourceLocationString) {
						return(false);
					}
					if (!addr.destinationLocation || convertAssetLocationToString(addr.destinationLocation) !== destLocationString) {
						return(false);
					}

					return(true);
				});
			} catch (error) {
				this.#logger?.debug('AnchorChainingExecution::ensureForwardedAddress', `listForwardingAddresses lookup failed for step ${index}; will create a new address`, error);
			}
		}

		persistentAddress ??= await provider.createPersistentForwardingAddress({
			account: signer,
			sourceLocation: step.from.location,
			destinationLocation: step.to.location,
			destinationAddress,
			asset: assetPair
		});

		if (typeof persistentAddress.address !== 'string') {
			throw(new AnchorChainingError('INVALID_STATE', `Persistent forwarding address for step ${index} is not a resolved string`));
		}

		this.#forwardedAddresses.set(index, persistentAddress);
		return(persistentAddress);
	}

	/**
	 * Resolve where an asset-movement leg at `index` should deliver, driven by
	 * the actual input value for any downstream simulation.
	 */
	async #resolveRecipient(index: number, actualInput: bigint): Promise<ResolvedRecipient> {
		const step = this.#ctx.path[index];
		if (step?.type !== 'assetMovement') {
			throw(new AnchorChainingError('INVALID_PATH', `Step ${index} is not an asset-movement step`));
		}

		if (index === this.#ctx.path.length - 1) {
			return({ recipient: this.#ctx.request.destination.recipient, sendingTo: 'FINAL_DESTINATION' });
		}

		const nextStep = this.#ctx.path[index + 1];
		if (!nextStep) {
			throw(new AnchorChainingError('STEP_NOT_DEFINED', `Expected next step at index ${index + 1}`));
		}

		if (this.#ctx.forwardedIndexes.has(index + 1)) {
			const pfi = await this.#ensureForwardedAddress(index + 1);
			if (typeof pfi.address !== 'string') {
				throw(new AnchorChainingError('INVALID_STATE', `Persistent forwarding address for next step ${index + 1} is not a resolved string`));
			}
			return({ recipient: pfi.address, sendingTo: 'NEXT_STEP' });
		}

		const keetaNetworkLocation = `chain:keeta:${this.#ctx.client.network}`;
		if (convertAssetLocationToString(nextStep.from.location) === keetaNetworkLocation) {
			const { account } = await resolveAccountsForAction(this.#ctx.client, { type: 'assetMovement', providerMethod: 'initiateTransfer' }, this.#ctx.overrides);
			return({ recipient: account.publicKeyString.get(), sendingTo: 'NEXT_STEP' });
		}

		return(await this.#resolveOffKeetaRecipient(step, nextStep, actualInput));
	}

	/**
	 * Resolve the recipient for an off-Keeta intermediate hand-off by simulating
	 * this leg and reading the next provider's deposit instruction.
	 */
	async #resolveOffKeetaRecipient(step: AssetMovementGraphNode, nextStep: AnchorChainingStepLike, actualInput: bigint): Promise<ResolvedRecipient> {
		if (nextStep.type !== 'assetMovement') {
			throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Cannot chain to a non-asset-movement step at a non-Keeta intermediate location`));
		}

		const providers = await this.#ctx.assetMovementClient.getProvidersForTransfer(
			{ asset: { from: nextStep.from.asset, to: nextStep.to.asset }, from: nextStep.from.location, to: nextStep.to.location },
			{ providerIDs: [ nextStep.providerID ] }
		);
		const nextProvider = providers?.[0];
		if (!nextProvider) {
			throw(new AnchorChainingError('PROVIDER_UNAVAILABLE', `Could not get next asset movement provider ${nextStep.providerID}`));
		}

		const { signer } = await resolveAccountsForAction(this.#ctx.client, { type: 'assetMovement', providerMethod: 'initiateTransfer', provider: nextProvider }, this.#ctx.overrides);

		const thisProviders = await this.#ctx.assetMovementClient.getProvidersForTransfer(
			{ asset: { from: step.from.asset, to: step.to.asset }, from: step.from.location, to: step.to.location },
			{ providerIDs: [ step.providerID ] }
		);
		const thisProvider = thisProviders?.[0];
		if (!thisProvider || !await thisProvider.isOperationSupported('simulateTransfer')) {
			throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Asset movement provider ${step.providerID} does not support simulateTransfer required for non-Keeta intermediate chaining`));
		}

		const simulated = await thisProvider.simulateTransfer({
			account: signer,
			asset: { from: step.from.asset, to: step.to.asset },
			from: { location: step.from.location },
			to: { location: step.to.location },
			value: actualInput
		});

		const simulatedInstruction = simulated.instructions.find((instr): instr is Extract<SimulatedAssetTransferInstructions, { type: typeof step.from.rail }> => instr.type === step.from.rail);
		let expectedOut: string | undefined = simulatedInstruction?.totalReceiveAmount;
		if (expectedOut === undefined && simulatedInstruction && 'value' in simulatedInstruction) {
			expectedOut = simulatedInstruction.value;
		}
		if (expectedOut === undefined) {
			throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Simulated transfer for step did not yield a total-receive amount required for chaining`));
		}

		const nextTransfer = await nextProvider.initiateTransfer({
			account: signer,
			asset: { from: nextStep.from.asset, to: nextStep.to.asset },
			from: { location: nextStep.from.location },
			to: { location: nextStep.to.location, recipient: this.#ctx.request.destination.recipient },
			value: BigInt(expectedOut)
		});

		const nextInstruction = nextTransfer.instructions.find(instr => instr.type === step.to.rail);
		if (!nextInstruction) {
			throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Next step instruction of type ${step.to.rail} not found for recipient resolution`));
		}

		const isFiatPush = (instr: typeof nextInstruction): instr is Extract<typeof nextInstruction, { type: FiatPushRails }> => isFiatRail(instr.type);
		if (nextInstruction.type === 'KEETA_SEND') {
			throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Cannot chain from asset movement to KEETA_SEND across a non-Keeta intermediate`));
		} else if (isFiatPush(nextInstruction)) {
			if (nextInstruction.depositMessage) {
				throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Deposit message outbound is not supported for chaining`));
			}
			return({ recipient: nextInstruction.account, sendingTo: 'NEXT_STEP' });
		} else if (nextInstruction.type === 'EVM_SEND') {
			return({ recipient: nextInstruction.sendToAddress, sendingTo: 'NEXT_STEP' });
		}

		throw(new AnchorChainingError('UNSUPPORTED_RAIL', `Unsupported rail for chaining: ${step.to.rail}`));
	}

	/**
	 * Build a fresh, idle execution state for a correlation.
	 */
	#initState(correlationID: string): ExecutionState {
		const now = Date.now();
		const steps: ChainingStepRecord[] = this.#preview.steps.map(step => ({
			index: step.index,
			type: step.type,
			status: 'pending',
			publishedInputs: []
		}));

		return({
			correlationID,
			status: 'idle',
			currentStepIndex: 0,
			steps,
			publishedInputs: [],
			createdAtMs: now,
			updatedAtMs: now
		});
	}

	/**
	 * Start a fresh execution. Drives every leg from the actual amount the prior
	 * leg delivered.
	 */
	async execute(options: AnchorChainingPathExecuteOptions = {}): Promise<AnchorChainingPathExecuteResult> {
		if (this.#state.status !== 'idle') {
			throw(new AnchorChainingError('INVALID_STATE', `Cannot execute: path is already in state "${this.#state.status}"`));
		}

		const correlationID = options.correlationID ?? randomUUID();
		const state = this.#initState(correlationID);
		await this.#store.save(state);

		return(await this.#drive(state, options));
	}

	/**
	 * Resume a previously-failed or interrupted execution, skipping already
	 * settled legs and driving the remainder forward.
	 */
	async resume(correlationID: string, options: AnchorChainingPathExecuteOptions = {}): Promise<AnchorChainingPathExecuteResult> {
		const state = await this.#store.load(correlationID);
		if (!state) {
			throw(new AnchorChainingError('RESUME_UNAVAILABLE', `No stored execution state for correlation ${correlationID}`));
		}

		this.#state = { status: 'idle' };
		return(await this.#drive(state, options));
	}

	/**
	 * Derive the settlement-poll cadence and deadline for a run.
	 */
	#buildPoll(options: AnchorChainingPathExecuteOptions): PollSettings {
		return({
			intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			timeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
			...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
		});
	}

	/**
	 * Recover an already-settled leg on resume, yielding its actual output and
	 * the withdraw it produced so the loop can drive the next leg forward
	 * without re-performing irreversible work. Returns `null` when the leg has
	 * not settled and must be executed.
	 */
	#resumeSettledStep(record: ChainingStepRecord): { output: bigint; prevWithdrawTx: WithdrawRef | null } | null {
		if (record.status !== 'settled' || record.actualOutput === undefined) {
			return(null);
		}

		const prevWithdrawTx = record.withdraw ? { location: record.withdraw.location, transaction: { id: record.withdraw.id }} : null;
		return({ output: BigInt(record.actualOutput), prevWithdrawTx });
	}

	/**
	 * The shared actual-driven loop used by both {@link execute} and
	 * {@link resume}.
	 */
	async #drive(state: ExecutionState, options: AnchorChainingPathExecuteOptions): Promise<AnchorChainingPathExecuteResult> {
		const poll = this.#buildPoll(options);

		const executedSteps: ExecutedStep[] = [];
		this.#setState({ status: 'executing', completedSteps: [], currentStepIndex: state.currentStepIndex });

		let actualInput = this.#preview.totalValueIn;
		let prevWithdrawTx: WithdrawRef | null = null;
		let lastActualOutput = this.#preview.totalValueIn;
		let index = 0;

		const persist = async () => {
			state.updatedAtMs = Date.now();
			await this.#store.save(state);
		};

		try {
			for (index = 0; index < this.#preview.steps.length; index++) {
				if (options.abortSignal?.aborted) {
					throw(new AnchorChainingError('ABORTED', `Execution aborted`));
				}

				const record = state.steps[index];
				if (!record) {
					throw(new AnchorChainingError('STEP_NOT_DEFINED', `Step record ${index} is not defined`));
				}

				const resumed = this.#resumeSettledStep(record);
				if (resumed) {
					actualInput = resumed.output;
					lastActualOutput = resumed.output;
					prevWithdrawTx = resumed.prevWithdrawTx;
					continue;
				}

				state.currentStepIndex = index;
				this.#setState({ status: 'executing', completedSteps: [ ...executedSteps ], currentStepIndex: index });

				const previewStep = this.#preview.steps[index];
				if (!previewStep) {
					throw(new AnchorChainingError('STEP_NOT_DEFINED', `Preview step ${index} is not defined`));
				}

				const capturedInput = actualInput;
				const minOutput = previewStep.minOutput;

				const runInput: StepRunInput = {
					actualInput: capturedInput,
					preview: previewStep,
					idempotencyKey: stepIdempotencyKey(state.correlationID, index),
					record,
					publishedInputs: [ ...state.publishedInputs ],
					prevWithdrawTx,
					options,
					poll,
					persist,
					checkFloor: async (expectedOutput: bigint) => {
						await this.#checkFloor(index, expectedOutput, minOutput);
					},
					authorizedSend: async (sendArgs) => {
						return(await this.#authorizedSend(options, sendArgs));
					},
					awaitAssetMovementExecution: async (transfer) => {
						await this.#awaitStepCompletion({ type: 'assetMovementUserExecutionRequired', action: { assetMovementTransfer: transfer }});
					},
					resolveRecipient: async () => {
						return(await this.#resolveRecipient(index, capturedInput));
					},
					ensureForwardedAddress: async () => {
						return(await this.#ensureForwardedAddress(index));
					}
				};

				const executor = createStepExecutor(this.#ctx, index);
				const result = await executor.run(runInput);

				record.status = 'settled';
				record.actualInput = capturedInput.toString();
				record.actualOutput = result.actualOutput.toString();
				record.publishedInputs = result.publishedInputs;
				if (result.withdrawTx) {
					record.withdraw = { location: result.withdrawTx.location, id: result.withdrawTx.transaction.id };
				}

				for (const published of result.publishedInputs) {
					state.publishedInputs.push(published);
				}

				actualInput = result.actualOutput;
				lastActualOutput = result.actualOutput;
				prevWithdrawTx = result.withdrawTx;

				executedSteps.push(result.executed);
				await persist();
				this.#emit('stepExecuted', result.executed, index);
			}
		} catch (err) {
			const error = AnchorChainingError.from(err);
			state.status = 'failed';
			state.error = { code: error.code, message: error.message };
			await persist();
			this.#setState({ status: 'failed', error, completedSteps: [ ...executedSteps ], failedAtStepIndex: index });
			this.#emit('failed', error, [ ...executedSteps ], index);
			throw(error);
		}

		const result: AnchorChainingPathExecuteResult = {
			steps: executedSteps,
			correlationID: state.correlationID,
			totalValueIn: this.#preview.totalValueIn,
			totalValueOut: lastActualOutput
		};

		state.status = 'completed';
		await persist();
		this.#setState({ status: 'completed', result });
		this.#emit('completed', result);
		return(result);
	}

	/**
	 * Enforce a leg's output floor before an irreversible send. With no floor
	 * (the default), drift is absorbed by re-pricing downstream. With a floor,
	 * an under-delivery is surfaced for review and aborts unless the consumer
	 * explicitly proceeds.
	 */
	async #checkFloor(index: number, expectedOutput: bigint, minOutput: bigint): Promise<void> {
		if (minOutput <= 0n || expectedOutput >= minOutput) {
			return;
		}

		let proceed = false;
		try {
			const [ decision ] = await this.#awaitStepCompletion<'underDeliveryReview'>({
				type: 'underDeliveryReview',
				action: { index, expectedOutput, actualOutput: expectedOutput, minimumOutput: minOutput }
			});
			proceed = decision.proceed;
		} catch (error) {
			throw(AnchorChainingError.from(error, 'UNDER_DELIVERY'));
		}

		if (!proceed) {
			throw(new AnchorChainingError('UNDER_DELIVERY', `Step ${index} would deliver ${expectedOutput}, below the minimum ${minOutput}; aborted before send`));
		}
	}
}
