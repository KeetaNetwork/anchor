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

type ParentRow = {
	parent_id: string;
};

export class KeetaAnchorQueueStorageDriverSQLite3<REQUEST extends JSONSerializable = JSONSerializable, RESPONSE extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE> {
	private readonly logger: Logger | undefined;
	private dbInternal: (() => Promise<sqlite.Database>) | null = null;
	private dbInitialized = false;

	readonly name = 'KeetaAnchorQueueStorageDriverSQLite3';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<REQUEST, RESPONSE>>[0]> & { db: () => Promise<sqlite.Database>; }) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger
		this.dbInternal = options.db;
		this.path = options.path ?? [];
		this.pathStr = ['root', this.path].join('.');
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

		if (this.dbInitialized) {
			return(db);
		}
		this.dbInitialized = true;

		this.methodLogger('initializeDBConnection')?.debug('Initializing DB schema for queue storage driver');
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

			CREATE TABLE IF NOT EXISTS queue_parents (
				entry_id TEXT NOT NULL,
				parent_id TEXT NOT NULL,
				path TEXT NOT NULL,
				UNIQUE (parent_id, path),
				PRIMARY KEY (entry_id, parent_id, path),
				FOREIGN KEY (entry_id, path) REFERENCES queue_entries(id, path)
			);

			CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries(status);
			CREATE INDEX IF NOT EXISTS idx_queue_entries_updated ON queue_entries(updated);
			CREATE INDEX IF NOT EXISTS idx_queue_parents_parent_id ON queue_parents(parent_id);
		`);

		this.dbInitialized = true;

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

	async add(request: KeetaAnchorQueueRequest<REQUEST>, info?: KeetaAnchorQueueEntryExtra): Promise<KeetaAnchorQueueRequestID> {
		return(await this.dbTransaction('add', async (db, logger): Promise<KeetaAnchorQueueRequestID> => {
			let entryID = info?.id;
			if (entryID) {
				const existingEntry = await db.get<{ id: string }>('SELECT id FROM queue_entries WHERE id = ? AND path = ?', entryID, this.pathStr);
				if (existingEntry) {
					logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
					return(entryID);
				}
			}

			const parentIDs = info?.parents;
			if (parentIDs) {
				const matchingParentEntries = new Set<KeetaAnchorQueueRequestID>();
				for (const parentID of parentIDs) {
					const parentEntryExists = await db.get<ParentRow>(
						'SELECT parent_id FROM queue_parents WHERE parent_id = ? AND path = ?',
						parentID, this.pathStr
					);
					if (parentEntryExists) {
						matchingParentEntries.add(parentID);
					}
				}

				if (matchingParentEntries.size !== 0) {
					throw(new Errors.ParentExistsError('One or more parent entries already exist in the queue', matchingParentEntries));
				}
			}

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			entryID ??= crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID;

			logger?.debug(`Enqueuing request with id ${String(entryID)}`);

			const currentTime = Date.now();
			const requestJSON = JSON.stringify(request);

			try {
				await db.run(
					`INSERT INTO queue_entries (id, path, request, output, lastError, status, created, updated, worker, failures)
					 VALUES (?, ?, ?, NULL, NULL, 'pending', ?, ?, NULL, 0)`,
					entryID,
					this.pathStr,
					requestJSON,
					currentTime,
					currentTime
				);

				if (parentIDs && parentIDs.size > 0) {
					for (const parentID of parentIDs) {
						await db.run('INSERT INTO queue_parents (entry_id, path, parent_id) VALUES (?, ?, ?)', entryID, this.pathStr, parentID);
					}
				}
			} catch (error: unknown) {
				if (error instanceof Error && error.message.includes('UNIQUE constraint failed') && parentIDs) {
					throw(new Errors.ParentExistsError('One or more parent entries already exist in the queue', parentIDs));
				}
				throw(error);
			}

			return(entryID);
		}));
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<RESPONSE>): Promise<void> {
		const { oldStatus, by, output } = ancillary ?? {};

		return(await this.dbTransaction('setStatus', async (db, logger): Promise<void> => {
			const existingEntry = await db.get<{ status: KeetaAnchorQueueStatus; failures: number; lastError: string | null; output: string | null }>('SELECT status, failures, lastError, output FROM queue_entries WHERE id = ? AND path = ?', id, this.pathStr);
			if (!existingEntry) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			if (oldStatus && existingEntry.status !== oldStatus) {
				throw(new Error(`Request with ID ${String(id)} status is not "${oldStatus}", cannot update to "${status}"`));
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
					throw(new Error(`Request with ID ${String(id)} status is not "${oldStatus}", cannot update to "${status}"`));
				} else {
					throw(new Error(`Request with ID ${String(id)} not found`));
				}
			}
		}));
	}

	async get(id: KeetaAnchorQueueRequestID): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null> {
		return(await this.dbTransaction('get', async (db): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE> | null> => {
			const row = await db.get<QueueEntryRow>(
				`SELECT id, request, output, lastError, status, created, updated, worker, failures
				 FROM queue_entries WHERE id = ? AND path = ?`,
				id, this.pathStr
			);

			if (!row) {
				return(null);
			}

			const parentRows = await db.all<ParentRow[]>(
				'SELECT parent_id FROM queue_parents WHERE entry_id = ? AND path = ?',
				id, this.pathStr
			);

			const parents = parentRows.length > 0
				? new Set(parentRows.map(function(parentRow: ParentRow) {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					return(parentRow.parent_id as unknown as KeetaAnchorQueueRequestID);
				}))
				: undefined;

			return({
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				id: row.id as unknown as KeetaAnchorQueueRequestID,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				request: JSON.parse(row.request) as REQUEST,
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				output: row.output ? JSON.parse(row.output) as RESPONSE : null,
				lastError: row.lastError,
				status: row.status,
				created: new Date(row.created),
				updated: new Date(row.updated),
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				worker: row.worker as unknown as KeetaAnchorQueueWorkerID | null,
				failures: row.failures,
				parents: parents
			});
		}));
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]> {
		return(await this.dbTransaction('query', async (db, logger): Promise<KeetaAnchorQueueEntry<REQUEST, RESPONSE>[]> => {
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

			const entries: KeetaAnchorQueueEntry<REQUEST, RESPONSE>[] = [];

			for (const row of rows) {
				const parentRows = await db.all<ParentRow[]>(
					'SELECT parent_id FROM queue_parents WHERE entry_id = ? AND path = ?',
					row.id, this.pathStr
				);

				const parents = parentRows.length > 0
					? new Set(parentRows.map(function(parentRow: ParentRow) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						return(parentRow.parent_id as unknown as KeetaAnchorQueueRequestID);
					}))
					: undefined;

				entries.push({
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					id: row.id as unknown as KeetaAnchorQueueRequestID,
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					request: JSON.parse(row.request) as REQUEST,
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					output: row.output ? JSON.parse(row.output) as RESPONSE : null,
					lastError: row.lastError,
					status: row.status,
					created: new Date(row.created),
					updated: new Date(row.updated),
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					worker: row.worker as unknown as KeetaAnchorQueueWorkerID | null,
					failures: row.failures,
					parents: parents
				});
			}

			logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', entries.length, 'entries');

			return(entries);
		}));
	}

	async partition(path: string) : Promise<KeetaAnchorQueueStorageDriver<REQUEST, RESPONSE>> {
		this.methodLogger('partition')?.debug(`Creating partitioned queue storage driver for path: ${path}`);

		if (this.dbInternal === null) {
			throw(new Error('Asked to partition the instance has been destroyed'));
		}

		const retval = new KeetaAnchorQueueStorageDriverSQLite3<REQUEST, RESPONSE>({
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
