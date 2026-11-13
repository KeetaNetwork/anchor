/**
 * The contract sequencer: an anchor service that orders calls to the
 * contracts it sequences. It does not run them: representatives do, and
 * vote on the outcome (see the node's `docs/CONTRACTS.md`).
 *
 * Callers submit blocks they signed, carrying `CONTRACT_CALL` operations.
 * The sequencer gathers the blocks that arrive within a short window into
 * one staple, adds a `CONTRACT_ORDER` block on the chain of every contract
 * the calls touch (listing that contract's calls in the order they run),
 * and asks the representatives to vote on it. A call its contract refuses
 * still lands, as a failed call that pays its fee and gas and changes
 * nothing. If the representatives refuse a batch outright (a block the
 * ledger would not take), each submission is retried alone, so one bad
 * block does not hold up the rest.
 *
 * The sequencer is trusted for ordering only: it can delay or refuse a
 * call, but it cannot change what the call does, and it holds no funds.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type { KeetaAnchorMetadataServerConfig } from '../../lib/anchor-metadata-server.js';
import { KeetaAnchorMetadataServer } from '../../lib/anchor-metadata-server.js';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import type { Routes } from '../../lib/http-server/index.ts';
import { assertAccountCertificateChain } from '../../lib/utils/certificate-network.js';
import type { KeetaContractsAnchorCallOutcome, KeetaContractsAnchorSubmitResult } from './common.js';
import { Errors, feeFor } from './common.js';
import { assertKeetaContractsAnchorSubmitRequestJSON } from './common.server.generated.js';
import { Buffer } from '../../lib/utils/buffer.js';
import type { BlockJSONOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';

type ContractsServiceMetadata = NonNullable<ServiceMetadata['services']['contracts']>[string];
type KeetaNetAccount = InstanceType<typeof KeetaNet.lib.Account>;
type KeetaNetBlock = InstanceType<typeof KeetaNet.lib.Block>;
type KeetaNetBlockHash = KeetaNetBlock['hash'];
type KeetaNetVoteStaple = Awaited<ReturnType<KeetaNet.Client['transmit']>>['voteStaple'];
type KeetaNetVote = KeetaNetVoteStaple['votes'][number];
type KeetaNetRepresentative = KeetaNet.Client['representatives'][number];

/** One representative's answer: its vote or quote, or its error. */
interface Answer<T> {
	representative: KeetaNetAccount;
	weight: bigint;
	result: T | null;
	error: unknown;
}

const OperationType = KeetaNet.lib.Block.OperationType;

/** How long to gather calls into one staple by default, in milliseconds. */
const DEFAULT_BATCH_WINDOW_MS = 25;

/** Most blocks submitted by callers in one staple, by default. */
const DEFAULT_MAX_BATCH_BLOCKS = 32;

/** Most blocks submitted by callers waiting to be ordered, by default. */
const DEFAULT_MAX_QUEUED_BLOCKS = 1_024;

/** Most calls one `CONTRACT_ORDER` operation lists. */
const MAX_CALLS_PER_ORDER = 64;

/** Most blocks one submission may carry. */
const MAX_SUBMITTED_BLOCKS = 8;

/** How long to wait for representatives that are behind to catch up, by default, in milliseconds. */
const DEFAULT_CATCH_UP_MS = 3_000;

/**
 * How long past its expiry a vote still counts, for clock skew between
 * nodes (the node's `Vote.allowedSlop`), in milliseconds.
 */
const VOTE_EXPIRY_SLOP_MS = 60_000;

/** How long a caller whose fork left a staple short of quorum is refused, in milliseconds. */
const FORK_REFUSAL_MS = 10 * 60_000;

/** How often to ask representatives that are behind again, in milliseconds. */
const RETRY_INTERVAL_MS = 100;

/**
 * Errors a representative gives when it has not yet applied a block the
 * staple builds on: asked again shortly, it may answer.
 */
const BEHIND = new Set(['LEDGER_NOT_SUCCESSOR', 'LEDGER_NOT_OPENING']);

function errorCode(error: unknown): string | undefined {
	return(typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined);
}

function errorMessage(error: unknown): string {
	return(error instanceof Error ? error.message : String(error));
}

/** Whether a representative that answered with `error` is behind, so may answer if asked again shortly. */
function isBehind(error: unknown): boolean {
	const code = errorCode(error);
	return(code !== undefined && BEHIND.has(code));
}

/** What a vote or quote says the calls did, as a key to compare by. */
function outcomeKey(result: { contractOutcomes?: ArrayBuffer | undefined; }): string {
	return(result.contractOutcomes === undefined ? '' : Buffer.from(result.contractOutcomes).toString('hex'));
}

/**
 * The results of the heaviest group of answers that agree on the calls'
 * outcome: votes with different outcomes cannot be stapled together.
 */
function agreeing<T extends { contractOutcomes?: ArrayBuffer | undefined; }>(answers: Answer<T>[]): T[] {
	const groups = new Map<string, { weight: bigint; results: T[]; }>();
	for (const answer of answers) {
		if (answer.result === null) {
			continue;
		}
		const key = outcomeKey(answer.result);
		const group = groups.get(key) ?? { weight: 0n, results: [] };
		group.weight += answer.weight;
		group.results.push(answer.result);
		groups.set(key, group);
	}
	let best: { weight: bigint; results: T[]; } = { weight: 0n, results: [] };
	for (const group of groups.values()) {
		if (group.weight > best.weight) {
			best = group;
		}
	}
	return(best.results);
}

/**
 * Why representatives would not answer: the heaviest refusal of the first
 * round that has one, preferring a ledger's reason to being behind or out
 * of reach.
 */
function refusalReason(...rounds: Answer<unknown>[][]): string {
	for (const answers of rounds) {
		const errors = answers.filter((answer) => answer.result === null).sort((a, b) => (a.weight < b.weight ? 1 : -1));
		const heaviest = errors.find((answer) => errorCode(answer.error) !== undefined && !isBehind(answer.error)) ?? errors[0];
		if (heaviest !== undefined) {
			return(errorMessage(heaviest.error));
		}
	}
	return('representatives disagree on the outcome');
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface KeetaAnchorContractsServerConfig extends KeetaAnchorMetadataServerConfig {
	/**
	 * The sequencer account, with its private key. Contracts that name it
	 * when they are deployed have their calls ordered by it.
	 */
	sequencer: KeetaNetAccount;
	/** Reads the ledger and publishes staples; pays the network's fees, if any, through its `generateFeeBlock`. */
	client: KeetaNet.UserClient;
	/** How long to gather calls into one staple, in milliseconds (25 by default). */
	batchWindowMs?: number;
	/** Most caller blocks in one staple (32 by default). */
	maxBatchBlocks?: number;
	/** Most caller blocks waiting to be ordered: submissions beyond that are refused (1024 by default). */
	maxQueuedBlocks?: number;
	/** How long to wait for representatives that are behind, in milliseconds (3000 by default). */
	catchUpMs?: number;
	/**
	 * What each call costs its caller, so that none is free: `perCall` for
	 * each `CONTRACT_CALL` in a block plus `perGas` for each unit of its gas
	 * limit, in atomic units of `token` (the network's base token by
	 * default). The block pays it with a SEND to the sequencer, and a block
	 * that pays less is refused. Calls are free without one.
	 */
	fee?: { token?: KeetaNetAccount; perCall: bigint; perGas: bigint; };
	routes?: Routes;
}

/** A contract call in a submitted block. */
interface Call {
	block: KeetaNetBlock;
	operationIndex: number;
	contract: string;
}

/** One submission waiting to be ordered. */
interface Submission {
	blocks: KeetaNetBlock[];
	calls: Call[];
	/** Every contract the calls touch: called, or owning state they list */
	contracts: Set<string>;
	resolve: (result: KeetaContractsAnchorSubmitResult) => void;
	reject: (error: unknown) => void;
}

function json(output: unknown): { output: string; contentType: string; } {
	return({
		output: JSON.stringify(output, function(_key, value: unknown) {
			return(typeof value === 'bigint' ? value.toString() : value);
		}),
		contentType: 'application/json'
	});
}

export class KeetaNetContractsAnchorHTTPServer extends KeetaAnchorMetadataServer<ContractsServiceMetadata, KeetaAnchorContractsServerConfig> {
	readonly sequencer: KeetaNetAccount;
	readonly routes: Routes;
	readonly #client: KeetaNet.UserClient;
	readonly #batchWindowMs: number;
	readonly #maxBatchBlocks: number;
	readonly #maxQueuedBlocks: number;
	readonly #catchUpMs: number;
	readonly #fee: { token: KeetaNetAccount; perCall: bigint; perGas: bigint; } | undefined;
	/**
	 * Contract chains held by temporary votes for a staple that did not
	 * reach quorum, until those votes expire: representatives holding them
	 * refuse any other block on the chain until then
	 */
	readonly #heldUntil = new Map<string, number>();
	/** Callers refused for a while, because a fork of theirs left a staple short of quorum */
	readonly #refusedUntil = new Map<string, number>();
	readonly #queue: Submission[] = [];
	#pumping: Promise<void> | null = null;
	/** Contracts known to name this sequencer (that never changes) */
	readonly #sequenced = new Set<string>();
	/** Each contract's head as last published by this sequencer, the only one signing its chain */
	readonly #heads = new Map<string, KeetaNetBlockHash | null>();

	constructor(config: KeetaAnchorContractsServerConfig) {
		super(config);

		if (!config.sequencer.hasPrivateKey) {
			throw(new Error('The sequencer account must hold its private key'));
		}

		this.sequencer = config.sequencer;
		this.routes = config.routes ?? {};
		this.#client = config.client;
		this.#batchWindowMs = config.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
		this.#maxBatchBlocks = config.maxBatchBlocks ?? DEFAULT_MAX_BATCH_BLOCKS;
		this.#maxQueuedBlocks = config.maxQueuedBlocks ?? DEFAULT_MAX_QUEUED_BLOCKS;
		this.#catchUpMs = config.catchUpMs ?? DEFAULT_CATCH_UP_MS;
		this.#fee = config.fee === undefined ? undefined : { ...config.fee, token: config.fee.token ?? config.client.baseToken };
	}

	get #sequencerAddress(): string {
		return(this.sequencer.publicKeyString.get());
	}

	#publishOptions(): Parameters<KeetaNet.Client['transmit']>[1] {
		const options: Parameters<KeetaNet.Client['transmit']>[1] = {};
		if (this.#client.config.generateFeeBlock !== undefined) {
			options.generateFeeBlock = this.#client.config.generateFeeBlock;
		}

		return(options);
	}

	/** Refuse a contract this sequencer does not order. */
	async #assertSequenced(contract: string): Promise<void> {
		if (this.#sequenced.has(contract)) {
			return;
		}

		const record = await this.#client.client.getContract(contract);
		if (record === null) {
			throw(new Errors.CallFailed({ kind: 'notSequenced' }, `${contract} is not a contract`));
		}
		if (record.sequencer.publicKeyString.get() !== this.#sequencerAddress) {
			throw(new Errors.CallFailed({ kind: 'notSequenced' }, `${contract} is ordered by another sequencer`));
		}

		this.#sequenced.add(contract);
	}

	/** Decode and check submitted blocks, and find their calls. */
	async #parse(encoded: string[]): Promise<Omit<Submission, 'resolve' | 'reject'>> {
		if (encoded.length === 0 || encoded.length > MAX_SUBMITTED_BLOCKS) {
			throw(new Errors.CallFailed({ kind: 'invalidBlock' }, `Submit 1 to ${MAX_SUBMITTED_BLOCKS} blocks`));
		}

		const chain = this.resolvedCertificateChainRequirement;
		const blocks: KeetaNetBlock[] = [];
		const calls: Call[] = [];
		const contracts = new Set<string>();
		for (const bytes of encoded) {
			let block: KeetaNetBlock;
			try {
				// Checks the block's signature
				block = new KeetaNet.lib.Block(Buffer.from(bytes, 'base64'));
			} catch (error) {
				throw(new Errors.CallFailed({ kind: 'invalidBlock' }, `Not a signed block: ${errorMessage(error)}`));
			}
			if (block.network !== this.#client.network) {
				throw(new Errors.CallFailed({ kind: 'invalidBlock' }, 'The block is for another network'));
			}
			// A block already on the ledger was spent: its chain has moved on, and so no representative would vote for it again.
			if (await this.#client.client.getBlock(block.hash) !== null) {
				throw(new Errors.CallFailed({ kind: 'invalidBlock' }, `Block ${block.hash.toString()} is already published`));
			}
			const caller = block.account.publicKeyString.get();
			if ((this.#refusedUntil.get(caller) ?? 0) > Date.now()) {
				throw(new Errors.CallFailed({ kind: 'refused' }, `${caller} forked its chain while a call of its was being voted on; try again later`));
			} else {
				this.#refusedUntil.delete(caller);
			}

			for (const [operationIndex, operation] of block.operations.entries()) {
				if (operation.type === OperationType.CONTRACT_ORDER) {
					throw(new Errors.CallFailed({ kind: 'invalidBlock' }, 'Only the sequencer orders calls'));
				}
				if (operation.type !== OperationType.CONTRACT_CALL) {
					continue;
				}

				const contract = operation.contract.publicKeyString.get();
				calls.push({ block, operationIndex, contract });
				contracts.add(contract);
				for (const account of operation.accounts) {
					contracts.add(account.owner.publicKeyString.get());
				}
			}

			this.#assertPaysFee(block);

			const signer = block.signer;
			for (const account of Array.isArray(signer) ? [block.account] : [block.account, signer]) {
				await assertAccountCertificateChain(account.assertAccount(), chain);
			}
			blocks.push(block);
		}

		if (calls.length === 0) {
			throw(new Errors.CallFailed({ kind: 'invalidBlock' }, 'The blocks call no contract'));
		}
		for (const contract of contracts) {
			await this.#assertSequenced(contract);
		}

		return({ blocks, calls, contracts });
	}

	/** Refuse a block that does not pay the fee for its calls. */
	#assertPaysFee(block: KeetaNetBlock): void {
		const fee = this.#fee;
		if (fee === undefined) {
			return;
		}
		const gasLimits = block.operations.flatMap((operation) => (operation.type === OperationType.CONTRACT_CALL ? [operation.gasLimit] : []));
		const owed = feeFor(fee, gasLimits);
		const paid = block.operations.reduce((total, operation) => {
			if (operation.type !== OperationType.SEND || !operation.to.comparePublicKey(this.sequencer) || !operation.token.comparePublicKey(fee.token)) {
				return(total);
			}
			return(total + operation.amount);
		}, 0n);
		if (paid < owed) {
			throw(new Errors.CallFailed({ kind: 'fee' }, `The block pays ${paid} of the ${owed} its calls cost (${fee.perCall} per call and ${fee.perGas} per unit of gas limit, in ${fee.token.publicKeyString.get()}, sent to ${this.#sequencerAddress})`));
		}
	}

	/** Queue a submission and wait for its staple. */
	async #submit(parsed: Omit<Submission, 'resolve' | 'reject'>): Promise<KeetaContractsAnchorSubmitResult> {
		const queued = this.#queue.reduce((total, submission) => total + submission.blocks.length, 0);
		if (queued + parsed.blocks.length > this.#maxQueuedBlocks) {
			throw(new Errors.CallFailed({ kind: 'refused' }, 'The sequencer has too many calls waiting; try again later'));
		}
		const result = new Promise<KeetaContractsAnchorSubmitResult>((resolve, reject) => {
			this.#queue.push({ ...parsed, resolve, reject });
		});
		this.#startPump();

		return(await result);
	}

	/** Start publishing the queue, unless that is under way. */
	#startPump(): void {
		if (this.#pumping !== null) {
			return;
		}
		this.#pumping = this.#pump().finally(() => {
			this.#pumping = null;
			// A submission queued after the pump last looked, but before it stopped, would otherwise wait for the next one.
			if (this.#queue.length > 0) {
				this.#startPump();
			}
		});
	}

	/** Publish queued submissions, a batch at a time, until none are left. */
	async #pump(): Promise<void> {
		while (this.#queue.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.#batchWindowMs));

			const batch: Submission[] = [];
			let size = 0;
			while (this.#queue.length > 0) {
				const next = this.#queue[0];
				if (next === undefined || (batch.length > 0 && size + next.blocks.length > this.#maxBatchBlocks)) {
					break;
				}
				batch.push(next);
				size += next.blocks.length;
				this.#queue.shift();
			}

			try {
				await this.#publish(batch);
			} catch (error) {
				if (batch.length === 1) {
					batch[0]?.reject(error);
					continue;
				}

				// One refused call should not hold up the rest: try each alone.
				for (const submission of batch) {
					try {
						await this.#publish([submission]);
					} catch (alone) {
						submission.reject(alone);
					}
				}
			}
		}
	}

	/** The head of a contract's chain, recovering any staple left half-voted. */
	async #head(contract: string): Promise<KeetaNetBlockHash | null> {
		const known = this.#heads.get(contract);
		if (known !== undefined) {
			return(known);
		}

		/*
		 * A block we got votes for but never published (we stopped
		 * between voting and publishing) holds the chain: publish it if
		 * its votes still make a quorum. If they do not, they expire.
		 */
		const account = KeetaNet.lib.Account.fromPublicKeyString(contract);
		try {
			if (await this.#client.client.getPendingBlock(account) !== null) {
				await this.#client.client.recoverAccount(account, true, this.#publishOptions());
			}
		} catch (error) {
			this.logger?.debug('ContractsAnchor', 'Could not recover a pending block on', contract, error);
		}
		const head = (await this.#client.client.getHeadBlock(contract))?.hash ?? null;
		this.#heads.set(contract, head);
		return(head);
	}

	/** Order one batch of submissions, publish it, and settle each submission. */
	async #publish(batch: Submission[]): Promise<void> {
		const calls = new Map<string, Call[]>();
		for (const submission of batch) {
			for (const contract of submission.contracts) {
				calls.set(contract, calls.get(contract) ?? []);
			}
			for (const call of submission.calls) {
				calls.get(call.contract)?.push(call);
			}
		}

		await this.#waitForChains([...calls.keys()]);

		const orders: KeetaNetBlock[] = [];
		for (const [contract, ordered] of calls) {
			const references = ordered.map((call) => ({ block: call.block.hash, operationIndex: call.operationIndex }));
			const operations: BlockJSONOperations[] = [];
			for (let start = 0; start === 0 || start < references.length; start += MAX_CALLS_PER_ORDER) {
				operations.push({ type: OperationType.CONTRACT_ORDER, calls: references.slice(start, start + MAX_CALLS_PER_ORDER) });
			}
			const previous = await this.#head(contract);
			orders.push(await new KeetaNet.lib.Block.Builder({
				account: KeetaNet.lib.Account.fromPublicKeyString(contract),
				signer: this.sequencer.assertAccount(),
				previous: previous ?? KeetaNet.lib.Block.NO_PREVIOUS,
				network: this.#client.network,
				operations
			}).seal());
		}

		const blocks = [...batch.flatMap((submission) => submission.blocks), ...orders];
		let voteStaple: KeetaNetVoteStaple;
		try {
			voteStaple = await this.#vote(blocks, orders);
		} catch (error) {
			// The staple may have landed even though the reply was lost.
			const [first] = orders;
			const landed = first === undefined ? null : await this.#client.client.getVoteStaple(first.hash).catch(() => null);
			if (landed === null) {
				for (const contract of calls.keys()) {
					this.#heads.delete(contract);
				}
				throw(Errors.CallFailed.isInstance(error) ? error : new Errors.CallFailed({ kind: 'refused' }, errorMessage(error)));
			}
			voteStaple = landed;
		}

		for (const order of orders) {
			this.#heads.set(order.account.publicKeyString.get(), order.hash);
		}
		this.#settle(batch, voteStaple);
	}

	/** Wait until no temporary votes from a failed staple hold any of these contract chains. */
	async #waitForChains(contracts: string[]): Promise<void> {
		const until = Math.max(0, ...contracts.map((contract) => this.#heldUntil.get(contract) ?? 0));
		if (until > Date.now()) {
			this.logger?.debug('ContractsAnchor', `Waiting ${until - Date.now()}ms for temporary votes holding a contract chain to expire`);
			await sleep(until - Date.now());
		}
		for (const contract of contracts) {
			if ((this.#heldUntil.get(contract) ?? 0) <= Date.now()) {
				this.#heldUntil.delete(contract);
			}
		}
	}

	/**
	 * Ask every representative with `ask`, then ask again those that are
	 * behind, until they answer or `catchUpMs` passes. `ask` gets the
	 * representatives to ask (all of them, at first). Answers given are
	 * kept, since a representative that has voted would refuse to vote
	 * again. Whether the answers are enough is for the representatives to
	 * judge: one gives a permanent vote only for temporary votes that hold a
	 * quorum, and accepts a staple only with permanent votes that hold one.
	 */
	async #askAll<T>(ask: (reps: KeetaNetRepresentative[] | undefined) => Promise<Answer<T>[]>): Promise<Answer<T>[]> {
		const client = this.#client.client;
		const deadline = Date.now() + this.#catchUpMs;
		const answers = new Map<string, Answer<T>>();
		let pending: KeetaNetRepresentative[] | undefined;

		for (;;) {
			for (const answer of await ask(pending)) {
				answers.set(answer.representative.publicKeyString.get(), answer);
			}
			const behind = new Set([...answers.values()].filter((answer) => answer.result === null && isBehind(answer.error)).map((answer) => answer.representative.publicKeyString.get()));
			if (behind.size === 0 || Date.now() >= deadline) {
				return([...answers.values()]);
			}
			pending = client.representatives.filter((rep) => behind.has(rep.key.publicKeyString.get()));
			await sleep(RETRY_INTERVAL_MS);
		}
	}

	/**
	 * A dry run of the votes: one representative's quote, which on contract
	 * calls carries their outcome. Calls run the same on every
	 * representative that is up to date, so one is enough; a call it
	 * refuses never gets a vote. The heaviest representative that answers
	 * is used, waiting for one that is behind and skipping one out of reach.
	 */
	async #dryRun(blocks: KeetaNetBlock[]): Promise<void> {
		const client = this.#client.client;
		const reps = [...client.representatives].sort((a, b) => ((a.weight ?? 0n) < (b.weight ?? 0n) ? 1 : -1));
		const unanswered: Answer<unknown>[] = [];
		for (const rep of reps) {
			const answers = await this.#askAll((pending) => client.quoteEach(blocks, pending ?? [rep]));
			if (answers.some((answer) => answer.result !== null)) {
				return;
			}
			const refusal = answers.find((answer) => errorCode(answer.error) !== undefined && !isBehind(answer.error));
			if (refusal !== undefined) {
				throw(new Errors.CallFailed({ kind: 'refused' }, `Representatives refused the quote: ${errorMessage(refusal.error)}`));
			}
			unanswered.push(...answers);
		}
		throw(new Errors.CallFailed({ kind: 'refused' }, `No representative quoted the staple: ${unanswered.length === 0 ? 'there are none' : refusalReason(unanswered)}`));
	}

	/**
	 * Get the staple voted on and published, without leaving a contract
	 * chain held by votes when that can be avoided:
	 *
	 * 1. A dry run ({@link #dryRun}): it holds nothing, so a refused call
	 *    never gets a vote at all.
	 * 2. Temporary votes on exactly these blocks from every representative,
	 *    asking again those that are behind. A competing ordering is never
	 *    built while any of them is live.
	 * 3. The fee block, if the votes ask for fees; permanent votes.
	 * 4. Publish to every representative, so that none falls behind.
	 *
	 * If the temporary votes fall short of a quorum (a caller forked its
	 * chain after the dry run), representatives refuse the permanent votes,
	 * and the temporary ones hold the contract chains until they expire;
	 * later calls to those contracts wait for that.
	 */
	async #vote(blocks: KeetaNetBlock[], orders: KeetaNetBlock[]): Promise<KeetaNetVoteStaple> {
		const client = this.#client.client;
		const staple = blocks.map((block) => block.hash.toString().slice(0, 12)).join(',');
		this.logger?.debug('ContractsAnchor', `dry run of ${staple}`);
		await this.#dryRun(blocks);
		this.logger?.debug('ContractsAnchor', `temporary votes for ${staple}`);

		const temporaryAnswers = await this.#askAll((reps) => client.voteEach(blocks, undefined, reps));
		let permanent: KeetaNetVote[];
		try {
			const temporary = agreeing(temporaryAnswers);
			if (temporary.length === 0) {
				throw(new Errors.CallFailed({ kind: 'refused' }, `Representatives refused the vote: ${refusalReason(temporaryAnswers)}`));
			}

			const generateFeeBlock = this.#client.config.generateFeeBlock;
			if (client.votesRequireFees(temporary)) {
				if (generateFeeBlock === undefined) {
					throw(new Error('The votes ask for fees, and the sequencer cannot pay them'));
				}
				blocks.push(await generateFeeBlock(KeetaNet.lib.Vote.Staple.fromVotesAndBlocks(temporary, blocks)));
			}
			this.logger?.debug('ContractsAnchor', `permanent votes for ${staple}`);
			const permanentAnswers = await this.#askAll((reps) => client.voteEach(blocks, temporary, reps));
			permanent = agreeing(permanentAnswers);
			if (permanent.length === 0) {
				// A refused temporary vote says why better than the permanent refusals it caused.
				throw(new Errors.CallFailed({ kind: 'refused' }, `Representatives refused the vote: ${refusalReason(temporaryAnswers, permanentAnswers)}`));
			}
		} catch (error) {
			const expiries = temporaryAnswers.flatMap((answer) => (answer.result === null ? [] : [answer.result.validityTo.valueOf()]));
			if (expiries.length > 0) {
				// The votes given hold these chains until they expire, slop included.
				const until = Math.max(...expiries) + VOTE_EXPIRY_SLOP_MS + 1_000;
				for (const order of orders) {
					this.#heldUntil.set(order.account.publicKeyString.get(), until);
				}
				this.#refuseForkers(blocks, orders, temporaryAnswers.filter((answer) => answer.result === null));
			}
			throw(error);
		}
		this.logger?.debug('ContractsAnchor', `publishing ${staple}`);

		const voteStaple = KeetaNet.lib.Vote.Staple.fromVotesAndBlocks(permanent, blocks);
		const { publish } = await client.transmitStaple(voteStaple, client.representatives);
		if (!publish) {
			throw(new Error('The network did not accept the staple'));
		}
		this.logger?.debug('ContractsAnchor', `published ${staple}`);

		return(voteStaple);
	}

	/**
	 * Refuse, for a while, callers whose blocks representatives would not
	 * vote for because they had voted for another block on the caller's
	 * chain: the caller forked it after the quotes.
	 */
	#refuseForkers(blocks: KeetaNetBlock[], orders: KeetaNetBlock[], refusals: Answer<KeetaNetVote>[]): void {
		const ours = new Set(orders.map((order) => order.hash.toString().toUpperCase()));
		for (const refusal of refusals) {
			if (errorCode(refusal.error) !== 'LEDGER_SUCCESSOR_VOTE_EXISTS') {
				continue;
			}
			const hash = /hash=([0-9A-Fa-f]{64})/u.exec(errorMessage(refusal.error))?.[1]?.toUpperCase();
			const forked = hash === undefined || ours.has(hash) ? undefined : blocks.find((block) => block.hash.toString().toUpperCase() === hash);
			if (forked !== undefined) {
				this.#refusedUntil.set(forked.account.publicKeyString.get(), Date.now() + FORK_REFUSAL_MS);
			}
		}
	}

	/** Give each submission the outcome of its calls, from the staple's votes. */
	#settle(batch: Submission[], voteStaple: KeetaNetVoteStaple): void {
		const der = voteStaple.votes[0]?.contractOutcomes;
		const outcomes = der === undefined ? [] : KeetaNet.lib.Contract.Outcomes.fromDER(der).calls;
		const blockHashes = voteStaple.blocks.map((block) => block.hash.toString().toLowerCase());

		for (const submission of batch) {
			const contracts = new Map(submission.calls.map((call) => [`${call.block.hash.toString().toLowerCase()}/${call.operationIndex}`, call.contract]));
			const results: KeetaContractsAnchorCallOutcome[] = [];
			for (const outcome of outcomes) {
				const block = outcome.block.toString().toLowerCase();
				const contract = contracts.get(`${block}/${outcome.operationIndex}`);
				if (contract === undefined) {
					continue;
				}
				results.push({
					block,
					operationIndex: outcome.operationIndex,
					contract,
					gasUsed: outcome.gasUsed.toString(),
					returnData: outcome.returnData.toString('base64'),
					writes: outcome.writes.map((write) => ({ owner: write.owner.publicKeyString.get(), id: write.id.toString('hex'), version: write.version.toString() })),
					...(outcome.failure === undefined ? {} : { failure: { kind: outcome.failure.kind, message: outcome.failure.message }})
				});
			}
			submission.resolve({ blocks: blockHashes, calls: results });
		}
	}

	protected async initRoutes(config: KeetaAnchorContractsServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {
			...(await super.initRoutes(config)),
			...this.routes
		};

		routes['POST /api/submit'] = async (_params, body) => {
			const raw = assertKeetaContractsAnchorSubmitRequestJSON(body);
			const result = await this.#submit(await this.#parse(raw.blocks));
			return(json({ ok: true, ...result }));
		};

		return(routes);
	}

	protected async buildServiceMetadata(): Promise<ContractsServiceMetadata> {
		const acceptedIssuerDNs = this.acceptedIssuerDNs();

		const fee = this.#fee;
		return({
			sequencer: this.#sequencerAddress,
			...(fee !== undefined ? { fee: { token: fee.token.publicKeyString.get(), perCall: fee.perCall.toString(), perGas: fee.perGas.toString() }} : {}),
			operations: {
				submit: (new URL('/api/submit', this.url)).toString()
			},
			...(acceptedIssuerDNs !== undefined && { acceptedIssuerDNs })
		});
	}
}
