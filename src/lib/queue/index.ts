import type { BrandedString, Brand } from '../utils/brand.ts';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.ts';
import type { AssertNever } from '../utils/never.ts';
import { Errors } from './common.js';
import { MethodLogger } from './internal.js';

export type KeetaAnchorQueueRequest<REQUEST> = REQUEST;
export type KeetaAnchorQueueRequestID = BrandedString<'KeetaAnchorQueueID'>;
export type KeetaAnchorQueueWorkerID = Brand<number, 'KeetaAnchorQueueWorkerID'>;

export type KeetaAnchorQueueStatus = 'pending' | 'processing' | 'completed' | 'failed_temporarily' | 'failed_permanently' | 'stuck' | 'aborted' | 'moved';
export type KeetaAnchorQueueEntry<REQUEST, RESPONSE> = {
	/**
	 * The Job ID
	 */
	id: KeetaAnchorQueueRequestID;
	/**
	 * Parent job IDs from a previous stage
	 */
	parents?: Set<KeetaAnchorQueueRequestID> | undefined;
	request: KeetaAnchorQueueRequest<REQUEST>;
	output: RESPONSE | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: Date;
	updated: Date;
	worker: KeetaAnchorQueueWorkerID | null;
	failures: number;
};
export type KeetaAnchorQueueEntryExtra = {
	[key in 'parents' | 'id']?: KeetaAnchorQueueEntry<never, never>[key] | undefined;
};

export type KeetaAnchorQueueFilter = {
	/**
	 * Only return entries with this status
	 */
	status?: KeetaAnchorQueueStatus;
	/**
	 * Only return entries last updated before this date
	 */
	updatedBefore?: Date;
	/**
	 * Limit the number of entries returned
	 */
	limit?: number;
};

export type KeetaAnchorQueueCommonOptions = {
	logger?: Logger | undefined;
	id?: string | undefined;
};

export type KeetaAnchorQueueRunnerOptions = KeetaAnchorQueueCommonOptions & {
	/**
	 * If specified, then multiple workers can be used to process this queue
	 * in parallel by splitting the work among the workers.
	 *
	 * By default, only a single worker will process the queue (count=1, id=0)
	 */
	workers?: {
		count: number;
		id: number;
	} | undefined;
};

export type KeetaAnchorQueueStorageOptions = KeetaAnchorQueueCommonOptions & {
	path?: string[] | undefined;
};

export type KeetaAnchorQueueEntryAncillaryData<RESPONSE> = {
	/**
	 * The previous status of the entry -- if the entry is not currently in this status,
	 * the status update will fail
	 */
	oldStatus?: KeetaAnchorQueueStatus | undefined;
	/**
	 * The worker ID performing the status update
	 */
	by?: KeetaAnchorQueueWorkerID | undefined;
	/**
	 * The output data to store with the entry
	 */
	output?: RESPONSE | null | undefined;
	/**
	 * An error message to store with the entry
	 */
	error?: string | undefined;
};

export type KeetaAnchorQueueStorageDriverConstructor<REQUEST extends JSONSerializable, RESPONSE extends JSONSerializable> = new(options?: KeetaAnchorQueueStorageOptions) => KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>;

export interface KeetaAnchorQueueStorageDriver<REQUEST extends JSONSerializable, RESPONSE extends JSONSerializable> {
	/**
	 * An ID for this instance of the storage driver
	 */
	readonly id: string;

	/**
	 * The name of the storage driver
	 */
	readonly name: string;

	/**
	 * The partition ID for this instance of the storage driver
	 *
	 * This is used to divide a single storage backend into multiple
	 * independent queues.
	 *
	 * The root partition is an empty array, and each element is
	 * a heirarchical partition name.
	 */
	readonly path: string[];

	/**
	 * Enqueue an item to be processed by the queue
	 *
	 * It will be inserted into the queue as a 'pending' entry
	 *
	 * @param request The request to enqueue
	 * @param id Optional ID to use for the entry -- if not provided, a new
	 *           ID will be generated.  If the ID is already in use then
	 *           nothing will be added.
	 * @returns The ID for the newly created pending entry
	 */
	add: (request: KeetaAnchorQueueRequest<REQUEST>, info?: KeetaAnchorQueueEntryExtra) => Promise<KeetaAnchorQueueRequestID>;

	/**
	 * Update the status of an entry in the queue
	 *
	 * If the status is "failed_temporarily", the failure count will be incremented
	 *
	 * @param id The entry ID to update
	 * @param status The new status of the entry
	 * @param ancillary Optional ancillary data for the status update
	 * @returns void
	 */
	setStatus: (id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>) => Promise<void>;

	/**
	 * Get entries from storage with an optional filter
	 *
	 * @param filter The filter to apply (optional)
	 * @returns An array of entries matching the criteria
	 */
	query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]>;

	/**
	 * Get a single entry from storage by ID
	 *
	 * @param id The ID of the entry to retrieve
	 * @returns The entry if found, or null if not found
	 */
	get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null>;

	/**
	 * Perform maintenance tasks on the storage driver
	 * (e.g. cleaning up old entries, etc)
	 *
	 * @returns void
	 */
	maintain?: () => Promise<void>;

	/**
	 * Create a partitioned view of the queue
	 *
	 * @param partitionID The partition ID to use
	 * @returns A new storage driver instance for the partition
	 */
	partition: (path: string) => Promise<KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>>;

	/**
	 * Close the storage driver and release any resources
	 */
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * An in-memory implementation of the KeetaAnchorQueueStorageDriver
 */
export class KeetaAnchorQueueStorageDriverMemory<REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
	protected queueStorage: {
		[path: string]: KeetaAnchorQueueEntry<REQUEST, RESPONSE>[];
	} = {};
	protected readonly logger?: Logger | undefined;
	protected partitionCounter = 0;
	private destroyed = false;
	readonly name: string = 'KeetaAnchorQueueStorageDriverMemory';
	readonly id: string;
	readonly path: string[] = [];

	constructor(options?: KeetaAnchorQueueStorageOptions) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger;
		this.path.push(...(options?.path ?? []));
		Object.freeze(this.path);

		this.methodLogger('new')?.debug('Created new in-memory queue storage driver');
	}

	protected clone(options?: Partial<KeetaAnchorQueueStorageOptions>): KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
		const cloned = new KeetaAnchorQueueStorageDriverMemory<REQUEST, RESPONSE>({
			logger: this.logger,
			id: `${this.id}::${this.partitionCounter++}`,
			path: [...this.path],
			...options
		});
		cloned.queueStorage = this.queueStorage;

		return(cloned);
	}

	protected get queue(): KeetaAnchorQueueEntry<REQUEST, RESPONSE>[] {
		const pathKey = ['root', ...this.path].join('.')
		let retval = this.queueStorage[pathKey];
		if (retval === undefined) {
			retval = this.queueStorage[pathKey] = [];
		}
		return(retval);
	}

	protected methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverMemory',
			file: 'src/lib/queue/index.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private checkDestroyed(): void {
		if (this.destroyed) {
			throw(new Error('Queue has been destroyed'));
		}
	}

	async add(request: KeetaAnchorQueueRequest<REQUEST>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		this.checkDestroyed();

		const logger = this.methodLogger('add');

		let id = info?.id;
		if (id) {
			const duplicateID = this.queue.some(function(checkEntry) {
				return(checkEntry.id === id);
			});

			if (duplicateID) {
				logger?.debug(`Request with id ${String(id)} already exists, ignoring`);

				return(id);
			}
		}

		const parentIDs = info?.parents;
		if (parentIDs) {
			const matchingParentEntries = new Set<KeetaAnchorQueueRequestID>();
			for (const parentID of parentIDs) {
				const parentEntryExists = this.queue.some(function(checkEntry) {
					return(checkEntry.parents?.has(parentID) ?? false);
				});

				if (parentEntryExists) {
					matchingParentEntries.add(parentID);
				}
			}

			if (matchingParentEntries.size !== 0) {
				throw(new Errors.ParentExistsError('One or more parent entries already exist in the queue', matchingParentEntries));
			}
		}

		/*
		 * The ID is a branded string, so we must cast the generated UUID
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		id ??= crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;

		logger?.debug(`Enqueuing request with id ${String(id)}`);

		this.queue.push({
			id: id,
			request: request,
			output: null,
			lastError: null,
			status: 'pending',
			failures: 0,
			created: new Date(),
			updated: new Date(),
			worker: null,
			parents: parentIDs ? new Set(parentIDs) : undefined
		});

		return(id);
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>): Promise<void> {
		this.checkDestroyed();

		const logger = this.methodLogger('setStatus');

		const { oldStatus, by, output } = ancillary ?? {};

		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});
		if (!entry) {
			throw(new Error(`Request with ID ${String(id)} not found`));
		}

		if (oldStatus && entry.status !== oldStatus) {
			throw(new Error(`Request with ID ${String(id)} status is not "${oldStatus}", cannot update to "${status}"`));
		}

		logger?.debug(`Setting request with id ${String(id)} status from "${entry.status}" to "${status}"`);

		/* XXX -- this needs to be replicated in every driver -- is there a better way ? */
		if (status === 'failed_temporarily') {
			entry.failures += 1;
			logger?.debug(`Incrementing failure count for request with id ${String(id)} to ${entry.failures}`);
		}

		if  (status === 'pending' || status === 'completed') {
			logger?.debug(`Clearing last error for request with id ${String(id)}`);
			entry.lastError = null;
		}
		/* END OF XXX */

		if (ancillary?.error) {
			entry.lastError = ancillary.error;
			logger?.debug(`Setting last error for request with id ${String(id)} to:`, ancillary.error);
		}

		entry.status = status;
		entry.updated = new Date();
		entry.worker = by ?? null;

		if (output !== undefined) {
			logger?.debug(`Setting output for request with id ${String(id)}:`, output);

			entry.output = output;
		}
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null> {
		this.checkDestroyed();

		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});

		if (!entry) {
			return(null);
		}

		return(structuredClone(entry));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]> {
		this.checkDestroyed();

		const logger = this.methodLogger('query');

		const queueDuplicate = structuredClone(this.queue);

		logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

		const allEntriesInStatus = (function() {
			const filterStatus = filter?.status;
			const filterLastUpdateBefore = filter?.updatedBefore;
			if (filterStatus || filterLastUpdateBefore) {
				return(queueDuplicate.filter(function(entry) {
					if (filterStatus) {
						if (entry.status !== filterStatus) {
							return(false);
						}
					}
					if (filterLastUpdateBefore) {
						if (entry.updated >= filterLastUpdateBefore) {
							return(false);
						}
					}
					return(true);
				}));
			} else {
				return(queueDuplicate);
			}
		})();

		let retval = allEntriesInStatus;
		if (filter?.limit !== undefined) {
			retval = allEntriesInStatus.slice(0, filter.limit);
		}

		logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', retval.length, 'entries');

		return(retval);
	}

	async partition(path: string): Promise<KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>> {
		this.checkDestroyed();

		const logger = this.methodLogger('partition');

		logger?.debug(`Creating partitioned queue storage driver for path "${path}"`);

		const partitioned = this.clone({
			path: [...this.path, path]
		});

		return(partitioned);
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		this.methodLogger('destroy')?.debug('Destroying in-memory queue');
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}

export abstract class KeetaAnchorQueueRunner<UREQUEST = unknown, URESPONSE = unknown, REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> {
	/**
	 * The queue this runner is responsible for running
	 */
	private readonly queue: KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>;
	/**
	 * The logger we should use for logging anything
	 */
	private readonly logger?: Logger | undefined;
	/**
	 * The processor function to use for processing entries
	 */
	private readonly processor: (entry: KeetaAnchorQueueEntry<UREQUEST, URESPONSE>) => Promise<{ status: KeetaAnchorQueueStatus; output: URESPONSE | null; }>;
	/**
	 * Worker configuration (not implemented)
	 */
	private readonly workers: NonNullable<KeetaAnchorQueueRunnerOptions['workers']>;
	private readonly workerID: KeetaAnchorQueueWorkerID;

	/**
	 * Pipes to other runners we have registered
	 */
	private readonly pipes: ({
		isBatchPipe: false;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		target: KeetaAnchorQueueRunner<URESPONSE, any, RESPONSE, any>
	} | {
		isBatchPipe: true;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		target: KeetaAnchorQueueRunner<URESPONSE[], any, JSONSerializable, any>;
		minBatchSize: number;
		maxBatchSize: number;
	})[] = [];

	/**
	 * Configuration for this queue
	 */
	private maxRetries = 5;
	private processTimeout = 300_000; /* 5 minutes */
	private batchSize = 100;

	/**
	 * The ID of this runner for diagnostic purposes
	 */
	readonly id: string;

	constructor(config: { queue: KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>; processor: KeetaAnchorQueueRunner<UREQUEST, URESPONSE, REQUEST, RESPONSE>['processor']; } & KeetaAnchorQueueRunnerOptions) {
		this.queue = config.queue;
		this.logger = config.logger;
		this.processor = config.processor;
		this.workers = config.workers ?? {
			count: 1,
			id: 0
		};

		/* XXX:TODO: Support multiple workers */
		if (this.workers.id !== 0 || this.workers.count !== 1) {
			throw(new Error('Worker ID other than 0 or worker count other than 1 is not supported yet'));
		}

		/*
		 * The worker ID is just a branded version of the worker number
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.workerID = this.workers.id as KeetaAnchorQueueWorkerID;
		this.id = config.id ?? crypto.randomUUID();

		this.methodLogger('new')?.debug('Created new queue runner attached to queue', this.queue.id);
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueRunner',
			file: 'src/lib/queue/index.ts',
			method: method,
			instanceID: this.id
		}));
	}

	/** @internal */
	_testingSetParams(key: string, maxBatchSize: number, processTimeout: number, maxRetries: number): void {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}
		this.batchSize = maxBatchSize;
		this.processTimeout = processTimeout;
		this.maxRetries = maxRetries;
	}

	/** @internal */
	_testingQueue(key: string): KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}
		return(this.queue);
	}

	protected abstract decodeRequest(request: REQUEST): UREQUEST;
	protected abstract decodeResponse(response: RESPONSE | null): URESPONSE | null;

	protected abstract encodeRequest(request: UREQUEST): REQUEST;
	protected abstract encodeResponse(response: URESPONSE | null): RESPONSE | null;

	protected decodeEntry(entry: KeetaAnchorQueueEntry<REQUEST, RESPONSE>): KeetaAnchorQueueEntry<UREQUEST, URESPONSE> {
		return({
			...entry,
			request: this.decodeRequest(entry.request),
			output: this.decodeResponse(entry.output)
		});
	}

	/**
	 * Enqueue an item to be processed by the queue
	 */
	async add(request: UREQUEST, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		const encodedRequest = this.encodeRequest(request);
		const newID = await this.queue.add(encodedRequest, info);
		return(newID);
	}

	/**
	 * Get a single entry from storage by ID
	 */
	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<UREQUEST, URESPONSE> | null> {
		const entry = await this.queue.get(id);
		if (!entry) {
			return(null);
		}

		return(this.decodeEntry(entry));
	}

	/**
	 * Get entries from storage with an optional filter
	 */
	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<UREQUEST, URESPONSE>[]> {
		const entries = await this.queue.query(filter);
		return(entries.map((entry) => {
			return(this.decodeEntry(entry));
		}));
	}

	/**
	 * Set the status of an entry in the queue
	 */
	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<URESPONSE>): Promise<void> {
		let encodedOutput: RESPONSE | null | undefined = undefined;
		if (ancillary?.output !== undefined) {
			encodedOutput = this.encodeResponse(ancillary.output);
		}

		return(await this.queue.setStatus(id, status, {
			...ancillary,
			output: encodedOutput
		}));
	}

	/**
	 * Checks to see if the queue is runnable
	 */
	async runnable(): Promise<boolean> {
		const pendingEntries = await this.queue.query({ status: 'pending', limit: 1 });
		if (pendingEntries.length > 0) {
			return(true);
		}

		for (const pipe of this.pipes) {
			const pipeRunnable = await pipe.target.runnable();
			if (pipeRunnable) {
				return(true);
			}
		}

		return(false);
	}

	/**
	 * Run the queue processor
	 *
	 * Processes up to `batchSize` entries from the queue and returns
	 * true if there may be more work to do, or false if the queue
	 * is empty.
	 *
	 * @param timeout Optional timeout in milliseconds to limit the total
	 * 	          time spent processing entries
	 */
	async run(timeout?: number): Promise<boolean> {
		const logger = this.methodLogger('run');
		const batchSize = this.batchSize;
		const processTimeout = this.processTimeout;

		let retval = true;

		const startTime = Date.now();

		for (let index = 0; index < batchSize; index++) {
			const entries = await this.queue.query({ status: 'pending', limit: 1 });
			const entry = entries[0];
			if (entry === undefined) {
				retval = false;

				break;
			}

			if (timeout !== undefined) {
				const elapsed = Date.now() - startTime;
				if (elapsed >= timeout) {
					logger?.debug(`Timeout of ${timeout}ms reached after processing ${index + 1} entries`);

					break;
				}
			}

			let setEntryStatus: { status: KeetaAnchorQueueStatus; output: URESPONSE | null; error?: string; } = { status: 'failed_temporarily', output: null };

			logger?.debug(`Processing entry request with id ${String(entry.id)}`);

			try {
				/*
				 * Get a lock by setting it to 'processing'
				 */
				await this.queue.setStatus(entry.id, 'processing', { oldStatus: 'pending', by: this.workerID });

				/*
				 * Process the entry with a timeout, if the timeout is reached
				 * we should mark the process as aborted because we no longer
				 * know what state the work is in and someone will need to
				 * inspect the job and determine through some other means if
				 * it is completed or failed.
				 */
				let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
				setEntryStatus = await Promise.race([
					new Promise<{ status: 'aborted', output: null }>(function(resolve) {
						timeoutTimer = setTimeout(function() {
							resolve({ status: 'aborted', output: null });
						}, processTimeout);
					}),
					(async () => {
						try {
							return(await this.processor(this.decodeEntry(entry)));
						} finally {
							if (timeoutTimer) {
								clearTimeout(timeoutTimer);
							}
						}
					})()
				]);
			} catch (error: unknown) {
				logger?.error(`Failed to process request with id ${String(entry.id)}, setting state to "${setEntryStatus.status}":`, error);
				setEntryStatus.status = 'failed_temporarily';
				setEntryStatus.error = String(error);
			}

			if (setEntryStatus.status === 'processing') {
				throw(new Error('Processor returned invalid status "processing"'));
			}

			let by: KeetaAnchorQueueWorkerID | undefined = this.workerID;
			if (setEntryStatus.status === 'pending') {
				by = undefined;
			}

			await this.queue.setStatus(entry.id, setEntryStatus.status, { oldStatus: 'processing', by: by, output: this.encodeResponse(setEntryStatus.output), error: setEntryStatus.error });

		}

		const pipes = [...this.pipes];
		for (const pipe of pipes) {
			let remainingTime: number | undefined = undefined;
			if (timeout !== undefined) {
				const elapsed = Date.now() - startTime;
				remainingTime = timeout - elapsed;
				if (remainingTime <= 0) {
					remainingTime = -1;
				}
			}

			const pipeHasMoreWork = await pipe.target.run(remainingTime);
			if (pipeHasMoreWork) {
				retval = true;
			}
		}

		return(retval);
	}

	private async markStuckRequestsAsStuck(): Promise<void> {
		const stuckThreshold = this.processTimeout * 10;

		const logger = this.methodLogger('markStuckRequestsAsStuck');
		const now = Date.now();

		const requests = await this.queue.query({ status: 'processing', limit: 100, updatedBefore: new Date(now - stuckThreshold) });
		for (const request of requests) {
			try {
				logger?.warn(`Marking request with id ${String(request.id)} as stuck`);

				await this.queue.setStatus(request.id, 'stuck', { oldStatus: 'processing', by: this.workerID });
			} catch (error: unknown) {
				logger?.error(`Failed to mark request with id ${String(request.id)} as stuck:`, error);
			}
		}
	}

	private async requeueFailedRequests(): Promise<void> {
		const retryDelay = this.processTimeout * 10;
		const maxRetries = this.maxRetries;

		const logger = this.methodLogger('requeueFailedRequests');
		const now = Date.now();

		const requests = await this.queue.query({ status: 'failed_temporarily', limit: 100, updatedBefore: new Date(now - retryDelay) });
		for (const request of requests) {
			try {
				if (request.failures >= maxRetries) {
					logger?.info(`Request with id ${String(request.id)} has exceeded maximum retries, not requeuing -- moving to failed_permanently`);
					await this.queue.setStatus(request.id, 'failed_permanently', { oldStatus: 'failed_temporarily', by: this.workerID });

					continue;
				}

				logger?.debug(`Requeuing failed request with id ${String(request.id)}`);

				await this.queue.setStatus(request.id, 'pending', { oldStatus: 'failed_temporarily', by: this.workerID });
			} catch (error: unknown) {
				logger?.error(`Failed to requeue request with id ${String(request.id)}:`, error);
			}
		}
	}

	private async moveCompletedToNextStage(): Promise<void> {
		const logger = this.methodLogger('moveCompletedToNextStage');

		const pipes = [...this.pipes];
		if (pipes.length === 0) {
			return;
		}

		const allRequests = await this.queue.query({ status: 'completed', limit: 100 });
		let requests = allRequests;

		const RequestSentToPipes = new Map<KeetaAnchorQueueRequestID, number>();
		function IncrRequestSentToPipes(requestID: KeetaAnchorQueueRequestID): void {
			const sentCount = RequestSentToPipes.get(requestID) ?? 0;
			RequestSentToPipes.set(requestID, sentCount + 1);
		}


		for (const pipe of pipes) {
			logger?.debug('Processing pipe to target', pipe.target.id, pipe.isBatchPipe ? '(batch pipe)' : '(single item pipe)');

			if (pipe.isBatchPipe) {
				/**
				 * Keep track of all the requests we successfully
				 * sent to the target stage
				 */
				const allTargetSeenRequestIDs = new Set<KeetaAnchorQueueRequestID>();

				/**
				 * During each iteration of the batch processing, we keep track
				 * of the IDs we have already seen by the target and processed
				 * so we don't try to reprocess them again
				 */
				const iterationTargetSeenRequestIDs = new Set<KeetaAnchorQueueRequestID>();

				/**
				 * If we get a batch that cannot be added to the target pipe,
				 * we just skip over them for retrying at a later date
				 */
				const skipRequestIDs = new Set<KeetaAnchorQueueRequestID>();

				/**
				 * Compute a durable ID for this batch and target
				 */
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				let batchID = crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;

				/**
				 * Keep track of sequential failures to find enough entries
				 * and stop processing if we can't find enough after a few tries
				 * in a row
				 */
				let sequentialFailureCount = 0;

				for (;requests.length >= pipe.minBatchSize;
					/*
					 * Remove any entries we have already seen during
					 * the last iteration of the loop
					 */
					requests = requests.filter(function(entry) {
						return(!iterationTargetSeenRequestIDs.has(entry.id) && !skipRequestIDs.has(entry.id));
					})
				) {
					iterationTargetSeenRequestIDs.clear();

					logger?.debug(`Preparing to move completed requests to next stage ${pipe.target.id} (min=${pipe.minBatchSize}, max=${pipe.maxBatchSize}), have ${requests.length} completed requests available`);

					/**
					 * Comptue a batch of entries to send to the next stage,
					 * constrained to the max batch size of the pipe and
					 * the entries which have non-null outputs
					 */
					const batchRaw = requests.map((entry) => {
						return({ output: this.decodeResponse(entry.output), id: entry.id });
					}).filter(function(entry): entry is { output: URESPONSE; id: KeetaAnchorQueueRequestID; } {
						if (entry === null) {
							return(false);
						}

						return(true);
					}).slice(0, pipe.maxBatchSize);

					/*
					 * If we don't have enough entries to meet the minimum
					 * batch size, skip this iteration
					 */
					if (batchRaw.length < pipe.minBatchSize) {
						sequentialFailureCount++;
						if (sequentialFailureCount >= 3) {
							logger?.debug(`Not enough completed requests to move to next stage ${pipe.target.id}, stopping batch processing`);

							break;
						}

						logger?.debug(`Not moving completed requests to next stage ${pipe.target.id} because batch size ${batchRaw.length} is less than minimum size ${pipe.minBatchSize}`);

						continue;
					}
					sequentialFailureCount = 0;

					/**
					 * The IDs for the entries we are sending to the next stage
					 * target -- this may get reduced if we find there are already
					 * jobs in the next stage that have the parentIDs of one of
					 * these jobs
					 */
					const batchLocalIDs = new Set(batchRaw.map(function(entry) {
						return(entry.id);
					}));
					/**
					 * The outputs for the batch we are sending to the next stage
					 */
					const batchOutput = batchRaw.map(function(entry) {
						return(entry.output);
					});

					logger?.debug(`Moving batch of ${batchOutput.length} completed requests to next pipe`, pipe.target.id, '(input entry IDs:', Array.from(batchLocalIDs), '->', `${pipe.target.id}:${String(batchID)})`);

					try {
						await pipe.target.add(batchOutput, {
							id: batchID,
							/* Use the set of IDs as the parent IDs for the batch */
							parents: batchLocalIDs
						});

						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						batchID = crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;
					} catch (error: unknown) {
						if (Errors.ParentExistsError.isInstance(error) && error.parentIDsFound) {
							logger?.debug('Some of the jobs have already been added to the target queue, skipping those:', error.parentIDsFound.values());
							for (const requestID of error.parentIDsFound) {
								iterationTargetSeenRequestIDs.add(requestID);
								allTargetSeenRequestIDs.add(requestID);
							}
						} else {
							/*
							 * If we got some kind of other error adding these
							 * items to the target queue runner, just skip them
							 * and we will rety them on the next iteration
							 */
							logger?.error(`Failed to move completed batch to next stage ${pipe.target.id}, will try to create another batch without them:`, error);

							for (const requestID of batchLocalIDs) {
								skipRequestIDs.add(requestID);
							}

						}
						continue;
					}

					for (const requestID of batchLocalIDs) {
						iterationTargetSeenRequestIDs.add(requestID);
						allTargetSeenRequestIDs.add(requestID);
					}
				}

				/*
				 * For every request we know the target has definitely seen, mark it
				 * as moved for this pipe
				 */
				for (const requestID of allTargetSeenRequestIDs) {
					IncrRequestSentToPipes(requestID);
				}
			} else {
				for (const request of requests) {
					let shouldMarkAsMoved = true;
					try {
						const output = this.decodeResponse(request.output);
						if (output === null) {
							logger?.debug(`Completed request with id ${String(request.id)} has no output -- next stage will not be run`);
						} else {
							logger?.debug(`Moving completed request with id ${String(request.id)} to next pipe`, pipe.target.id);
							await pipe.target.add(output, { id: request.id });
						}

					} catch (error: unknown) {
						logger?.error(`Failed to move completed request with id ${String(request.id)} to next stage:`, error);
						shouldMarkAsMoved = false;
					}
					if (shouldMarkAsMoved) {
						IncrRequestSentToPipes(request.id);
					}
				}
			}
		}

		const TotalPipes = pipes.length;
		for (const request of allRequests) {
			const sentCount = RequestSentToPipes.get(request.id) ?? 0;
			if (sentCount !== TotalPipes) {
				logger?.debug(`Completed request with id ${String(request.id)} was only moved to ${sentCount} out of ${TotalPipes} pipes -- not marking as moved`);
				continue;
			}

			logger?.debug(`Marking completed request with id ${String(request.id)} as moved`);

			await this.queue.setStatus(request.id, 'moved', { oldStatus: 'completed', by: this.workerID });
		}

	}

	async maintain(): Promise<void> {
		if (this.workers.id !== 0) {
			return;
		}

		try {
			await this.markStuckRequestsAsStuck();
		} catch {
			/* Ignore errors, we will try again later */
		}

		try {
			await this.requeueFailedRequests();
		} catch {
			/* Ignore errors, we will try again later */
		}

		try {
			await this.moveCompletedToNextStage();
		} catch {
			/* Ignore errors, we will try again later */
		}

		for (const pipe of this.pipes) {
			try {
				await pipe.target.maintain();
			} catch {
				/* Ignore errors, we will try again later */
			}
		}

		if (this.queue.maintain) {
			try {
				await this.queue.maintain();
			} catch {
				/* Ignore errors, we will try again later */
			}
		}
	}

	/**
	 * Pipe the the completed entries of this runner to another runner
	 */
	pipe<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<URESPONSE, T1, RESPONSE, T2>): typeof target {
		this.pipes.push({
			isBatchPipe: false,
			target: target
		});
		return(target);
	}

	/**
	 * Pipe batches of completed entries from this runner to another runner
	 */
	pipeBatch<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<URESPONSE[], T1, JSONSerializable, T2>, maxBatchSize = 100, minBatchSize = 1): typeof target {
		this.pipes.push({
			isBatchPipe: true,
			target: target,
			minBatchSize: minBatchSize,
			maxBatchSize: maxBatchSize
		});
		return(target);
	}

	async destroy(): Promise<void> {
		this.methodLogger('destroy')?.debug('Destroying queue runner attached to queue', this.queue.id);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.destroy();
	}
}

export class KeetaAnchorQueueRunnerJSON<UREQUEST extends JSONSerializable = JSONSerializable, URESPONSE extends JSONSerializable = JSONSerializable> extends KeetaAnchorQueueRunner<UREQUEST, URESPONSE, JSONSerializable, JSONSerializable> {
	protected decodeRequest(request: JSONSerializable): UREQUEST {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(request as UREQUEST);
	}

	protected decodeResponse(response: JSONSerializable | null): URESPONSE | null {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(response as URESPONSE | null);
	}

	protected encodeRequest(request: JSONSerializable): JSONSerializable {
		return(request);
	}

	protected encodeResponse(response: JSONSerializable | null): JSONSerializable | null {
		return(response);
	}
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ignore_static_assert_memory = AssertNever<typeof KeetaAnchorQueueStorageDriverMemory<{ a: string; }, number> extends KeetaAnchorQueueStorageDriverConstructor<{ a: string; }, number> ? never : false>;
