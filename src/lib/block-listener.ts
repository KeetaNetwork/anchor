import type { Client } from "@keetanetwork/keetanet-client";
import type { Logger } from "./log/index.js";
import type { Block, BlockHash } from "@keetanetwork/keetanet-client/lib/block/index.js";
import type { BlockOperations } from "@keetanetwork/keetanet-client/lib/block/operations.js";
import type { VoteBlockHash } from "@keetanetwork/keetanet-client/lib/vote.js";
import { KeetaAnchorQueueRunner } from "./queue/index.js";
import type { KeetaAnchorQueueEntryExtra, KeetaAnchorQueueRequestID } from "./queue/index.js";
import type { JSONSerializable } from "./utils/json.js";
import { KeetaNet } from "../client/index.js";
import { ConvertStringToRequestID } from "./queue/internal.js";
import type { KeetaAnchorQueueRunOptions } from "./queue/common.js";

interface BlockListenerConfig {
	client: Client;

	logger?: Logger;
}

interface BlockListenerContext {
	block: Block;
}

interface NetworkListenerArguments {
	'block': {
		callback: (data: BlockListenerContext) => (Promise<{ requiresWork?: boolean; }> | { requiresWork?: boolean; });
	}
}

interface BlockListenerScanOptions {
	searchTo?: { extended: true; } | number | undefined;
}

export class BlockListener {
	#config: BlockListenerConfig;

	#blockListeners: (NetworkListenerArguments['block'] & { id: string; })[] = [];

	constructor(config: BlockListenerConfig) {
		this.#config = config;
	}

	get #client(): Client {
		return(this.#config.client);
	}

	get logger(): Logger | undefined {
		return(this.#config.logger);
	}

	async #runWithLog(label: string, func: () => Promise<void>) {
		try {
			await func();
		} catch (error) {
			this.logger?.error(`BlockListener::${label}`, `Received Error running`, error);
		}
	}

	async #processBlockListeners(block: Block) {
		let listenersHaveWork = false;

		const promises = [];
		for (const listener of this.#blockListeners) {
			promises.push(this.#runWithLog('block callback', async function() {
				const response = await listener.callback({ block });
				if (response.requiresWork) {
					listenersHaveWork = true;
				}
			}));
		}

		await Promise.allSettled(promises);

		return({ listenersHaveWork });
	}

	async scan(options?: BlockListenerScanOptions): Promise<{ listenersHaveWork: boolean; }> {
		let listenersHaveWork = false;

		try {
			let reachedEndOfTime = false;
			let startBlocksHash: VoteBlockHash | undefined;
			let pageCount = 0;

			/*
			 * Either perform an extended
			 * scan (30 days) or a short
			 * scan (4 hours) to find
			 * relevant operations
			 */
			const now = Date.now();

			let oldestVoteStapleToCheck = now - (4 * 60 * 60 * 1000); // 4 hours ago

			if (options?.searchTo) {
				if (typeof options.searchTo === 'number') {
					if (options.searchTo >= now || options.searchTo <= 0) {
						throw(new Error('BlockListener::scan: When providing searchTo as a number, it must be a timestamp in the past'));
					}

					oldestVoteStapleToCheck = options.searchTo;
				} else if ('extended' in options.searchTo) {
					oldestVoteStapleToCheck = now - (30 * 24 * 60 * 60 * 1000); // 30 days ago
				} else {
					throw(new Error('BlockListener::scan: Invalid searchTo option provided'));
				}
			}

			while (!reachedEndOfTime) {
				pageCount++;

				const historyOptions = { depth: 20, ...(startBlocksHash ? { startBlocksHash } : {}) };

				this.logger?.debug('BlockListener::poll', `Fetching history page ${pageCount}`, { ...historyOptions });

				const history = await this.#client.getHistory(null, historyOptions);

				if (history.length === 0) {
					this.logger?.debug('BlockListener::poll', `No more history found, ending discovery`);
					break;
				}

				const processBlocksPromises = [];
				for (const { voteStaple } of history) {
					if (voteStaple.timestamp().valueOf() < oldestVoteStapleToCheck) {
						this.logger?.debug('BlockListener::poll', 'Reached vote staple older than scanning time, ending discovery for this run', { voteStapleTime: voteStaple.timestamp(), oldestVoteStapleToCheck: new Date(oldestVoteStapleToCheck) });
						reachedEndOfTime = true;
						break;
					}

					for (const block of voteStaple.blocks) {
						processBlocksPromises.push(this.#processBlockListeners(block));
					}
				}

				const processBlockPromiseResults = await Promise.all(processBlocksPromises);

				if (processBlockPromiseResults.some(result => result.listenersHaveWork)) {
					listenersHaveWork = true;
				}

				// Set up for next page
				const lastVoteStaple = history[history.length - 1]?.voteStaple;
				if (lastVoteStaple) {
					startBlocksHash = lastVoteStaple.blocksHash;
				} else {
					break;
				}
			}
		} catch (error) {
			this.logger?.error('BlockListener::poll', 'Error during discovery:', error);
		}

		return({ listenersHaveWork });
	}

	on<K extends keyof NetworkListenerArguments>(_ignore_type: K, args: NetworkListenerArguments[K]): { remove: () => void; } {
		const id = String(Math.random());

		this.#blockListeners.push({ ...args, id });

		return({
			remove: () => {
				const index = this.#blockListeners.findIndex(listener => listener.id === id);
				if (index !== -1) {
					this.#blockListeners.splice(index, 1);
				}
			}
		})
	}
}

type BlockQueueRunnerRequest = { blockHash: BlockHash; };
type BlockQueueRunnerRequestSerialized = { blockHash: string; };

interface BaseBlockOperationQueueRunnerScanOptionsRequired {
	scanWhenRunning: true;
	extendedScanIntervalMs: number;
	regularScanIntervalMs: number;
}

type BlockOperationQueueRunnerConfig<Request, Result, RequestSerialized extends JSONSerializable, ResultSerialized extends JSONSerializable | null> =
	ConstructorParameters<typeof KeetaAnchorQueueRunner<Request, Result, RequestSerialized, ResultSerialized>>[0] &
	{
		listener: BlockListener | BlockListenerConfig;

		scanOptions?: Partial<BaseBlockOperationQueueRunnerScanOptionsRequired> | {
			scanWhenRunning: false;
		}
	};

abstract class BaseBlockOperationQueueRunner<
	Request,
	Result = null,
	RequestSerialized extends JSONSerializable = JSONSerializable,
	ResultSerialized extends JSONSerializable = null
> extends KeetaAnchorQueueRunner<Request, Result, RequestSerialized, ResultSerialized> {
	#listener: BlockListener;

	#lastExtendedScanTime: number | null = null;
	#lastScanTime: number | null = null;

	#scanOptions: BaseBlockOperationQueueRunnerScanOptionsRequired | { scanWhenRunning: false; };

	#removeListenerCallback: (() => void);

	constructor(config: BlockOperationQueueRunnerConfig<Request, Result, RequestSerialized, ResultSerialized>) {
		const { listener, ...restConfig } = config;

		super(restConfig);

		if (listener instanceof BlockListener) {
			this.#listener = listener;
		} else {
			this.#listener = new BlockListener(listener);
		}

		const addedListener = this.#listener.on('block', {
			callback: async ({ block }) => {
				return({ requiresWork: await this.onBlockSeen(block) });
			}
		});

		this.#removeListenerCallback = addedListener.remove;

		if (!config.scanOptions || config.scanOptions?.scanWhenRunning || config.scanOptions?.scanWhenRunning === undefined) {
			this.#scanOptions = {
				scanWhenRunning: true,
				extendedScanIntervalMs: 60 * 60 * 1000, // 1 hour
				regularScanIntervalMs: 5 * 60 * 1000, // 5 minutes
				...config.scanOptions
			};
		} else {
			this.#scanOptions = { scanWhenRunning: false };
		}

	}

	protected abstract onBlockSeen(block: Block): Promise<boolean>;

	protected decodeResponse(response: ResultSerialized): Result | null {
		if (response === null) {
			return(null);
		} else {
			throw(new Error('BlockQueueRunner::decodeResponse: Not implemented when response is not null, you must override this method in your subclass'));
		}
	}

	protected encodeResponse(response: Result): ResultSerialized {
		if (response === null) {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			return(null as ResultSerialized);
		} else {
			throw(new Error('BlockQueueRunner::encodeResponse: Not implemented when response is not null, you must override this method in your subclass'));
		}
	}

	override async run(options?: KeetaAnchorQueueRunOptions): Promise<boolean> {
		let scanYieldedWork = false;
		if (this.#scanOptions.scanWhenRunning) {
			const now = Date.now();

			let extendedScanDue = false;
			let dueForScan = false;
			if (!this.#lastScanTime || (now - this.#lastScanTime > this.#scanOptions.regularScanIntervalMs)) {
				dueForScan = true;
			}

			if (!this.#lastExtendedScanTime || (now - this.#lastExtendedScanTime > this.#scanOptions.extendedScanIntervalMs)) {
				extendedScanDue = true;
			}


			if (extendedScanDue || dueForScan) {
				let searchTo: BlockListenerScanOptions['searchTo'];
				if (extendedScanDue) {
					searchTo = { extended: true };
				} else if (this.#lastScanTime) {
					searchTo = this.#lastScanTime;
				}

				const scanResult = await this.#listener.scan({ searchTo });

				this.#lastScanTime = now;
				if (extendedScanDue) {
					this.#lastExtendedScanTime = now;
				}

				scanYieldedWork = scanResult.listenersHaveWork;
			}
		}

		const moreRunWork = await super.run(options);

		return(moreRunWork || scanYieldedWork);
	}

	[Symbol.dispose](): void {
		this.#removeListenerCallback();
	}
}

export abstract class BlockQueueRunner<UserResult = null, QueueResult extends JSONSerializable = null> extends BaseBlockOperationQueueRunner<BlockQueueRunnerRequest, UserResult, BlockQueueRunnerRequestSerialized, QueueResult> {
	protected abstract filterBlock(block: Block): (boolean | Promise<boolean>);

	protected decodeRequest(request: BlockQueueRunnerRequestSerialized): BlockQueueRunnerRequest {
		return({ blockHash: new KeetaNet.lib.Block.Hash(request.blockHash) });
	}

	protected encodeRequest(request: BlockQueueRunnerRequest): BlockQueueRunnerRequestSerialized {
		return({ blockHash: request.blockHash.toString() });
	}

	protected async onBlockSeen(block: Block): Promise<boolean> {
		const shouldInclude = await this.filterBlock(block);
		if (shouldInclude) {
			await this.add({ blockHash: block.hash });
		}
		return(shouldInclude);
	}

	override add(request: BlockQueueRunnerRequest, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		const requestIdString = ConvertStringToRequestID(request.blockHash.toString().toLowerCase())

		if (info?.id && String(info.id) !== String(requestIdString)) {
			throw(new Error(`OperationQueueRunner::add: When providing an "id" in info, it must match the blockHash of the request. Expected ${String(requestIdString)}, got ${String(info.id)}`));
		}

		return(super.add(request, { ...info, id: requestIdString }));
	}
}

type OperationQueueRunnerRequest = { blockHash: BlockHash; operationIndex: number; };
type OperationQueueRunnerRequestSerialized = { blockHash: string; operationIndex: number; };

export abstract class OperationQueueRunner<UserResult = null, QueueResult extends JSONSerializable = null> extends BaseBlockOperationQueueRunner<OperationQueueRunnerRequest, UserResult, OperationQueueRunnerRequestSerialized, QueueResult> {
	protected abstract filterOperation(operation: BlockOperations, context: { block: Block; operationIndex: number; }): (boolean | Promise<boolean>);

	protected decodeRequest(request: OperationQueueRunnerRequestSerialized): OperationQueueRunnerRequest {
		return({ blockHash: new KeetaNet.lib.Block.Hash(request.blockHash), operationIndex: request.operationIndex });
	}

	protected encodeRequest(request: OperationQueueRunnerRequest): OperationQueueRunnerRequestSerialized {
		return({ blockHash: request.blockHash.toString(), operationIndex: Number(request.operationIndex) });
	}

	protected async onBlockSeen(block: Block): Promise<boolean> {
		const addPromises = [];

		let anyShouldInclude = false;
		for (let operationIndex = 0; operationIndex < block.operations.length; operationIndex++) {
			const operation = block.operations[operationIndex];

			if (!operation) {
				continue;
			}

			addPromises.push((async () => {
				const shouldInclude = await this.filterOperation(operation, { block, operationIndex });
				if (shouldInclude) {
					anyShouldInclude = true;
					await this.add({ blockHash: block.hash, operationIndex });
				}
			})());
		}

		await Promise.all(addPromises);

		return(anyShouldInclude);
	}

	override add(request: OperationQueueRunnerRequest, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		const requestIdString = ConvertStringToRequestID(`${request.blockHash.toString()}-${String(request.operationIndex)}`.toLowerCase());

		if (info?.id && String(info.id) !== String(requestIdString)) {
			throw(new Error(`OperationQueueRunner::add: When providing an "id" in info, it must match the blockHash and operationIndex of the request. Expected ${String(requestIdString)}, got ${String(info.id)}`));
		}

		return(super.add(request, { ...info, id: requestIdString }))
	}
}
