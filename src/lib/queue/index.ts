import type { BrandedString, Brand } from '../utils/brand.ts';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.ts';
import { assertNever } from '../utils/never.js';
import type { AssertNever } from '../utils/never.ts';
import type { KeetaAnchorQueueRunOptions } from './common.js';
import { asleep } from '../utils/asleep.js';
import { Errors } from './common.js';
import {
	MethodLogger,
	ManageStatusUpdates,
	ConvertStringToRequestID
} from './internal.js';
import { AsyncDisposableStack } from '../utils/defer.js';

export type KeetaAnchorQueueRequest<QueueRequest> = QueueRequest;
export type KeetaAnchorQueueRequestID = BrandedString<'KeetaAnchorQueueID'>;
export type KeetaAnchorQueueWorkerID = Brand<number, 'KeetaAnchorQueueWorkerID'>;

export type KeetaAnchorQueueStatus = 'pending' | 'processing' | 'completed' | 'failed_temporarily' | 'failed_permanently' | 'stuck' | 'aborted' | 'moved' | '@internal';
const keetaAnchorPipeableQueueStatuses = [ 'completed', 'failed_permanently' ] as const;
/**
 * This is a type-level assertion to ensure that all values in keetaAnchorPipeableQueueStatuses are valid KeetaAnchorQueueStatus values.
 * If this assertion fails, it means that there is a value in keetaAnchorPipeableQueueStatuses that is not a valid KeetaAnchorQueueStatus, and the code will not compile.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type __check_keetaAnchorPipeableQueueStatuses_valid = AssertNever<typeof keetaAnchorPipeableQueueStatuses[number] extends KeetaAnchorQueueStatus ? never : true>;

export type KeetaAnchorPipeableQueueStatus = Extract<KeetaAnchorQueueStatus, typeof keetaAnchorPipeableQueueStatuses[number]>;
export type KeetaAnchorQueueEntry<QueueRequest, QueueResult> = {
	/**
	 * The Job ID
	 */
	id: KeetaAnchorQueueRequestID;
	/**
	 * Idempotent IDs from a previous stage
	 */
	idempotentKeys?: Set<KeetaAnchorQueueRequestID> | undefined;
	request: KeetaAnchorQueueRequest<QueueRequest>;
	output: QueueResult | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: Date;
	updated: Date;
	worker: KeetaAnchorQueueWorkerID | null;
	failures: number;
};

/**
 * Extra information to provide to a request when adding an entry to the queue
 */
export type KeetaAnchorQueueEntryExtra = {
	[key in 'idempotentKeys' | 'id' | 'status']?: (key extends 'id' ? KeetaAnchorQueueRequestID | string : KeetaAnchorQueueEntry<never, never>[key]) | undefined;
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

export type KeetaAnchorQueueEntryAncillaryData<QueueResult> = {
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
	output?: QueueResult | null | undefined;
	/**
	 * An error message to store with the entry
	 */
	error?: string | undefined;
};

export type KeetaAnchorQueueStorageDriverConstructor<QueueRequest extends JSONSerializable, QueueResult extends JSONSerializable> = new(options?: KeetaAnchorQueueStorageOptions) => KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>;

export interface KeetaAnchorQueueStorageDriver<QueueRequest extends JSONSerializable, QueueResult extends JSONSerializable> {
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
	 * a hierarchical partition name.
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
	add: (request: KeetaAnchorQueueRequest<QueueRequest>, info?: KeetaAnchorQueueEntryExtra) => Promise<KeetaAnchorQueueRequestID>;

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
	setStatus: (id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>) => Promise<void>;

	/**
	 * Get entries from storage with an optional filter
	 *
	 * @param filter The filter to apply (optional)
	 * @returns An array of entries matching the criteria
	 */
	query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]>;

	/**
	 * Get a single entry from storage by ID
	 *
	 * @param id The ID of the entry to retrieve
	 * @returns The entry if found, or null if not found
	 */
	get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null>;

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
	partition: (path: string) => Promise<KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>>;

	/**
	 * Close the storage driver and release any resources
	 */
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;

	/** @internal */
	_Testing?: (key: string) => {
		setToctouDelay?(delay: number): void;
		unsetToctouDelay?(): void;
	};
}

/**
 * An in-memory implementation of the KeetaAnchorQueueStorageDriver
 */
export class KeetaAnchorQueueStorageDriverMemory<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
	protected queueStorage: { [path: string]: KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]; } = {};
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

	protected clone(options?: Partial<KeetaAnchorQueueStorageOptions>): KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
		const cloned = new KeetaAnchorQueueStorageDriverMemory<QueueRequest, QueueResult>({
			logger: this.logger,
			id: `${this.id}::${this.partitionCounter++}`,
			path: [...this.path],
			...options
		});
		cloned.queueStorage = this.queueStorage;

		return(cloned);
	}

	protected get queue(): KeetaAnchorQueueEntry<QueueRequest, QueueResult>[] {
		const pathKey = ['root', ...this.path].join('.');
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

	async add(request: KeetaAnchorQueueRequest<QueueRequest>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		this.checkDestroyed();

		const logger = this.methodLogger('add');

		let id = ConvertStringToRequestID(info?.id);
		if (id) {
			const duplicateID = this.queue.some(function(checkEntry) {
				return(checkEntry.id === id);
			});

			if (duplicateID) {
				logger?.debug(`Request with id ${String(id)} already exists, ignoring`);

				return(id);
			}
		}

		const idempotentIDs = info?.idempotentKeys;
		if (idempotentIDs) {
			const matchingIdempotentEntries = new Set<KeetaAnchorQueueRequestID>();
			for (const idempotentID of idempotentIDs) {
				const idempotentEntryExists = this.queue.some(function(checkEntry) {
					return(checkEntry.idempotentKeys?.has(idempotentID) ?? false);
				});

				if (idempotentEntryExists) {
					matchingIdempotentEntries.add(idempotentID);
				}
			}

			if (matchingIdempotentEntries.size !== 0) {
				throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', matchingIdempotentEntries));
			}
		}

		/**
		 * The status to use for the new entry
		 */
		const status = info?.status ?? 'pending';

		/*
		 * The ID is a branded string, so we must convert the generated UUID
		 */
		id ??= ConvertStringToRequestID(crypto.randomUUID());

		logger?.debug(`Enqueuing request with id ${String(id)}`);

		this.queue.push({
			id: id,
			request: request,
			output: null,
			lastError: null,
			status: status,
			failures: 0,
			created: new Date(),
			updated: new Date(),
			worker: null,
			idempotentKeys: idempotentIDs ? new Set(idempotentIDs) : undefined
		});

		return(id);
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>): Promise<void> {
		this.checkDestroyed();

		const logger = this.methodLogger('setStatus');

		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});
		if (!entry) {
			throw(new Error(`Request with ID ${String(id)} not found`));
		}

		const changedFields = ManageStatusUpdates<QueueResult>(id, entry, status, ancillary, logger);

		Object.assign(entry, changedFields);
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> {
		this.checkDestroyed();

		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});

		if (!entry) {
			return(null);
		}

		return(structuredClone(entry));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> {
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

	async partition(path: string): Promise<KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>> {
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

interface AdditionalPipeOptions {
	/**
	 * If true, call maintain/run on this target when maintaining/running this runner
	 * Defaults to true
	 */
	exclusiveTarget?: boolean;
}

// @ts-ignore
export interface KeetaAnchorQueueRunnerConfigurationObject {
	maxRetries: number;
	processTimeout: number;
	batchSize: number;
	retryDelay: number;
	stuckMultiplier: number;
}

// Ensure that KeetaAnchorQueueRunnerConfigurationObject has all the required properties of KeetaAnchorQueueRunner, and no extra properties
// if this assertion fails, it means that KeetaAnchorQueueRunnerConfigurationObject is missing a property from KeetaAnchorQueueRunner or has an extra property
// @ts-ignore
type __check_KeetaAnchorQueueRunnerConfigurationObject = Required<Pick<KeetaAnchorQueueRunner, 'maxRetries' | 'retryDelay' | 'stuckMultiplier' | 'batchSize' | 'processTimeout'>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type __check = AssertNever<__check_KeetaAnchorQueueRunnerConfigurationObject extends KeetaAnchorQueueRunnerConfigurationObject ? (KeetaAnchorQueueRunnerConfigurationObject extends __check_KeetaAnchorQueueRunnerConfigurationObject ? never : false) : false>;

/**
 * A Queue Runner and Request Translator for processing entries in a queue
 *
 * The queue runner is responsible for pulling entries from the queue,
 * processing them, and updating their status in the queue.  As well
 * as moving jobs between queues by piping the output of one runner
 * to another.  Additionally, maintenance tasks such as re-queuing
 * failed jobs and marking stuck jobs are also handled by the runner.
 *
 * This is an abstract base class that must be extended to provide
 * the actual processing logic as well as the encoding and decoding
 * for requests and responses.
 */
export abstract class KeetaAnchorQueueRunner<UserRequest = unknown, UserResult = unknown, QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> {
	/**
	 * The queue this runner is responsible for running
	 */
	private readonly queue: KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>;
	/**
	 * The logger we should use for logging anything
	 */
	private readonly logger?: Logger | undefined;
	/**
	 * The processor function to use for processing entries
	 */
	protected abstract processor(entry: KeetaAnchorQueueEntry<UserRequest, UserResult>): Promise<{ status: KeetaAnchorQueueStatus; output: UserResult | null; error?: string | undefined; }>;

	/**
	 * The processor for stuck jobs (optional)
	 */
	protected processorStuck?(entry: KeetaAnchorQueueEntry<UserRequest, UserResult>): Promise<{ status: KeetaAnchorQueueStatus; output: UserResult | null; error?: string | undefined; }>;

	/**
	 * The processor for aborted jobs (optional)
	 */
	protected processorAborted?(entry: KeetaAnchorQueueEntry<UserRequest, UserResult>): Promise<{ status: KeetaAnchorQueueStatus; output: UserResult | null; error?: string | undefined; }>;

	/**
	 * Worker configuration
	 */
	private readonly workers: NonNullable<KeetaAnchorQueueRunnerOptions['workers']>;
	private readonly workerID: KeetaAnchorQueueWorkerID;

	/**
	 * Pipes to other runners we have registered
	 */
	private readonly pipes: (
		// Non-Batch pipe -- depending on acceptStatus, either UserResult[] or UserRequest[]
		(
			({
				isBatchPipe: false;
			} & ({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				target: KeetaAnchorQueueRunner<UserResult, any, QueueResult, any>
				acceptStatus: Extract<KeetaAnchorPipeableQueueStatus, 'completed'>;
			} | {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				target: KeetaAnchorQueueRunner<UserRequest, any, QueueResult, any>
				acceptStatus: Extract<KeetaAnchorPipeableQueueStatus, 'failed_permanently'>;
			})) |

			// Batch pipe -- depending on acceptStatus, either UserResult[] or UserRequest[]
			({
				isBatchPipe: true;
				minBatchSize: number;
				maxBatchSize: number;
			} & ({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				target: KeetaAnchorQueueRunner<UserResult[], any, JSONSerializable, any>;
				acceptStatus: Extract<KeetaAnchorPipeableQueueStatus, 'completed'>;
			} | {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				target: KeetaAnchorQueueRunner<UserRequest[], any, JSONSerializable, any>;
				acceptStatus: Extract<KeetaAnchorPipeableQueueStatus, 'failed_permanently'>;
			}))
		) & AdditionalPipeOptions
	)[] = [];

	/**
	 * Initialization promise
	 */
	private initializePromise: Promise<void> | undefined;

	/**
	 * Configuration for this queue
	 */
	/**
	 * The maximum number of times to retry a failed job before giving up
	 * and marking it as permanently failed
	 */
	protected maxRetries = 5;
	/**
	 * The amount of time to allow a job to run before considering it
	 * timed out and marking it as aborted, the `aborted` processor
	 * (if provided) will be responsible for determining what to do with
	 * the job at that point (e.g. retry it, mark it as failed, etc)
	 * because some work from the job may have been completed
	 * before the timeout was reached -- it could even still be on-going
	 * after the timeout is reached, so the `aborted` processor should be
	 * prepared to handle that situation as well.
	 */
	protected processTimeout = 300_000; /* 5 minutes */
	/**
	 * When piping a batch of jobs to another runner, this is the number
	 * of jobs to include in each batch (max).
	 */
	protected batchSize = 100;

	/**
	 * The amount of time to wait before retrying a failed job -- this should
	 * be long enough to allow any transient issues to be resolved (e.g. a downstream
	 * service to come back up, etc) but not so long that it causes excessive
	 * delays in processing.
	 *
	 * Keep in mind that after the {@link maxRetries} is reached, the job will
	 * be marked as permanently failed, so if the retry delay is too low then
	 * it could cause jobs to be marked as permanently failed before transient
	 * issues have a chance to be resolved.
	 */
	protected get retryDelay(): number {
		if (this.internalRetryDelay !== undefined) {
			return(this.internalRetryDelay);
		}
		return(this.processTimeout * 10);
	}

	protected set retryDelay(value: number) {
		this.internalRetryDelay = value;
	}

	private internalRetryDelay?: number;

	/**
	 * The number of {@link processTimeout} intervals to wait before
	 * considering a job to be stuck -- this is for jobs that are
	 * still in the 'processing' state but have not updated their
	 * timestamp in a long time, which likely indicates that the worker
	 * processing the job has died or is otherwise no longer making
	 * progress on the job.
	 *
	 * Like the `aborted` status, the `stuck` status means the job is in
	 * an indeterminate state where it may have done some of the work of
	 * the processor but we don't know how much (if any) of it was
	 * completed, so the `stuck` processor should be prepared to handle
	 * that situation.  It is unlikely that the job is still being actively
	 * processed by a worker at this point, but it is possible, so the
	 * `stuck` processor should be prepared to handle that as well.
	 */
	protected get stuckMultiplier(): number {
		if (this.internalStuckMultiplier !== undefined) {
			return(this.internalStuckMultiplier);
		}
		return(10);
	}

	protected set stuckMultiplier(value: number) {
		this.internalStuckMultiplier = value;
	}

	private internalStuckMultiplier?: number;

	/**
	 * How many runners can process this queue in parallel
	 */
	protected maxRunners?: number;
	private readonly runnerLockKey: KeetaAnchorQueueRequestID;

	/**
	 * The ID of this runner for diagnostic purposes
	 */
	readonly id: string;

	constructor(config: { queue: KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>; } & KeetaAnchorQueueRunnerOptions) {
		this.queue = config.queue;
		this.logger = config.logger;
		this.workers = config.workers ?? {
			count: 1,
			id: 0
		};

		if (this.workers.id < 0) {
			throw(new Error('Worker ID cannot be negative'));
		}

		if (this.maxRunners) {
			if (this.workers.id > this.maxRunners - 1 || this.workers.count > this.maxRunners) {
				throw(new Error('Worker ID other than 0 or worker count other than 1 is not supported yet'));
			}
		}

		/*
		 * The worker ID is just a branded version of the worker number
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.workerID = this.workers.id as KeetaAnchorQueueWorkerID;

		/*
		 * The runner lock key, a unique key used to ensure only
		 * one instance of a given runner is running at a time
		 */
		this.runnerLockKey = ConvertStringToRequestID(`@runner-lock:9ba756f0-7aa2-41c7-a1ea-b010dc752ae8.worker.${this.workerID}`);

		/**
		 * Instance ID
		 */
		this.id = config.id ?? crypto.randomUUID();

		this.methodLogger('new')?.debug('Created new queue runner attached to queue', this.queue.id);
	}

	private async initialize(): Promise<void> {
		if (this.initializePromise) {
			return(await this.initializePromise);
		}

		/* Ensure the sequential lock entry exists */
		this.initializePromise = (async () => {
			/*
			 * We store `null` as the request value because we
			 * don't have anything better to store -- it's not
			 * always going to be compatible with the type
			 * QueueRequest but we know that we will never actually
			 * use the value.
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			await this.queue.add(null as unknown as QueueRequest, {
				id: this.runnerLockKey,
				status: '@internal'
			});
		})();

		return(await this.initializePromise);
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
	_Testing(key: string): {
		setParams: (maxBatchSize: number, processTimeout: number, maxRetries: number, maxWorkers?: number) => void;
		queue: () => KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>;
		markWorkerAsProcessing: () => Promise<void>;
	} {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}

		return({
			setParams: (maxBatchSize: number, processTimeout: number, maxRetries: number, maxWorkers?: number) => {
				this.batchSize = maxBatchSize;
				this.processTimeout = processTimeout;
				this.maxRetries = maxRetries;
				if (maxWorkers !== undefined) {
					this.maxRunners = maxWorkers;
				}
			},
			queue: () => {
				return(this.queue);
			},
			markWorkerAsProcessing: async () => {
				await this.queue.setStatus(this.runnerLockKey, 'processing', {
					oldStatus: '@internal',
					by: this.workerID
				});
			}
		});
	}

	protected abstract decodeRequest(request: QueueRequest): UserRequest;
	protected abstract decodeResponse(response: QueueResult | null): UserResult | null;

	protected abstract encodeRequest(request: UserRequest): QueueRequest;
	protected abstract encodeResponse(response: UserResult | null): QueueResult | null;

	protected decodeEntry(entry: KeetaAnchorQueueEntry<QueueRequest, QueueResult>): KeetaAnchorQueueEntry<UserRequest, UserResult> {
		return({
			...entry,
			request: this.decodeRequest(entry.request),
			output: this.decodeResponse(entry.output)
		});
	}

	/**
	 * Enqueue an item to be processed by the queue
	 */
	async add(request: UserRequest, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		await this.initialize();

		const encodedRequest = this.encodeRequest(request);
		const newID = await this.queue.add(encodedRequest, info);
		return(newID);
	}

	/**
	 * Get a single entry from storage by ID
	 */
	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<UserRequest, UserResult> | null> {
		await this.initialize();

		const entry = await this.queue.get(id);
		if (!entry) {
			return(null);
		}

		return(this.decodeEntry(entry));
	}

	/**
	 * Get entries from storage with an optional filter
	 */
	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<UserRequest, UserResult>[]> {
		await this.initialize();

		const entries = await this.queue.query(filter);
		return(entries.map((entry) => {
			return(this.decodeEntry(entry));
		}));
	}

	/**
	 * Set the status of an entry in the queue
	 */
	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<UserResult>): Promise<void> {
		await this.initialize();

		let encodedOutput: QueueResult | null | undefined = undefined;
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
		await this.initialize();

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

	private async updateRunnerLockTimestamp(): Promise<void> {
		const logger = this.methodLogger('updateRunnerLockTimestamp');

		try {
			logger?.debug('Updating sequential processing lock timestamp for worker ID', this.workerID);
			await this.queue.setStatus(this.runnerLockKey, 'processing', {
				oldStatus: 'processing',
				by: this.workerID
			});
			logger?.debug('Updated sequential processing lock timestamp for worker ID', this.workerID);
		} catch (error: unknown) {
			logger?.error('Failed to update sequential processing lock timestamp for worker ID', this.workerID, ':', error);
			throw(error);
		}
	}

	private async getRunnerLock(cleanup: InstanceType<typeof AsyncDisposableStack>): Promise<boolean> {
		const logger = this.methodLogger('getRunnerLock');

		try {
			logger?.debug('Acquiring sequential processing lock for worker ID', this.workerID);
			await this.queue.setStatus(this.runnerLockKey, 'processing', {
				oldStatus: '@internal',
				by: this.workerID
			});
			logger?.debug('Acquired sequential processing lock for worker ID', this.workerID);
		} catch (error: unknown) {
			if (Errors.IncorrectStateAssertedError.isInstance(error)) {
				return(false);
			}

			throw(error);
		}

		cleanup.defer(async () => {
			for (let retry = 0; retry < 10; retry++) {
				logger?.debug(`Releasing sequential processing lock try #${retry + 1} for worker ID`, this.workerID);
				try {
					await this.queue.setStatus(this.runnerLockKey, '@internal', {
						oldStatus: 'processing',
						by: undefined
					});
				} catch {
					await asleep(1000);
					continue;
				}
				break;
			}
		});

		return(true);
	}

	private async maintainRunnerLock(): Promise<void> {
		const logger = this.methodLogger('maintainRunnerLock');
		const moment = new Date();
		await using cleanup = new AsyncDisposableStack();

		const obtained = await this.getRunnerLock(cleanup);
		if (obtained) {
			return;
		}

		/**
		 * Check to see if the lock is stale
		 */
		const lockEntry = await this.queue.get(this.runnerLockKey);

		if (!lockEntry) {
			return;
		}
		const lockAge = moment.getTime() - lockEntry.updated.getTime();
		if (lockAge > this.processTimeout * this.stuckMultiplier) {
			logger?.warn('Processing lock is stale, taking over lock for worker ID', this.workerID);

			await this.queue.setStatus(this.runnerLockKey, '@internal', {
				oldStatus: 'processing',
				by: this.workerID
			});
		}
	}

	/**
	 * Run the queue processor
	 *
	 * Processes up to `batchSize` entries from the queue and returns
	 * true if there may be more work to do, or false if the queue
	 * is empty.
	 *
	 * @param options Optional run options
	 */
	async run(options?: KeetaAnchorQueueRunOptions): Promise<boolean> {
		const timeout = options?.timeoutMs;

		await this.initialize();

		const logger = this.methodLogger('run');
		const batchSize = this.batchSize;
		const processTimeout = this.processTimeout;
		await using cleanup = new AsyncDisposableStack();

		let retval = true;

		const startTime = Date.now();

		const locked = await this.getRunnerLock(cleanup);
		if (!locked) {
			logger?.debug('Another worker is already processing the queue, skipping run');

			return(true);
		}

		const processJobOk = Symbol('processJobOk');
		const processJobTimeout = Symbol('processJobTimeout');

		const processJob = async (index: number, entry: KeetaAnchorQueueEntry<QueueRequest, QueueResult>, startingStatus: KeetaAnchorQueueStatus, processor: (entry: KeetaAnchorQueueEntry<UserRequest, UserResult>) => Promise<{ status: KeetaAnchorQueueStatus; output: UserResult | null; error?: string | undefined; }>): Promise<typeof processJobTimeout | typeof processJobOk> => {
			if (timeout !== undefined) {
				const elapsed = Date.now() - startTime;
				if (elapsed >= timeout) {
					logger?.debug(`Timeout of ${timeout}ms reached after processing ${index} entries (${startingStatus} phase; elapsed ${elapsed}ms)`);

					return(processJobTimeout);
				}
			}

			await this.updateRunnerLockTimestamp();

			let setEntryStatus: { status: KeetaAnchorQueueStatus; output: UserResult | null; error?: string | undefined; } = { status: 'failed_temporarily', output: null };

			logger?.debug(`Processing entry request with id ${String(entry.id)}`);

			try {
				/*
				 * Get a lock by setting it to 'processing'
				 */
				await this.queue.setStatus(entry.id, 'processing', { oldStatus: startingStatus, by: this.workerID });

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
							return(await processor(this.decodeEntry(entry)));
						} finally {
							if (timeoutTimer) {
								clearTimeout(timeoutTimer);
							}
						}
					})()
				]);
			} catch (error: unknown) {
				if (Errors.IncorrectStateAssertedError.isInstance(error)) {
					logger?.info(`Skipping request with id ${String(entry.id)} because it is no longer in the expected state "${startingStatus}"`, error);

					return(processJobOk);
				}

				logger?.error(`Failed to process request with id ${String(entry.id)}, setting state to "${setEntryStatus.status}":`, error);
				setEntryStatus.status = 'failed_temporarily';
				setEntryStatus.error = String(error);
			}

			if (setEntryStatus.status === 'processing') {
				logger?.error(`Processor for request with id ${String(entry.id)} returned invalid status "processing"`);
				setEntryStatus.status = 'failed_temporarily';
				setEntryStatus.error = 'Processor returned invalid status "processing"';
			}

			let by: KeetaAnchorQueueWorkerID | undefined = this.workerID;
			if (setEntryStatus.status === 'pending') {
				by = undefined;
			}

			await this.queue.setStatus(entry.id, setEntryStatus.status, { oldStatus: 'processing', by: by, output: this.encodeResponse(setEntryStatus.output), error: setEntryStatus.error });

			return(processJobOk);
		};

		/*
		 * Process pending jobs first
		 */
		for (let index = 0; index < batchSize; index++) {
			const entries = await this.queue.query({ status: 'pending', limit: 1 });
			const entry = entries[0];
			if (entry === undefined) {
				retval = false;

				break;
			}

			const result = await processJob(index, entry, 'pending', this.processor.bind(this));
			if (result === processJobTimeout) {
				break;
			}
		}

		/*
		 * Next process any pipes to other runners
		 */
		const pipes = [...this.pipes];
		for (const pipe of pipes) {
			if (pipe.exclusiveTarget === false) {
				continue;
			}

			let remainingTime: number | undefined = undefined;
			if (timeout !== undefined) {
				const elapsed = Date.now() - startTime;
				remainingTime = timeout - elapsed;
				if (remainingTime <= 0) {
					remainingTime = -1;
				}
			}

			const pipeHasMoreWork = await pipe.target.run({
				...options,
				timeoutMs: remainingTime
			});

			if (pipeHasMoreWork) {
				retval = true;
			}
		}

		/**
		 * Process stuck or aborted jobs (if possible)
		 */
		const conditions = [{
			status: 'aborted' as const,
			processor: this.processorAborted?.bind(this)
		}, {
			status: 'stuck' as const,
			processor: this.processorStuck?.bind(this)
		}];

		let timeoutReached = false;
		for (const condition of conditions) {
			if (condition.processor === undefined) {
				continue;
			}
			for (let index = 0; index < batchSize; index++) {
				const entries = await this.queue.query({ status: condition.status, limit: 1 });
				const entry = entries[0];
				if (entry === undefined) {
					break;
				}

				const result = await processJob(index, entry, condition.status, condition.processor);
				if (result === processJobTimeout) {
					timeoutReached = true;
					break;
				}
			}

			if (timeoutReached) {
				break;
			}
		}

		return(retval);
	}

	private async markStuckRequestsAsStuck(): Promise<void> {
		const stuckThreshold = this.processTimeout * this.stuckMultiplier;

		const logger = this.methodLogger('markStuckRequestsAsStuck');
		const now = Date.now();

		const requests = await this.queue.query({ status: 'processing', limit: 100, updatedBefore: new Date(now - stuckThreshold) });
		for (const request of requests) {
			/*
			 * Skip the runner lock entries, they are managed separately
			 */
			if (request.id.toString().startsWith('@runner-lock:9ba756f0-7aa2-41c7-a1ea-b010dc752ae8.worker.')) {
				continue;
			}

			try {
				logger?.warn(`Marking request with id ${String(request.id)} as stuck`);

				await this.queue.setStatus(request.id, 'stuck', { oldStatus: 'processing', by: this.workerID });
			} catch (error: unknown) {
				logger?.error(`Failed to mark request with id ${String(request.id)} as stuck:`, error);
			}
		}
	}

	private async requeueFailedRequests(): Promise<void> {
		const retryDelay = this.retryDelay;
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

	private async moveCompletedToNextStage(statusTarget: KeetaAnchorPipeableQueueStatus): Promise<void> {
		const logger = this.methodLogger('moveCompletedToNextStage');

		const pipes = [...this.pipes].filter(function(pipe) {
			return(pipe.acceptStatus === statusTarget);
		});

		if (pipes.length === 0) {
			return;
		}

		const allRequests = await this.queue.query({ status: statusTarget, limit: 100 });
		let requests = allRequests;

		const RequestSentToPipes = new Map<KeetaAnchorQueueRequestID, number>();
		function IncrRequestSentToPipes(requestID: KeetaAnchorQueueRequestID): void {
			const sentCount = RequestSentToPipes.get(requestID) ?? 0;
			RequestSentToPipes.set(requestID, sentCount + 1);
		}

		const getNextPipeRequestInput = (entry: KeetaAnchorQueueEntry<QueueRequest, QueueResult>) => {
			if (statusTarget === 'completed') {
				return(this.decodeResponse(entry.output));
			} else if (statusTarget === 'failed_permanently') {
				return(this.decodeRequest(entry.request));
			}

			assertNever(statusTarget);
		};

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
				let batchID = ConvertStringToRequestID(crypto.randomUUID());

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

					logger?.debug(`Preparing to move ${statusTarget} requests to next stage ${pipe.target.id} (min=${pipe.minBatchSize}, max=${pipe.maxBatchSize}), have ${requests.length} ${statusTarget} requests available`);

					/**
					 * Compute a batch of entries to send to the next stage,
					 * constrained to the max batch size of the pipe and
					 * the entries which have non-null outputs
					 */
					const batchRaw = requests.map((entry) => {
						return({ output: getNextPipeRequestInput(entry), id: entry.id });
					}).filter(function(entry): entry is { output: UserRequest | UserResult; id: KeetaAnchorQueueRequestID; } {
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
							logger?.debug(`Not enough ${statusTarget} requests to move to next stage ${pipe.target.id}, stopping batch processing`);

							break;
						}

						logger?.debug(`Not moving ${statusTarget} requests to next stage ${pipe.target.id} because batch size ${batchRaw.length} is less than minimum size ${pipe.minBatchSize}`);

						continue;
					}
					sequentialFailureCount = 0;

					/**
					 * The IDs for the entries we are sending to the next stage
					 * target -- this may get reduced if we find there are already
					 * jobs in the next stage that have the idempotentIDs of one of
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

					logger?.debug(`Moving batch of ${batchOutput.length} ${statusTarget} requests to next pipe`, pipe.target.id, '(input entry IDs:', Array.from(batchLocalIDs), '->', `${pipe.target.id}:${String(batchID)})`);

					try {
						// There is no way for typescript to cleanly infer the type here, so we assert it.
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						await pipe.target.add(batchOutput as (UserRequest & UserResult)[], {
							id: batchID,
							/* Use the set of IDs as the idempotent IDs for the batch */
							idempotentKeys: batchLocalIDs
						});

						batchID = ConvertStringToRequestID(crypto.randomUUID());
					} catch (error: unknown) {
						if (Errors.IdempotentExistsError.isInstance(error) && error.idempotentIDsFound) {
							logger?.debug('Some of the jobs have already been added to the target queue, skipping those:', error.idempotentIDsFound.values());
							for (const requestID of error.idempotentIDsFound) {
								iterationTargetSeenRequestIDs.add(requestID);
								allTargetSeenRequestIDs.add(requestID);
							}
						} else {
							/*
							 * If we got some kind of other error adding these
							 * items to the target queue runner, just skip them
							 * and we will retry them on the next iteration
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
						const output = getNextPipeRequestInput(request);

						if (output === null) {
							logger?.debug(`Completed request with id ${String(request.id)} has no output -- next stage will not be run`);
						} else {
							logger?.debug(`Moving ${statusTarget} request with id ${String(request.id)} to next pipe`, pipe.target.id);
							// There is no way for typescript to cleanly infer the type here, so we assert it.
							// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
							await pipe.target.add(output as UserRequest & UserResult, { id: request.id });
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
				logger?.debug(`${statusTarget} request with id ${String(request.id)} was only moved to ${sentCount} out of ${TotalPipes} pipes -- not marking as moved`);
				continue;
			}

			logger?.debug(`Marking ${statusTarget} request with id ${String(request.id)} as moved`);

			await this.queue.setStatus(request.id, 'moved', { oldStatus: statusTarget, by: this.workerID });
		}

	}

	async maintain(): Promise<void> {
		const logger = this.methodLogger('maintain');

		await this.initialize();

		/*
		 * Each worker should maintain its own lock
		 */
		try {
			await this.maintainRunnerLock();
		} catch (error: unknown) {
			logger?.debug('Failed to maintain runner lock:', error);
		}

		if (this.workers.id !== 0) {
			return;
		}

		/*
		 * Only the worker with ID 0 should perform maintenance tasks on requests
		 */
		try {
			await this.markStuckRequestsAsStuck();
		} catch (error: unknown) {
			logger?.debug('Failed to mark stuck requests as stuck:', error);
		}

		try {
			await this.requeueFailedRequests();
		} catch (error: unknown) {
			logger?.debug('Failed to requeue failed requests:', error);
		}

		for (const pipeStatus of keetaAnchorPipeableQueueStatuses) {
			try {
				await this.moveCompletedToNextStage(pipeStatus);
			} catch (error: unknown) {
				logger?.debug(`Failed to move ${pipeStatus} requests to next stage:`, error);
			}
		}

		for (const pipe of this.pipes) {
			try {
				if (pipe.exclusiveTarget === false) {
					continue;
				}

				await pipe.target.maintain();
			} catch (error: unknown) {
				logger?.debug(`Failed to maintain piped runner with ID ${pipe.target.id}:`, error);
			}
		}

		if (this.queue.maintain) {
			try {
				await this.queue.maintain();
			} catch (error: unknown) {
				logger?.debug(`Failed to maintain queue storage driver with ID ${this.queue.id}`, error);
			}
		}
	}

	/**
	 * Pipe the the completed entries of this runner to another runner
	 */
	pipe<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<UserResult, T1, QueueResult, T2>, options?: AdditionalPipeOptions): typeof target {
		this.pipes.push({
			...options,
			isBatchPipe: false,
			target: target,
			acceptStatus: 'completed'
		});
		return(target);
	}

	pipeFailed<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<UserRequest, T1, QueueResult, T2>, options?: AdditionalPipeOptions): typeof target {
		this.pipes.push({
			...options,
			isBatchPipe: false,
			target: target,
			acceptStatus: 'failed_permanently'
		});
		return(target);
	}

	/**
	 * Pipe batches of completed entries from this runner to another runner
	 */
	pipeBatch<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<UserResult[], T1, JSONSerializable, T2>, maxBatchSize = 100, minBatchSize = 1, options?: AdditionalPipeOptions): typeof target {
		this.pipes.push({
			...options,
			isBatchPipe: true,
			target: target,
			minBatchSize: minBatchSize,
			maxBatchSize: maxBatchSize,
			acceptStatus: 'completed'
		});
		return(target);
	}

	pipeBatchFailed<T1, T2 extends JSONSerializable>(target: KeetaAnchorQueueRunner<UserRequest[], T1, JSONSerializable, T2>, maxBatchSize = 100, minBatchSize = 1, options?: AdditionalPipeOptions): typeof target {
		this.pipes.push({
			...options,
			isBatchPipe: true,
			target: target,
			minBatchSize: minBatchSize,
			maxBatchSize: maxBatchSize,
			acceptStatus: 'failed_permanently'
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

/**
 * A KeetaAnchorQueueRunner for use when you want to process already
 * JSON-serializable data without any encoding/decoding needed
 */
export abstract class KeetaAnchorQueueRunnerJSON<UserRequest extends JSONSerializable = JSONSerializable, UserResult extends JSONSerializable = JSONSerializable> extends KeetaAnchorQueueRunner<UserRequest, UserResult, JSONSerializable, JSONSerializable> {
	protected decodeRequest(request: JSONSerializable): UserRequest {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(request as UserRequest);
	}

	protected decodeResponse(response: JSONSerializable | null): UserResult | null {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(response as UserResult | null);
	}

	protected encodeRequest(request: JSONSerializable): JSONSerializable {
		return(request);
	}

	protected encodeResponse(response: JSONSerializable | null): JSONSerializable | null {
		return(response);
	}
}

/**
 * A KeetaAnchorQueueRunnerJSON that takes a processor function
 * in the constructor -- this is mainly useful for testing
 */
export class KeetaAnchorQueueRunnerJSONConfigProc<UserRequest extends JSONSerializable = JSONSerializable, UserResult extends JSONSerializable = JSONSerializable> extends KeetaAnchorQueueRunnerJSON<UserRequest, UserResult> {
	protected readonly processor: KeetaAnchorQueueRunner<UserRequest, UserResult>['processor'];

	constructor(config: ConstructorParameters<typeof KeetaAnchorQueueRunner>[0] & {
		processor: KeetaAnchorQueueRunner<UserRequest, UserResult>['processor'];
		processorStuck?: KeetaAnchorQueueRunner<UserRequest, UserResult>['processorStuck'] | undefined;
		processorAborted?: KeetaAnchorQueueRunner<UserRequest, UserResult>['processorAborted'] | undefined;
	}) {
		super(config);
		this.processor = config.processor;
		if (config.processorStuck) {
			this.processorStuck = config.processorStuck;
		}
		if (config.processorAborted) {
			this.processorAborted = config.processorAborted;
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ignore_static_assert_memory = AssertNever<typeof KeetaAnchorQueueStorageDriverMemory<{ a: string; }, number> extends KeetaAnchorQueueStorageDriverConstructor<{ a: string; }, number> ? never : false>;
