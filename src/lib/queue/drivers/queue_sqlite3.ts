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

import type * as sqlite from 'sqlite';

type QueueEntryRow = {
	id: string;
	request: string;
	output: string | null;
	lastError: string | null;
	status: KeetaAnchorQueueStatus;
	created: number;
	updated: number;
	worker: number | null;
	failures: number;
};

type IdempotentRow = {
	idempotent_id: string;
};

export default class KeetaAnchorQueueStorageDriverSQLite3<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
	private readonly logger: Logger | undefined;
	private dbInternal: (() => Promise<sqlite.Database>) | null = null;
	private dbInitializationPromise?: Promise<boolean>;

	readonly name = 'KeetaAnchorQueueStorageDriverSQLite3';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<QueueRequest, QueueResult>>[0]> & { db: () => Promise<sqlite.Database>; }) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger;
		this.dbInternal = options.db;
		this.path = options.path ?? [];
		this.pathStr = ['root', ...this.path].join('.');
		Object.freeze(this.path);

		this.methodLogger('new')?.debug('Initialized SQLite3 queue storage driver with DB:', options.db);
	}

	private async initializeDBConnection(db: sqlite.Database): Promise<sqlite.Database> {
		this.methodLogger('initializeDBConnection')?.debug('Setting DB connection parameters (WAL mode, synchronous=normal)');
		await db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
		`);

		db.configure('busyTimeout', 100);

		if (this.dbInitializationPromise) {
			await this.dbInitializationPromise;
			return(db);
		}

		this.methodLogger('initializeDBConnection')?.debug('Initializing DB schema for queue storage driver');
		this.dbInitializationPromise = (async function() {
			await db.exec(`
				CREATE TABLE IF NOT EXISTS queue_entries (
					id TEXT NOT NULL,
					path TEXT NOT NULL,
					request TEXT NOT NULL,
					output TEXT,
					lastError TEXT,
					status TEXT NOT NULL,
					created INTEGER NOT NULL,
					updated INTEGER NOT NULL,
					worker INTEGER,
					failures INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (id, path)
				);

				CREATE TABLE IF NOT EXISTS queue_idempotent_keys (
					entry_id TEXT NOT NULL,
					idempotent_id TEXT NOT NULL,
					path TEXT NOT NULL,
					UNIQUE (idempotent_id, path),
					PRIMARY KEY (entry_id, idempotent_id, path),
					FOREIGN KEY (entry_id, path) REFERENCES queue_entries(id, path)
				);

				CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries(status);
				CREATE INDEX IF NOT EXISTS idx_queue_entries_updated ON queue_entries(updated);
				CREATE INDEX IF NOT EXISTS idx_queue_idempotent_keys_idempotent_id ON queue_idempotent_keys(idempotent_id);
			`);

			return(true);
		})();

		await this.dbInitializationPromise;

		return(db);
	}

	private methodLogger(method: string): Logger | undefined {
		return(MethodLogger(this.logger, {
			class: 'KeetaAnchorQueueStorageDriverSQLite3',
			file: 'src/lib/queue/drivers/queue_sqlite3.ts',
			method: method,
			instanceID: this.id
		}));
	}

	private async runWithBusyHandler<T>(fn: () => Promise<T>): Promise<T> {
		const logger = this.methodLogger('runWithBusyHandler');

		let lastError: unknown;
		for (let retry = 0; retry < 100; retry++) {
			if (this.dbInternal === null) {
				this.methodLogger('runWithBusyHandler')?.debug('Aborting DB operation retries because the instance was destroyed');

				if (lastError !== undefined) {
					/*
					 * TypeScript does not know what the error is, but it's whatever we caught,
					 * so it must be something our caller expects
					 */
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
					if (error.message.includes('SQLITE_BUSY') || error.message.includes('SQLITE_LOCKED')) {
						logger?.debug('Database is busy or locked');

						const minBackoff = 100;
						const maxBackoff = 30_000;
						const backoffIntervalSize = Math.min(maxBackoff - minBackoff, (retry + 50) ** 2);
						const backoff = Math.round((Math.random() * backoffIntervalSize)) + minBackoff;

						this.methodLogger('runWithBusyHandler')?.debug(`Retrying DB operation in ${backoff}ms (retry #${retry}) (interval size: ${backoffIntervalSize}ms, min: ${minBackoff}ms, max: ${maxBackoff}ms) from`, new Error().stack);
						await asleep(backoff);

						continue;
					}
				}

				throw(error);
			}
		}
		throw(lastError);
	}

	private newDBConnection(): Promise<{ db: sqlite.Database; [Symbol.asyncDispose]: () => Promise<void>; }> {
		if (this.dbInternal === null) {
			throw(new Error('Database connection is not available'));
		}

		return((async () => {
			return(await this.runWithBusyHandler(async () => {
				if (this.dbInternal === null) {
					throw(new Error('Database connection is not available'));
				}

				this.methodLogger('newDBConnection')?.debug('Opening new DB connection');
				const db = await this.dbInternal();

				return({
					db: await this.initializeDBConnection(db),
					[Symbol.asyncDispose]: async (): Promise<void> => {
						this.methodLogger('dbConnectionDispose')?.debug('Closing DB connection');
						await db.close();
					}
				});
			}));
		})());
	}

	private async dbTransaction<T>(className: string, fn: (db: sqlite.Database, logger: Logger | undefined) => Promise<T>): Promise<T> {
		await using dbConnection = await this.newDBConnection();
		const db = dbConnection.db;
		const logger = this.methodLogger(className);

		const result = await this.runWithBusyHandler(async function() {
			logger?.debug('Starting DB transaction');
			await db.run('BEGIN TRANSACTION');
			logger?.debug('DB transaction started');

			try {
				const retval = await fn(db, logger);

				logger?.debug('Committing DB transaction');
				await db.run('COMMIT');
				logger?.debug('DB transaction committed');

				return(retval);
			} catch (error: unknown) {
				try {
					logger?.debug('Rolling back DB transaction due to error:', error);
					await db.run('ROLLBACK');
					logger?.debug('DB transaction rolled back');
				} catch {
					logger?.debug('Error rolling back DB transaction !!');
					/* Ignore rollback errors */
				}
				throw(error);
			}
		});

		return(result);
	}

	async add(request: KeetaAnchorQueueRequest<QueueRequest>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		return(await this.dbTransaction('add', async (db, logger): Promise<KeetaAnchorQueueRequestID> => {
			let entryID = info?.id;
			if (entryID) {
				const existingEntry = await db.get<{ id: string }>('SELECT id FROM queue_entries WHERE id = ? AND path = ?', entryID, this.pathStr);
				if (existingEntry) {
					logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
					return(entryID);
				}
			}

			const idempotentIDs = info?.idempotentKeys;
			if (idempotentIDs) {
				const matchingIdempotentEntries = new Set<KeetaAnchorQueueRequestID>();
				for (const idempotentID of idempotentIDs) {
					const idempotentEntryExists = await db.get<IdempotentRow>(
						'SELECT idempotent_id FROM queue_idempotent_keys WHERE idempotent_id = ? AND path = ?',
						idempotentID, this.pathStr
					);
					if (idempotentEntryExists) {
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
				await db.run(
					`INSERT INTO queue_entries (id, path, request, output, lastError, status, created, updated, worker, failures)
					 VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, 0)`,
					entryID,
					this.pathStr,
					requestJSON,
					status,
					currentTime,
					currentTime
				);

				if (idempotentIDs && idempotentIDs.size > 0) {
					for (const idempotentID of idempotentIDs) {
						await db.run('INSERT INTO queue_idempotent_keys (entry_id, path, idempotent_id) VALUES (?, ?, ?)', entryID, this.pathStr, idempotentID);
					}
				}
			} catch (error: unknown) {
				if (error instanceof Error && error.message.includes('UNIQUE constraint failed') && idempotentIDs) {
					throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', idempotentIDs));
				}
				throw(error);
			}

			return(entryID);
		}));
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>): Promise<void> {
		return(await this.dbTransaction('setStatus', async (db, logger): Promise<void> => {
			const existingEntry = await db.get<{ status: KeetaAnchorQueueStatus; failures: number; lastError: string | null; output: string | null }>('SELECT status, failures, lastError, output FROM queue_entries WHERE id = ? AND path = ?', id, this.pathStr);
			if (!existingEntry) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			const changedData = ManageStatusUpdates<QueueResult>(id, {
				status: existingEntry.status,
				failures: existingEntry.failures
			}, status, ancillary, logger);

			const newEntry = {
				...existingEntry,
				...changedData
			};

			const oldStatus = ancillary?.oldStatus;
			const currentTime = newEntry.updated?.getTime();
			const workerValue = newEntry.worker;
			const newFailures = newEntry.failures;
			const newLastError = newEntry.lastError !== undefined ? newEntry.lastError : existingEntry.lastError;
			const newOutput = newEntry.output !== undefined ? JSON.stringify(newEntry.output) : null;

			if (currentTime === undefined || workerValue === undefined || newFailures === undefined) {
				throw(new Error('Internal error: Missing updated data for status update'));
			}

			let updateQuery: string;
			let updateParams: (KeetaAnchorQueueRequestID | string | number | null)[];

			if (oldStatus) {
				updateQuery = `UPDATE queue_entries
				               SET status = ?, updated = ?, worker = ?, failures = ?, lastError = ?, output = ?
				               WHERE id = ? AND path = ? AND status = ?`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr, oldStatus];
			} else {
				updateQuery = `UPDATE queue_entries
				               SET status = ?, updated = ?, worker = ?, failures = ?, lastError = ?, output = ?
				               WHERE id = ? AND path = ?`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr];
			}

			const result = await db.run(updateQuery, ...updateParams);

			if (oldStatus && result.changes === 0) {
				const currentEntry = await db.get<{ status: KeetaAnchorQueueStatus }>('SELECT status FROM queue_entries WHERE id = ? AND path = ?', id, this.pathStr);
				if (currentEntry) {
					throw(new Errors.IncorrectStateAssertedError(id, oldStatus, currentEntry.status));
				} else {
					throw(new Error(`Request with ID ${String(id)} not found`));
				}
			}
		}));
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> {
		return(await this.dbTransaction('get', async (db): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> => {
			const row = await db.get<QueueEntryRow>(
				`SELECT id, request, output, lastError, status, created, updated, worker, failures
				 FROM queue_entries WHERE id = ? AND path = ?`,
				id, this.pathStr
			);

			if (!row) {
				return(null);
			}

			const idempotentRows = await db.all<IdempotentRow[]>(
				'SELECT idempotent_id FROM queue_idempotent_keys WHERE entry_id = ? AND path = ?',
				id, this.pathStr
			);

			const idempotentKeys = idempotentRows.length > 0
				? new Set(idempotentRows.map(function(idempotentRow: IdempotentRow) {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					return(idempotentRow.idempotent_id as unknown as KeetaAnchorQueueRequestID);
				}))
				: undefined;

			return({
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				id: row.id as unknown as KeetaAnchorQueueRequestID,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				request: JSON.parse(row.request) as QueueRequest,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				output: row.output ? JSON.parse(row.output) as QueueResult : null,
				lastError: row.lastError,
				status: row.status,
				created: new Date(row.created),
				updated: new Date(row.updated),
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				worker: row.worker as unknown as KeetaAnchorQueueWorkerID | null,
				failures: row.failures,
				idempotentKeys: idempotentKeys
			});
		}));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> {
		return(await this.dbTransaction('query', async (db, logger): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> => {
			logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

			const conditions: string[] = [];
			const params: (string | number)[] = [];

			conditions.push('path = ?');
			params.push(this.pathStr);

			if (filter?.status) {
				conditions.push('status = ?');
				params.push(filter.status);
			}

			if (filter?.updatedBefore) {
				conditions.push('updated < ?');
				params.push(filter.updatedBefore.getTime());
			}

			let query = 'SELECT id, request, output, lastError, status, created, updated, worker, failures FROM queue_entries';

			if (conditions.length > 0) {
				query += ' WHERE ' + conditions.join(' AND ');
			}

			if (filter?.limit !== undefined) {
				query += ' LIMIT ?';
				params.push(filter.limit);
			}

			const rows = await db.all<QueueEntryRow[]>(query, ...params);

			const entries: KeetaAnchorQueueEntry<QueueRequest, QueueResult>[] = [];

			for (const row of rows) {
				const idempotentRows = await db.all<IdempotentRow[]>(
					'SELECT idempotent_id FROM queue_idempotent_keys WHERE entry_id = ? AND path = ?',
					row.id, this.pathStr
				);

				const idempotentKeys = idempotentRows.length > 0
					? new Set(idempotentRows.map(function(idempotentRow: IdempotentRow) {
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
					lastError: row.lastError,
					status: row.status,
					created: new Date(row.created),
					updated: new Date(row.updated),
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

		if (this.dbInternal === null) {
			throw(new Error('Asked to partition the instance, but the instance has been destroyed'));
		}

		const retval = new KeetaAnchorQueueStorageDriverSQLite3<QueueRequest, QueueResult>({
			id: `${this.id}::${path}`,
			logger: this.logger,
			db: this.dbInternal,
			path: [...this.path, path]
		});

		return(retval);
	}

	async destroy(): Promise<void> {
		this.methodLogger('destroy')?.debug('Destroying instance');

		this.dbInternal = null;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		return(await this.destroy());
	}
}
