import * as KeetaNet from '@keetanetwork/keetanet-client';

import type { ExecutedStep, KeetaSendStepLike, PreviewKnownValue, PreviewStep } from '../types.js';
import type { StepContext } from './context.js';
import type { StepRunInput, StepRunResult } from './run.js';
import type { PublishedInputRecord } from '../store.js';
import { AnchorChainingError } from '../errors.js';
import { applySlippage } from './context.js';

/**
 * A direct, on-Keeta token send. The only step in its path; input and output
 * are identical (no conversion, no rail fee).
 */
export class KeetaSendStep {
	readonly type = 'keetaSend' as const;
	readonly index: number;
	readonly #ctx: StepContext;
	readonly #node: KeetaSendStepLike;

	constructor(ctx: StepContext, index: number, node: KeetaSendStepLike) {
		this.#ctx = ctx;
		this.index = index;
		this.#node = node;
	}

	async preview(known: PreviewKnownValue): Promise<PreviewStep> {
		if (this.#ctx.path.length !== 1) {
			throw(new AnchorChainingError('INVALID_PATH', `Direct Keeta send steps must be the only step in the path`));
		}

		if (!KeetaNet.lib.Account.isInstance(this.#node.from.asset) || !KeetaNet.lib.Account.isInstance(this.#node.to.asset)) {
			throw(new AnchorChainingError('INVALID_PATH', `Expected assets to be token accounts for KEETA_SEND rail`));
		}

		if (!this.#node.from.asset.comparePublicKey(this.#node.to.asset)) {
			throw(new AnchorChainingError('INVALID_PATH', `For KEETA_SEND step, from and to asset must be the same account`));
		}

		const amount = known.value;

		return({
			type: 'keetaSend',
			index: this.index,
			providerID: null,
			from: this.#node.from,
			to: this.#node.to,
			estimatedValueIn: amount,
			estimatedValueOut: amount,
			minOutput: applySlippage(amount, this.#ctx.slippageBps)
		});
	}

	async run(input: StepRunInput): Promise<StepRunResult> {
		const token = KeetaNet.lib.Account.toAccount(this.#node.to.asset).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

		const recipient = this.#ctx.request.destination.recipient;
		let recipientAccount;
		if (KeetaNet.lib.Account.isInstance(recipient)) {
			recipientAccount = recipient;
		} else if (typeof recipient === 'string') {
			recipientAccount = KeetaNet.lib.Account.fromPublicKeyString(recipient);
		} else {
			throw(new AnchorChainingError('INVALID_REQUEST', `Expected destination recipient to be a public key string for KEETA_SEND step`));
		}

		await input.checkFloor(input.actualInput);

		input.record.status = 'intent';
		input.record.intent = {
			idempotencyKey: input.idempotencyKey,
			kind: 'keetaSend',
			send: {
				to: recipientAccount.publicKeyString.get(),
				value: input.actualInput.toString(),
				token: token.publicKeyString.get()
			},
			createdAtMs: Date.now()
		};

		await input.persist();

		/*
		 * Reconcile before performing: a persisted send hash means the send
		 * already published on a prior attempt, so do not re-send.
		 */
		let sentBlockHash = input.record.sendBlockHash;
		if (sentBlockHash === undefined) {
			sentBlockHash = await input.authorizedSend({
				to: recipientAccount,
				value: input.actualInput,
				token
			});

			if (sentBlockHash !== undefined) {
				input.record.sendBlockHash = sentBlockHash;
				await input.persist();
			}
		}

		const published: PublishedInputRecord[] = [];
		if (sentBlockHash !== undefined) {
			published.push({ blockHash: sentBlockHash, operationIndex: 0 });
		}

		const executed: ExecutedStep = {
			type: 'keetaSend',
			index: this.index,
			preview: input.preview,
			actualValueIn: input.actualInput,
			actualValueOut: input.actualInput,
			sendBlockHash: sentBlockHash
		};

		return({
			actualOutput: input.actualInput,
			executed,
			publishedInputs: published,
			withdrawTx: null
		});
	}
}
