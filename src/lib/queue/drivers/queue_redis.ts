import { MethodLogger } from '../internal.js';
import type {
	KeetaAnchorQueueStorageDriver,
	KeetaAnchorQueueStorageDriverConstructor,
	KeetaAnchorQueueRequest,
	KeetaAnchorQueueRequestID,
	KeetaAnchorQueueEntry,
	KeetaAnchorQueueEntryExtra,
	KeetaAnchorQueueEntryAncillaryData,
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueFilter,
	KeetaAnchorQueueWorkerID
} from '../index.ts';
import { Errors } from '../common.js';

import type { Logger } from '../../log/index.ts';
import type { JSONSerializable } from '../../utils/json.js';

import type { RedisClientType } from 'redis';

type QueueEntryData = {
	id: string;
	request: string;
	output: string | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: number;
	updated: number;
	worker: number | null;
	failures: number;
	idempotentKeys?: string[];
};

export default class KeetaAnchorQueueStorageDriverRedis<REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
	private readonly logger: Logger | undefined;
	private redisInternal: (() => Promise<RedisClientType>) | null = null;

	readonly name = 'KeetaAnchorQueueStorageDriverRedis';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<REQUEST, RESPONSE>>[0]> & { redis: () => Promise<RedisClientType>; }) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger
		this.redisInternal = options.redis;
		this.path = options.path ?? [];
		this.pathStr = ['root', ...this.path].join('.');
		Object.freeze(this.path);

		this.methodLogger('new')?.debug('Initialized Redis queue storage driver');
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverRedis',
			file: 'src/lib/queue/drivers/queue_redis.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private async getRedis(): Promise<RedisClientType> {
		if (this.redisInternal === null) {
			throw(new Error('Redis connection is not available'));
		}
		return(await this.redisInternal());
	}

	private queueKey(id: KeetaAnchorQueueRequestID): string {
		return(`queue:${this.pathStr}:entry:${String(id)}`);
	}

	private idempotentKey(idempotentID: KeetaAnchorQueueRequestID): string {
		return(`queue:${this.pathStr}:idempotent:${String(idempotentID)}`);
	}

	private indexKey(status?: KeetaAnchorQueueStatus): string {
		if (status) {
			return(`queue:${this.pathStr}:index:${status}`);
		}
		return(`queue:${this.pathStr}:index:all`);
	}

	async add(request: KeetaAnchorQueueRequest<REQUEST>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		const redis = await this.getRedis();
		const logger = this.methodLogger('add');

		let entryID = info?.id;
		if (entryID) {
			const exists = await redis.exists(this.queueKey(entryID));
			if (exists) {
				logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
				return(entryID);
			}
		}

		const idempotentIDs = info?.idempotentKeys;
		if (idempotentIDs) {
			const matchingIdempotentEntries = new Set<KeetaAnchorQueueRequestID>();
			for (const idempotentID of idempotentIDs) {
				const existingEntryID = await redis.get(this.idempotentKey(idempotentID));
				if (existingEntryID) {
					matchingIdempotentEntries.add(idempotentID);
				}
			}

			if (matchingIdempotentEntries.size !== 0) {
				throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', matchingIdempotentEntries));
			}
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		entryID ??= crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;

		logger?.debug(`Enqueuing request with id ${String(entryID)}`);

		const currentTime = Date.now();
		const requestJSON = JSON.stringify(request);

		/**
		 * The status to use for the new entry
		 */
		const status = info?.status ?? 'pending';

		const entryData: QueueEntryData = {
			id: String(entryID),
			request: requestJSON,
			output: null,
			lastError: null,
			status: status,
			created: currentTime,
			updated: currentTime,
			worker: null,
			failures: 0
		};

		if (idempotentIDs && idempotentIDs.size > 0) {
			entryData.idempotentKeys = Array.from(idempotentIDs).map(String);
		}

		if (idempotentIDs && idempotentIDs.size > 0) {
			const idempotentKeysArr = Array.from(idempotentIDs).map(String);
			const luaScript = `
				local entryKey = KEYS[1]
				local pendingIndexKey = KEYS[2]
				local allIndexKey = KEYS[3]
				
				local entryData = ARGV[1]
				local score = ARGV[2]
				local entryId = ARGV[3]
				local numIdempotentKeys = tonumber(ARGV[4])
				
				-- Check if any idempotent keys already exist
				for i = 1, numIdempotentKeys do
					local idempotentKey = ARGV[4 + i]
					if redis.call('EXISTS', idempotentKey) == 1 then
						return redis.error_reply('IDEMPOTENT_EXISTS')
					end
				end
				
				-- Add the entry
				redis.call('SET', entryKey, entryData)
				redis.call('ZADD', pendingIndexKey, score, entryId)
				redis.call('ZADD', allIndexKey, score, entryId)
				
				-- Set idempotent keys
				for i = 1, numIdempotentKeys do
					local idempotentKey = ARGV[4 + i]
					redis.call('SET', idempotentKey, entryId)
				end
				
				return 'OK'
			`;

			const idempotentKeyPairs = idempotentKeysArr.map((idKey) => {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return(this.idempotentKey(idKey as unknown as KeetaAnchorQueueRequestID));
			});

			try {
				await redis.eval(luaScript, {
					keys: [
						this.queueKey(entryID),
						this.indexKey('pending'),
						this.indexKey()
					],
					arguments: [
						JSON.stringify(entryData),
						String(currentTime),
						String(entryID),
						String(idempotentKeysArr.length),
						...idempotentKeyPairs
					]
				});
			} catch (error: unknown) {
				if (error instanceof Error && error.message.includes('IDEMPOTENT_EXISTS')) {
					throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', idempotentIDs));
				}
				throw(error);
			}
		} else {
			const multi = redis.multi();
			multi.set(this.queueKey(entryID), JSON.stringify(entryData));
			multi.zAdd(this.indexKey('pending'), { score: currentTime, value: String(entryID) });
			multi.zAdd(this.indexKey(), { score: currentTime, value: String(entryID) });

			await multi.exec();
		}

		return(entryID);
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>): Promise<void> {
		const { oldStatus, by, output } = ancillary ?? {};
		const redis = await this.getRedis();
		const logger = this.methodLogger('setStatus');

		const entryJSON = await redis.get(this.queueKey(id));
		if (!entryJSON) {
			throw(new Error(`Request with ID ${String(id)} not found`));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const existingEntry = JSON.parse(entryJSON) as QueueEntryData;

		if (oldStatus && existingEntry.status !== oldStatus) {
			throw(new Errors.IncorrectStateAssertedError(id, oldStatus, existingEntry.status));
		}

		logger?.debug(`Setting request with id ${String(id)} status from "${existingEntry.status}" to "${status}"`);

		let newFailures = existingEntry.failures;
		if (status === 'failed_temporarily') {
			newFailures += 1;
			logger?.debug(`Incrementing failure count for request with id ${String(id)} to ${newFailures}`);
		}

		let newLastError = existingEntry.lastError;
		if (status === 'pending' || status === 'completed') {
			logger?.debug(`Clearing last error for request with id ${String(id)}`);
			newLastError = null;
		}

		if (ancillary?.error) {
			newLastError = ancillary.error;
			logger?.debug(`Setting last error for request with id ${String(id)} to:`, ancillary.error);
		}

		const currentTime = Date.now();
		const workerValue = by ?? null;

		let newOutput = existingEntry.output;
		if (output !== undefined) {
			logger?.debug(`Setting output for request with id ${String(id)}:`, output);
			newOutput = output !== null ? JSON.stringify(output) : null;
		}

		const updatedEntry: QueueEntryData = {
			...existingEntry,
			status: status,
			updated: currentTime,
			worker: workerValue,
			failures: newFailures,
			lastError: newLastError,
			output: newOutput
		};

		if (oldStatus) {
			const luaScript = `
				local key = KEYS[1]
				local expectedStatus = ARGV[1]
				local newData = ARGV[2]
				local oldIndexKey = ARGV[3]
				local newIndexKey = ARGV[4]
				local allIndexKey = ARGV[5]
				local entryId = ARGV[6]
				local score = ARGV[7]
				
				local current = redis.call('GET', key)
				if not current then
					return {err = 'NOT_FOUND'}
				end
				
				local currentData = cjson.decode(current)
				if currentData.status ~= expectedStatus then
					return {err = 'STATUS_MISMATCH'}
				end
				
				redis.call('SET', key, newData)
				if oldIndexKey ~= newIndexKey then
					redis.call('ZREM', oldIndexKey, entryId)
				end
				redis.call('ZADD', newIndexKey, score, entryId)
				redis.call('ZADD', allIndexKey, score, entryId)
				
				return {ok = 'OK'}
			`;

			const result = await redis.eval(luaScript, {
				keys: [this.queueKey(id)],
				arguments: [
					oldStatus,
					JSON.stringify(updatedEntry),
					this.indexKey(oldStatus),
					this.indexKey(status),
					this.indexKey(),
					String(id),
					String(currentTime)
				]
			});

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const resultObj = result as { err?: string; ok?: string };
			if (resultObj.err === 'NOT_FOUND') {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}
			if (resultObj.err === 'STATUS_MISMATCH') {
				throw(new Error(`Request with ID ${String(id)} status is not "${oldStatus}", cannot update to "${status}"`));
			}
		} else {
			const multi = redis.multi();
			multi.set(this.queueKey(id), JSON.stringify(updatedEntry));

			if (existingEntry.status !== status) {
				multi.zRem(this.indexKey(existingEntry.status), String(id));
			}
			multi.zAdd(this.indexKey(status), { score: currentTime, value: String(id) });
			multi.zAdd(this.indexKey(), { score: currentTime, value: String(id) });

			await multi.exec();
		}
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null> {
		const redis = await this.getRedis();

		const entryJSON = await redis.get(this.queueKey(id));
		if (!entryJSON) {
			return(null);
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const entryData = JSON.parse(entryJSON) as QueueEntryData;

		const idempotentKeys = entryData.idempotentKeys && entryData.idempotentKeys.length > 0
			? new Set(entryData.idempotentKeys.map(function(key: string) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return(key as unknown as KeetaAnchorQueueRequestID);
			}))
			: undefined;

		return({
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id: entryData.id as unknown as KeetaAnchorQueueRequestID,
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			request: JSON.parse(entryData.request) as REQUEST,
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			output: entryData.output ? JSON.parse(entryData.output) as RESPONSE : null,
			lastError: entryData.lastError,
			status: entryData.status,
			created: new Date(entryData.created),
			updated: new Date(entryData.updated),
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			worker: entryData.worker as unknown as KeetaAnchorQueueWorkerID | null,
			failures: entryData.failures,
			idempotentKeys: idempotentKeys
		});
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]> {
		const redis = await this.getRedis();
		const logger = this.methodLogger('query');

		logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

		let entryIDs: string[];

		if (filter?.status) {
			const count = filter.limit ?? -1;
			const allIDs = await redis.zRange(this.indexKey(filter.status), 0, -1);

			if (filter.updatedBefore) {
				const maxScore = filter.updatedBefore.getTime();
				const filteredIDs: string[] = [];
				for (const entryID of allIDs) {
					const score = await redis.zScore(this.indexKey(filter.status), entryID);
					if (score !== null && score < maxScore) {
						filteredIDs.push(entryID);
					}
				}
				entryIDs = filteredIDs;
			} else {
				entryIDs = allIDs;
			}

			if (count !== -1) {
				entryIDs = entryIDs.slice(0, count);
			}
		} else {
			const count = filter?.limit ?? -1;
			const allIDs = await redis.zRange(this.indexKey(), 0, -1);

			if (filter?.updatedBefore) {
				const maxScore = filter.updatedBefore.getTime();
				const filteredIDs: string[] = [];
				for (const entryID of allIDs) {
					const score = await redis.zScore(this.indexKey(), entryID);
					if (score !== null && score < maxScore) {
						filteredIDs.push(entryID);
					}
				}
				entryIDs = filteredIDs;
			} else {
				entryIDs = allIDs;
			}

			if (count !== -1) {
				entryIDs = entryIDs.slice(0, count);
			}
		}

		const entries: KeetaAnchorQueueEntry<REQUEST, RESPONSE>[] = [];

		for (const entryIDStr of entryIDs) {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const entryID = entryIDStr as unknown as KeetaAnchorQueueRequestID;
			const entry = await this.get(entryID);
			if (entry) {
				entries.push(entry);
			}
		}

		logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', entries.length, 'entries');

		return(entries);
	}

	async partition(path: string) : Promise<KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>> {
		this.methodLogger('partition')?.debug(`Creating partitioned queue storage driver for path: ${path}`);

		if (this.redisInternal === null) {
			throw(new Error('Asked to partition but the instance has been destroyed'));
		}

		const retval = new KeetaAnchorQueueStorageDriverRedis<REQUEST, RESPONSE>({
			id: `${this.id}::${path}`,
			logger: this.logger,
			redis: this.redisInternal,
			path: [...this.path, path]
		});

		return(retval);
	}

	async destroy(): Promise<void> {
		this.methodLogger('destroy')?.debug('Destroying instance');

		this.redisInternal = null;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}
