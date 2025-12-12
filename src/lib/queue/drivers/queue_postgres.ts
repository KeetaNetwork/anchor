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
import {
	MethodLogger,
	ManageStatusUpdates
} from '../internal.js';
import { Errors } from '../common.js';

import { asleep } from '../../utils/asleep.js';

import type { Logger } from '../../log/index.ts';
import type { JSONSerializable } from '../../utils/json.js';

import type * as pg from 'pg';

type QueueEntryRow = {
	id: string;
	request: string;
	output: string | null;
	last_error: string | null;
	status: KeetaAnchorQueueStatus;
	created: Date;
	updated: Date;
	worker: number | null;
	failures: number;
};

type IdempotentRow = {
	idempotent_id: string;
};

export default class KeetaAnchorQueueStorageDriverPostgres<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
	private readonly logger: Logger | undefined;
	private poolInternal: (() => Promise<pg.Pool>) | null = null;
	private dbInitialized = false;

	readonly name = 'KeetaAnchorQueueStorageDriverPostgres';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<QueueRequest, QueueResult>>[0]> & { pool: () => Promise<pg.Pool>; }) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger
		this.poolInternal = options.pool;
		this.path = options.path ?? [];
		this.pathStr = ['root', ...this.path].join('.');
		Object.freeze(this.path);

		this.methodLogger('new')?.debug('Initialized Postgres queue storage driver');
	}

	private async initializeDBConnection(pool: pg.Pool): Promise<pg.Pool> {
		if (this.dbInitialized) {
			return(pool);
		}
		this.dbInitialized = true;

		this.methodLogger('initializeDBConnection')?.debug('Initializing DB schema for queue storage driver');

		await pool.query(`
			CREATE TABLE IF NOT EXISTS queue_entries (
				id TEXT NOT NULL,
				path TEXT NOT NULL,
				request TEXT NOT NULL,
				output TEXT,
				last_error TEXT,
				status TEXT NOT NULL,
				created BIGINT NOT NULL,
				updated BIGINT NOT NULL,
				worker BIGINT,
				failures INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (id, path)
			)`);

		await pool.query(`
			CREATE TABLE IF NOT EXISTS queue_idempotent_keys (
				entry_id TEXT NOT NULL,
				idempotent_id TEXT NOT NULL,
				path TEXT NOT NULL,
				UNIQUE (idempotent_id, path),
				PRIMARY KEY (entry_id, idempotent_id, path),
				FOREIGN KEY (entry_id, path) REFERENCES queue_entries(id, path)
			)`);

		await pool.query('CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries(status)');
		await pool.query('CREATE INDEX IF NOT EXISTS idx_queue_entries_updated ON queue_entries(updated)');
		await pool.query('CREATE INDEX IF NOT EXISTS idx_queue_idempotent_keys_idempotent_id ON queue_idempotent_keys(idempotent_id)');

		this.dbInitialized = true;

		return(pool);
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverPostgres',
			file: 'src/lib/queue/drivers/queue_postgres.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
		const logger = this.methodLogger('runWithRetry');

		let lastError: unknown;
		for (let retry = 0; retry < 100; retry++) {
			if (this.poolInternal === null) {
				this.methodLogger('runWithRetry')?.debug('Aborting DB operation retries because the instance was destroyed');

				if (lastError !== undefined) {
					// eslint-disable-next-line @typescript-eslint/only-throw-error
					throw(lastError);
				}
				throw(new Error('Aborting because the instance was destroyed'));
			}

			try {
				return(await fn());
			} catch (error: unknown) {
				lastError = error;

				if (error instanceof Error) {
					const errorCode = 'code' in error ? error.code : null;
					if (errorCode === '40001' || errorCode === '40P01') {
						logger?.debug('Serialization failure or deadlock detected');

						const minBackoff = 100;
						const maxBackoff = 30_000;
						const backoffIntervalSize = Math.min(maxBackoff - minBackoff, (retry + 50) ** 2);
						const backoff = Math.round((Math.random() * backoffIntervalSize)) + minBackoff;

						this.methodLogger('runWithRetry')?.debug(`Retrying DB operation in ${backoff}ms (retry #${retry}) from`, new Error().stack);
						await asleep(backoff);

						continue;
					}
				}

				throw(error);
			}
		}
		throw(lastError);
	}

	private async newDBConnection(): Promise<pg.Pool> {
		if (this.poolInternal === null) {
			throw(new Error('Database connection is not available'));
		}

		return(await this.runWithRetry(async () => {
			if (this.poolInternal === null) {
				throw(new Error('Database connection is not available'));
			}

			this.methodLogger('newDBConnection')?.debug('Getting DB pool');
			const pool = await this.poolInternal();

			return(await this.initializeDBConnection(pool));
		}));
	}

	private async dbTransaction<T>(className: string, fn: (client: pg.PoolClient, logger: Logger | undefined) => Promise<T>): Promise<T> {
		const pool = await this.newDBConnection();
		const logger = this.methodLogger(className);

		const result = await this.runWithRetry(async function() {
			const client = await pool.connect();

			try {
				logger?.debug('Starting DB transaction');
				await client.query('BEGIN');
				logger?.debug('DB transaction started');

				const retval = await fn(client, logger);

				logger?.debug('Committing DB transaction');
				await client.query('COMMIT');
				logger?.debug('DB transaction committed');

				return(retval);
			} catch (error: unknown) {
				try {
					logger?.debug('Rolling back DB transaction due to error:', error);
					await client.query('ROLLBACK');
					logger?.debug('DB transaction rolled back');
				} catch {
					logger?.debug('Error rolling back DB transaction !!');
				}
				throw(error);
			} finally {
				client.release();
			}
		});

		return(result);
	}

	async add(request: KeetaAnchorQueueRequest<QueueRequest>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		return(await this.dbTransaction('add', async (client, logger): Promise<KeetaAnchorQueueRequestID> => {
			let entryID = info?.id;
			if (entryID) {
				const existingEntry = await client.query<{ id: string }>('SELECT id FROM queue_entries WHERE id = $1 AND path = $2', [entryID, this.pathStr]);
				if (existingEntry.rows.length > 0) {
					logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
					return(entryID);
				}
			}

			const idempotentIDs = info?.idempotentKeys;
			if (idempotentIDs) {
				const matchingIdempotentEntries = new Set<KeetaAnchorQueueRequestID>();
				for (const idempotentID of idempotentIDs) {
					const idempotentEntryExists = await client.query<IdempotentRow>(
						'SELECT idempotent_id FROM queue_idempotent_keys WHERE idempotent_id = $1 AND path = $2',
						[idempotentID, this.pathStr]
					);
					if (idempotentEntryExists.rows.length > 0) {
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

			try {
				await client.query(
					`INSERT INTO queue_entries (id, path, request, output, last_error, status, created, updated, worker, failures)
					 VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, NULL, 0)`,
					[entryID, this.pathStr, requestJSON, status, currentTime, currentTime]
				);

				if (idempotentIDs && idempotentIDs.size > 0) {
					for (const idempotentID of idempotentIDs) {
						await client.query('INSERT INTO queue_idempotent_keys (entry_id, path, idempotent_id) VALUES ($1, $2, $3)', [entryID, this.pathStr, idempotentID]);
					}
				}
			} catch (error: unknown) {
				if (error instanceof Error && error.message.includes('duplicate key') && idempotentIDs) {
					throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', idempotentIDs));
				}
				throw(error);
			}

			return(entryID);
		}));
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>): Promise<void> {
		const { oldStatus } = ancillary ?? {};

		return(await this.dbTransaction('setStatus', async (client, logger): Promise<void> => {
			const existingEntry = await client.query<{ status: KeetaAnchorQueueStatus; failures: number; last_error: string | null; output: string | null }>('SELECT status, failures, last_error, output FROM queue_entries WHERE id = $1 AND path = $2', [id, this.pathStr]);
			if (existingEntry.rows.length === 0) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			const currentEntry = existingEntry.rows[0];
			if (!currentEntry) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			const newEntry = ManageStatusUpdates<QueueResult>(id, currentEntry, status, ancillary, logger);
			const currentTime = newEntry.updated.getTime();
			const workerValue = newEntry.worker;
			const newFailures = newEntry.failures ?? currentEntry.failures;
			const newLastError = newEntry.lastError !== undefined ? newEntry.lastError : currentEntry.last_error;
			const newOutput = newEntry.output !== undefined ? JSON.stringify(newEntry.output) : currentEntry.output;

			let updateQuery: string;
			let updateParams: (KeetaAnchorQueueRequestID | string | number | null)[];

			if (oldStatus) {
				updateQuery = `UPDATE queue_entries
				               SET status = $1, updated = $2, worker = $3, failures = $4, last_error = $5, output = $6
				               WHERE id = $7 AND path = $8 AND status = $9`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr, oldStatus];
			} else {
				updateQuery = `UPDATE queue_entries
				               SET status = $1, updated = $2, worker = $3, failures = $4, last_error = $5, output = $6
				               WHERE id = $7 AND path = $8`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr];
			}

			const result = await client.query(updateQuery, updateParams);

			if (oldStatus && result.rowCount === 0) {
				const currentEntry = await client.query<{ status: KeetaAnchorQueueStatus }>('SELECT status FROM queue_entries WHERE id = $1 AND path = $2', [id, this.pathStr]);
				const currentStatus = currentEntry.rows[0]?.status;
				if (currentEntry.rows.length > 0) {
					if (currentStatus === undefined) {
						throw(new Error(`internal error: could not retrieve current status for request with ID ${String(id)}`));
					}
					throw(new Errors.IncorrectStateAssertedError(id, oldStatus, currentStatus));
				} else {
					throw(new Error(`Request with ID ${String(id)} not found`));
				}
			}
		}));
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> {
		return(await this.dbTransaction('get', async (client): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> => {
			const row = await client.query<QueueEntryRow>(
				`SELECT id, request, output, last_error, status, created, updated, worker, failures
				 FROM queue_entries WHERE id = $1 AND path = $2`,
				[id, this.pathStr]
			);

			if (row.rows.length === 0) {
				return(null);
			}

			const entry = row.rows[0];
			if (!entry) {
				return(null);
			}

			const idempotentRows = await client.query<IdempotentRow>(
				'SELECT idempotent_id FROM queue_idempotent_keys WHERE entry_id = $1 AND path = $2',
				[id, this.pathStr]
			);

			const idempotentKeys = idempotentRows.rows.length > 0
				? new Set(idempotentRows.rows.map(function(idempotentRow: IdempotentRow) {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					return(idempotentRow.idempotent_id as unknown as KeetaAnchorQueueRequestID);
				}))
				: undefined;

			return({
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				id: entry.id as unknown as KeetaAnchorQueueRequestID,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				request: JSON.parse(entry.request) as QueueRequest,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				output: entry.output ? JSON.parse(entry.output) as QueueResult : null,
				lastError: entry.last_error,
				status: entry.status,
				created: new Date(Number(entry.created)),
				updated: new Date(Number(entry.updated)),
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				worker: entry.worker as unknown as KeetaAnchorQueueWorkerID | null,
				failures: entry.failures,
				idempotentKeys: idempotentKeys
			});
		}));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> {
		return(await this.dbTransaction('query', async (client, logger): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> => {
			logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

			const conditions: string[] = [];
			const params: (string | number)[] = [];
			let paramIndex = 1;

			conditions.push(`path = $${paramIndex++}`);
			params.push(this.pathStr);

			if (filter?.status) {
				conditions.push(`status = $${paramIndex++}`);
				params.push(filter.status);
			}

			if (filter?.updatedBefore) {
				conditions.push(`updated < $${paramIndex++}`);
				params.push(filter.updatedBefore.getTime());
			}

			let query = 'SELECT id, request, output, last_error, status, created, updated, worker, failures FROM queue_entries';

			if (conditions.length > 0) {
				query += ' WHERE ' + conditions.join(' AND ');
			}

			if (filter?.limit !== undefined) {
				query += ` LIMIT $${paramIndex++}`;
				params.push(filter.limit);
			}

			const rows = await client.query<QueueEntryRow>(query, params);

			const entries: KeetaAnchorQueueEntry<QueueRequest, QueueResult>[] = [];

			for (const row of rows.rows) {
				const idempotentRows = await client.query<IdempotentRow>(
					'SELECT idempotent_id FROM queue_idempotent_keys WHERE entry_id = $1 AND path = $2',
					[row.id, this.pathStr]
				);

				const idempotentKeys = idempotentRows.rows.length > 0
					? new Set(idempotentRows.rows.map(function(idempotentRow: IdempotentRow) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						return(idempotentRow.idempotent_id as unknown as KeetaAnchorQueueRequestID);
					}))
					: undefined;

				entries.push({
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					id: row.id as unknown as KeetaAnchorQueueRequestID,
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					request: JSON.parse(row.request) as QueueRequest,
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					output: row.output ? JSON.parse(row.output) as QueueResult : null,
					lastError: row.last_error,
					status: row.status,
					created: new Date(Number(row.created)),
					updated: new Date(Number(row.updated)),
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					worker: row.worker as unknown as KeetaAnchorQueueWorkerID | null,
					failures: row.failures,
					idempotentKeys: idempotentKeys
				});
			}

			logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', entries.length, 'entries');

			return(entries);
		}));
	}

	async partition(path: string) : Promise<KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult>> {
		this.methodLogger('partition')?.debug(`Creating partitioned queue storage driver for path: ${path}`);

		if (this.poolInternal === null) {
			throw(new Error('Asked to partition but the instance has been destroyed'));
		}

		const retval = new KeetaAnchorQueueStorageDriverPostgres<QueueRequest, QueueResult>({
			id: `${this.id}::${path}`,
			logger: this.logger,
			pool: this.poolInternal,
			path: [...this.path, path]
		});

		return(retval);
	}

	async destroy(): Promise<void> {
		this.methodLogger('destroy')?.debug('Destroying instance');

		this.poolInternal = null;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}
