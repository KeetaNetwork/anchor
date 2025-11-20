import type { BrandedString, Brand } from '../utils/brand.ts';
import type { Logger } from '../log/index.ts';
import type { JSONSerializable } from '../utils/json.ts';
import type { AssertNever } from '../utils/never.ts';

export type KeetaAnchorQueueRequest<REQUEST> = REQUEST;
export type KeetaAnchorQueueRequestID = BrandedString<'KeetaAnchorQueueID'>;
export type KeetaAnchorQueueWorkerID = Brand<number, 'KeetaAnchorQueueWorkerID'>;

export type KeetaAnchorQueueStatus = 'pending' | 'processing' | 'completed' | 'failed_temporarily' | 'failed_permanently' | 'stuck' | 'aborted' | 'moved';
export type KeetaAnchorQueueEntry<REQUEST, RESPONSE> = {
	id: KeetaAnchorQueueRequestID;
	request: KeetaAnchorQueueRequest<REQUEST>;
	output: RESPONSE | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: Date;
	lastUpdate: Date;
	worker: KeetaAnchorQueueWorkerID | null;
	failures: number;
};

export type KeetaAnchorQueueFilter = {
	status?: KeetaAnchorQueueStatus;
	limit?: number;
};

export type KeetaAnchorQueueRunnerOptions = {
	/**
	 * If specified, then multiple workers can be used to process this queue
	 * in parallel by splitting the work among the workers.
	 *
	 * By default, only a single worker will process the queue (count=1, id=0)
	 */
	workers?: {
		count: number;
		id: number;
	}
};

export type KeetaAnchorQueueStorageOptions = {
	logger?: Logger | undefined;
	id?: string | undefined;
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
	add: (request: KeetaAnchorQueueRequest<REQUEST>, id?: KeetaAnchorQueueRequestID) => Promise<KeetaAnchorQueueRequestID>;

	/**
	 * Update the status of an entry in the queue
	 *
	 * If the status is "failed_temporarily", the failure count will be incremented
	 *
	 * @param id The entry ID to update
	 * @param status The new status of the entry
	 * @param ancilary Optional ancillary data for the status update
	 * @returns void
	 */
	setStatus: (id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancilary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>) => Promise<void>;

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
	 * Close the storage driver and release any resources
	 */
	destroy(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * An in-memory implementation of the KeetaAnchorQueueStorageDriver
 */
export class KeetaAnchorQueueStorageDriverMemory<REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
	private queue: KeetaAnchorQueueEntry<REQUEST, RESPONSE>[] = [];
	private logger?: Logger | undefined;
	readonly id: string;

	constructor(options?: KeetaAnchorQueueStorageOptions) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger;
	}

	async add(request: KeetaAnchorQueueRequest<REQUEST>, id?: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueRequestID> {
		if (id) {
			const duplicateID = this.queue.some(function(checkEntry) {
				return(checkEntry.id === id);
			});

			if (duplicateID) {
				this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::enqueue', `Request with id ${String(id)} already exists, ignoring`);

				return(id);
			}
		}

		/*
		 * The ID is a branded string, so we must cast the generated UUID
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		id ??= crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;

		this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::enqueue', `Enqueuing request with id ${String(id)}`);

		this.queue.push({
			id: id,
			request: request,
			output: null,
			lastError: null,
			status: 'pending',
			failures: 0,
			created: new Date(),
			lastUpdate: new Date(),
			worker: null
		});

		return(id);
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancilary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>): Promise<void> {
		const { oldStatus, by, output } = ancilary ?? {};

		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});
		if (!entry) {
			throw(new Error(`Request with ID ${String(id)} not found`));
		}

		if (oldStatus && entry.status !== oldStatus) {
			throw(new Error(`Request with ID ${String(id)} status is not "${oldStatus}", cannot update to "${status}"`));
		}

		this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::setStatus', `Setting request with id ${String(id)} status from "${entry.status}" to "${status}"`);

		/* XXX -- this needs to be replicated in every driver -- is there a better way ? */
		if (status === 'failed_temporarily') {
			entry.failures += 1;
			this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::setStatus', `Incrementing failure count for request with id ${String(id)} to ${entry.failures}`);
		}

		if  (status === 'pending' || status === 'completed') {
			this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::setStatus', `Clearing last error for request with id ${String(id)}`);
			entry.lastError = null;
		}
		/* END OF XXX */

		if (ancilary?.error) {
			entry.lastError = ancilary.error;
			this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::setStatus', `Setting last error for request with id ${String(id)} to:`, ancilary.error);
		}

		entry.status = status;
		entry.lastUpdate = new Date();
		entry.worker = by ?? null;

		if (output !== undefined) {
			this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::setStatus', `Setting output for request with id ${String(id)}:`, output);

			entry.output = output;
		}
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null> {
		const entry = this.queue.find(function(checkEntry) {
			return(checkEntry.id === id);
		});

		if (!entry) {
			return(null);
		}

		return(structuredClone(entry));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]> {
		const queueDuplicate = structuredClone(this.queue);

		const allEntriesInStatus = (function() {
			const filterStatus = filter?.status;
			if (filterStatus) {
				return(queueDuplicate.filter(function(entry) {
					return(entry.status === filterStatus);
				}));
			} else {
				return(queueDuplicate);
			}
		})();

		let retval = allEntriesInStatus;
		if (filter?.limit !== undefined) {
			retval = allEntriesInStatus.slice(0, filter.limit);
		}

		return(retval);
	}

	async destroy(): Promise<void> {
		/* Nothing to do */
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}

export abstract class KeetaAnchorQueueStorageRunner<UREQUEST = unknown, URESPONSE = unknown, REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> {
	private queue: KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>;
	private logger?: Logger | undefined;
	private processor: (entry: KeetaAnchorQueueEntry<UREQUEST, URESPONSE>) => Promise<{ status: KeetaAnchorQueueStatus; output: URESPONSE | null; }>;
	private workers: NonNullable<KeetaAnchorQueueRunnerOptions['workers']>;
	private maxRetries = 5;
	private processTimeout = 300_000; /* 5 minutes */
	private batchSize = 100;
	private workerID: KeetaAnchorQueueWorkerID;
	readonly id: string;

	constructor(config: { queue: KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>; processor: KeetaAnchorQueueStorageRunner<UREQUEST, URESPONSE, REQUEST, RESPONSE>['processor']; } & KeetaAnchorQueueStorageOptions & KeetaAnchorQueueRunnerOptions) {
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
	async add(request: UREQUEST, id?: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueRequestID> {
		const encodedRequest = this.encodeRequest(request);
		const newID = await this.queue.add(encodedRequest, id);
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
	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancilary?: KeetaAnchorQueueEntryAncillaryData<URESPONSE>): Promise<void> {
		let encodedOutput: RESPONSE | null | undefined = undefined;
		if (ancilary?.output !== undefined) {
			encodedOutput = this.encodeResponse(ancilary.output);
		}

		return(await this.queue.setStatus(id, status, {
			...ancilary,
			output: encodedOutput
		}));
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
					this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::run', `Timeout of ${timeout}ms reached after processing ${index} entries`);

					break;
				}
			}

			let setEntryStatus: { status: KeetaAnchorQueueStatus; output: URESPONSE | null; error?: string; } = { status: 'failed_temporarily', output: null };

			this.logger?.debug('KeetaAnchorQueueStorageDriverMemory::run', `Processing entry request with id ${String(entry.id)}`);

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
				this.logger?.error('KeetaAnchorQueueStorageDriverMemory::run', `Failed to process request with id ${String(entry.id)}, setting state to "${setEntryStatus.status}":`, error);
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
		return(retval);
	}

	private async markStuckRequestsAsStuck(): Promise<void> {
		const stuckThreshold = this.processTimeout * 10;

		const now = Date.now();

		const requests = await this.queue.query({ status: 'processing', limit: 100 });
		for (const request of requests) {
			try {
				const lastUpdate = request.lastUpdate.getTime();
				if ((now - lastUpdate) >= stuckThreshold) {
					this.logger?.info('KeetaAnchorQueueStorageDriverMemory::markStuckRequestsAsStuck', `Marking request with id ${String(request.id)} as stuck`);

					await this.queue.setStatus(request.id, 'stuck', { oldStatus: 'processing', by: this.workerID });
				}
			} catch (error: unknown) {
				this.logger?.error('KeetaAnchorQueueStorageDriverMemory::markStuckRequestsAsStuck', `Failed to mark request with id ${String(request.id)} as stuck:`, error);
			}
		}
	}

	private async requeueFailedRequests(): Promise<void> {
		const maxRetries = this.maxRetries;

		const requests = await this.queue.query({ status: 'failed_temporarily', limit: 100 });
		for (const request of requests) {
			try {
				if (request.failures >= maxRetries) {
					this.logger?.info('KeetaAnchorQueueStorageDriverMemory::requeueFailedRequests', `Request with id ${String(request.id)} has exceeded maximum retries, not requeuing -- moving to failed_permanently`);
					await this.queue.setStatus(request.id, 'failed_permanently', { oldStatus: 'failed_temporarily', by: this.workerID });

					continue;
				}

				this.logger?.info('KeetaAnchorQueueStorageDriverMemory::requeueFailedRequests', `Requeuing failed request with id ${String(request.id)}`);

				await this.queue.setStatus(request.id, 'pending', { oldStatus: 'failed_temporarily', by: this.workerID });
			} catch (error: unknown) {
				this.logger?.error('KeetaAnchorQueueStorageDriverMemory::requeueFailedRequests', `Failed to requeue request with id ${String(request.id)}:`, error);
			}
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

		if (this.queue.maintain) {
			try {
				await this.queue.maintain();
			} catch {
				/* Ignore errors, we will try again later */
			}
		}
	}

	async destroy(): Promise<void> {
		/* Nothing to do by deafult */
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.destroy();
	}
}

export class KeetaAnchorQueueStorageRunnerJSON<UREQUEST extends JSONSerializable = JSONSerializable, URESPONSE extends JSONSerializable = JSONSerializable> extends KeetaAnchorQueueStorageRunner<UREQUEST, URESPONSE, JSONSerializable, JSONSerializable> {
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
