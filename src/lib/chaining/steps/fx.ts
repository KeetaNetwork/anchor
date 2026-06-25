import type { ExecutedStep, FXGraphNode, FXQuoteOrEstimate, PreviewKnownValue, PreviewStep } from '../types.js';
import type { StepContext } from './context.js';
import type { StepRunInput, StepRunResult } from './run.js';
import type { PublishedInputRecord } from '../store.js';
import { applySlippage, resolveAccountsForAction } from './context.js';
import { AnchorChainingError } from '../errors.js';
import { pollExchangeStatus } from './poll.js';
import { toExternalInputs } from './external.js';

/**
 * An FX leg: a same-location Keeta token-to-token conversion through an FX
 * anchor. Previews via the anchor's quote/estimate surface without creating an
 * exchange.
 */
export class FXStep {
	readonly type = 'fx' as const;
	readonly index: number;
	readonly #ctx: StepContext;
	readonly #node: FXGraphNode;

	constructor(ctx: StepContext, index: number, node: FXGraphNode) {
		this.#ctx = ctx;
		this.index = index;
		this.#node = node;
	}

	/**
	 * Resolve a single quote/estimate for this leg at the given amount and
	 * affinity, validating it can actually be exchanged.
	 */
	async #quote(amount: bigint, affinity: 'from' | 'to'): Promise<FXQuoteOrEstimate> {
		const accountOptions = await resolveAccountsForAction(this.#ctx.client, {
			type: 'fx',
			providerMethod: 'getAccountForAction'
		}, this.#ctx.overrides);

		const quotesOrEstimates = await this.#ctx.fxClient.getQuotesOrEstimates(
			{ from: this.#node.from.asset, to: this.#node.to.asset, amount, affinity },
			accountOptions,
			{ providerIDs: [ this.#node.providerID ] }
		);

		const result = quotesOrEstimates?.[0];
		if (!result) {
			throw(new AnchorChainingError('QUOTE_UNAVAILABLE', `Could not get FX quote/estimate for provider ${this.#node.providerID}`));
		}

		if (!result.isQuote && result.estimate.canPerformExchange === false) {
			throw(new AnchorChainingError('QUOTE_UNAVAILABLE', `FX estimate from provider ${this.#node.providerID} indicates exchange cannot be performed`));
		}

		return(result);
	}

	async preview(known: PreviewKnownValue): Promise<PreviewStep> {
		const amount = known.value;
		const result = await this.#quote(amount, this.#ctx.affinity);
		const convertedAmount = result.isQuote ? result.quote.convertedAmount : result.estimate.convertedAmount;

		let estimatedValueIn: bigint;
		let estimatedValueOut: bigint;
		if (this.#ctx.affinity === 'to') {
			estimatedValueOut = amount;
			estimatedValueIn = convertedAmount;
		} else {
			estimatedValueIn = amount;
			estimatedValueOut = convertedAmount;
		}

		return({
			type: 'fx',
			index: this.index,
			providerID: this.#node.providerID,
			from: this.#node.from,
			to: this.#node.to,
			estimatedValueIn,
			estimatedValueOut,
			minOutput: applySlippage(estimatedValueOut, this.#ctx.slippageBps)
		});
	}

	async run(input: StepRunInput): Promise<StepRunResult> {
		/*
		 * Drive forward from the actual upstream output: re-quote at the real
		 * input so the exchange reflects what arrived, not a stale plan amount.
		 */
		const result = await this.#quote(input.actualInput, 'from');
		const expectedOutput = result.isQuote ? result.quote.convertedAmount : result.estimate.convertedAmount;

		await input.checkFloor(expectedOutput);

		input.record.intent = {
			idempotencyKey: input.idempotencyKey,
			kind: 'fx',
			createdAtMs: Date.now()
		};
		input.record.status = 'intent';
		await input.persist();

		const exchange = await result.createExchange(undefined, { inputs: toExternalInputs(input.publishedInputs) });
		input.record.exchangeID = exchange.exchange.exchangeID;
		await input.persist();

		const status = await pollExchangeStatus(exchange, input.poll);
		const published: PublishedInputRecord[] = [ { blockHash: status.blockhash } ];

		const executed: ExecutedStep = {
			type: 'fx',
			index: this.index,
			preview: input.preview,
			actualValueIn: input.actualInput,
			actualValueOut: expectedOutput,
			exchange
		};

		return({
			actualOutput: expectedOutput,
			executed,
			publishedInputs: published,
			withdrawTx: null
		});
	}
}
