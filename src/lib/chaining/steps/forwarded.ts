import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { AssetMovementGraphNode, AssetMovementProvider, ExecutedStep, PreviewKnownValue, PreviewStep } from '../types.js';
import type { KeetaAssetMovementTransaction } from '../../../services/asset-movement/common.js';
import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { StepContext } from './context.js';
import type { PollSettings, StepRunInput, StepRunResult, WithdrawRef } from './run.js';
import { applySlippage, resolveAccountsForAction } from './context.js';
import { AnchorChainingError } from '../errors.js';
import { estimateMovementValueOut, resolveMovementProvider } from './asset-movement.js';

const MAX_FORWARDED_BACKOFF_MS = 8_000;

/**
 * Poll a provider for the forwarded transaction it creates after sweeping the
 * persistent-forwarding address, correlated to the prior leg's withdraw.
 */
async function pollForwardedTransaction(
	provider: AssetMovementProvider,
	account: InstanceType<typeof KeetaNetLib.Account>,
	sourceLocation: AssetMovementGraphNode['from']['location'],
	persistentAddress: string,
	sourceWithdraw: WithdrawRef,
	poll: PollSettings,
	logger: StepContext['logger']
): Promise<KeetaAssetMovementTransaction> {
	const deadline = Date.now() + poll.timeoutMs;

	for (let attempt = 0; ; attempt++) {
		if (poll.abortSignal?.aborted) {
			throw(new AnchorChainingError('ABORTED', `Aborted while waiting for forwarded transaction at ${persistentAddress}`));
		}

		let transactions: KeetaAssetMovementTransaction[] = [];
		try {
			const response = await provider.listTransactions({
				account,
				persistentAddresses: [ { location: sourceLocation, persistentAddress } ],
				transactions: [ sourceWithdraw ]
			});

			transactions = response.transactions;
		} catch (error) {
			logger?.debug('ForwardedStep::poll', `listTransactions failed for persistent-forwarding address ${persistentAddress}`, error);
		}

		const candidate = transactions.find(tx => tx.status === 'COMPLETE');
		if (candidate) {
			return(candidate);
		}

		if (Date.now() >= deadline) {
			throw(new AnchorChainingError('POLL_TIMEOUT', `Timed out waiting for persistent-forwarding transaction at ${persistentAddress}`));
		}

		const delay = Math.min(MAX_FORWARDED_BACKOFF_MS, Math.round(poll.intervalMs * (1.5 ** attempt)));
		await KeetaNet.lib.Utils.Helper.asleep(delay);
	}
}

/**
 * An asset-movement leg whose prior step deposits into a persistent-forwarding
 * address the provider then sweeps. Previews like a managed transfer but
 * creates no forwarding address (deferred to execution).
 */
export class ForwardedStep {
	readonly type = 'forwarded' as const;
	readonly index: number;
	readonly #ctx: StepContext;
	readonly #node: AssetMovementGraphNode;

	constructor(ctx: StepContext, index: number, node: AssetMovementGraphNode) {
		this.#ctx = ctx;
		this.index = index;
		this.#node = node;
	}

	async preview(known: PreviewKnownValue): Promise<PreviewStep> {
		if (this.#ctx.affinity === 'to') {
			throw(new AnchorChainingError('UNSUPPORTED_AFFINITY', `Chaining with affinity 'to' is not supported for forwarded steps`));
		}

		const amount = known.value;
		const provider = await resolveMovementProvider(this.#ctx, this.#node);

		if (!await provider.isOperationSupported('createPersistentForwarding')) {
			throw(new AnchorChainingError('INVALID_PATH', `Asset movement provider ${this.#node.providerID} does not support createPersistentForwarding required by this leg`));
		}

		const estimatedValueOut = await estimateMovementValueOut(this.#ctx, this.#node, provider, amount);

		return({
			type: 'forwarded',
			index: this.index,
			providerID: this.#node.providerID,
			from: this.#node.from,
			to: this.#node.to,
			estimatedValueIn: amount,
			estimatedValueOut,
			minOutput: applySlippage(estimatedValueOut, this.#ctx.slippageBps)
		});
	}

	async run(input: StepRunInput): Promise<StepRunResult> {
		if (!input.prevWithdrawTx) {
			throw(new AnchorChainingError('INVALID_STATE', `Forwarded step at index ${this.index} requires the prior step to produce a withdraw transaction`));
		}

		const provider = await resolveMovementProvider(this.#ctx, this.#node);
		const persistentAddress = await input.ensureForwardedAddress();
		const pfiAddress = persistentAddress.address;
		if (typeof pfiAddress !== 'string') {
			throw(new AnchorChainingError('INVALID_STATE', `Persistent forwarding address must be a resolved string`));
		}

		const { account } = await resolveAccountsForAction(this.#ctx.client, {
			type: 'assetMovement',
			providerMethod: 'initiateTransfer',
			provider
		}, this.#ctx.overrides);

		input.record.intent = {
			idempotencyKey: input.idempotencyKey,
			kind: 'forwarded',
			createdAtMs: Date.now()
		};
		input.record.status = 'intent';
		await input.persist();

		const observed = await pollForwardedTransaction(
			provider,
			account,
			this.#node.from.location,
			pfiAddress,
			input.prevWithdrawTx,
			input.poll,
			this.#ctx.logger
		);

		const actualOutput = BigInt(observed.to.value);

		await input.checkFloor(actualOutput);

		const executed: ExecutedStep = {
			type: 'forwarded',
			index: this.index,
			preview: input.preview,
			actualValueIn: input.actualInput,
			actualValueOut: actualOutput,
			observedTransaction: observed
		};

		return({
			actualOutput,
			executed,
			publishedInputs: [],
			withdrawTx: null
		});
	}
}
