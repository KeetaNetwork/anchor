// cspell:ignore seqscan autovacuum regclass reloptions SQLSTATE

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
	KeetaAnchorQueueDeleteInput,
	KeetaAnchorQueueWorkerID
} from '../index.ts';
import {
	MethodLogger,
	ManageStatusUpdates,
	ConvertStringToRequestID
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

/**
 * How often Postgres vacuums the queue's entries table.
 *
 * Every status change is an update to a column the queue's indexes are
 * keyed on, so it leaves a dead index entry at the oldest end of the
 * status range the entry left.  That is exactly where the next query()
 * starts reading, so until a vacuum cleans the index each pick reads
 * past every entry processed since the last vacuum.
 */
export type KeetaAnchorQueueStorageDriverPostgresVacuumPolicy = {
	/**
	 * Number of updated or deleted rows that triggers an autovacuum of
	 * the entries table (autovacuum_vacuum_threshold)
	 */
	vacuumThreshold: number;

	/**
	 * Fraction of the table added to `vacuumThreshold`
	 * (autovacuum_vacuum_scale_factor).  The cost of a pick depends on
	 * how many dead entries sit ahead of it, not on the table size, so
	 * the default is 0.
	 */
	vacuumScaleFactor: number;

	/**
	 * Fraction of the table changed that triggers an automatic ANALYZE
	 * (autovacuum_analyze_scale_factor)
	 */
	analyzeScaleFactor: number;
};

const DefaultVacuumPolicy: KeetaAnchorQueueStorageDriverPostgresVacuumPolicy = {
	vacuumThreshold: 10_000,
	vacuumScaleFactor: 0,
	analyzeScaleFactor: 0.02
};

/**
 * Postgres accepts scale factors from 0 to 100
 */
const MaxScaleFactor = 100;

/**
 * The SQLSTATE Postgres returns when the role does not own the table
 */
const InsufficientPrivilegeSQLState = '42501';

/**
 * Check the vacuum policy and build the table storage parameters for it.
 * The values are written into the ALTER TABLE statement (storage
 * parameters cannot be bound), so each one must be a finite number in
 * the range Postgres accepts.
 */
function VacuumPolicyStorageParameters(policy: KeetaAnchorQueueStorageDriverPostgresVacuumPolicy): { [name: string]: string } {
	if (!Number.isSafeInteger(policy.vacuumThreshold) || policy.vacuumThreshold < 0) {
		throw(new Error(`Invalid vacuumThreshold ${String(policy.vacuumThreshold)}: must be a non-negative integer`));
	}

	for (const [name, value] of [['vacuumScaleFactor', policy.vacuumScaleFactor], ['analyzeScaleFactor', policy.analyzeScaleFactor]] as const) {
		if (!Number.isFinite(value) || value < 0 || value > MaxScaleFactor) {
			throw(new Error(`Invalid ${name} ${String(value)}: must be a number from 0 to ${MaxScaleFactor}`));
		}
	}

	return({
		/*
		 * Without this, a vacuum skips cleaning the indexes when
		 * fewer than about 2% of the table's pages hold dead rows,
		 * which is always the case for a drained range of a large
		 * queue, and the dead index entries the pick reads past stay
		 */
		vacuum_index_cleanup: 'on',
		autovacuum_vacuum_threshold: String(policy.vacuumThreshold),
		autovacuum_vacuum_scale_factor: String(policy.vacuumScaleFactor),
		autovacuum_analyze_scale_factor: String(policy.analyzeScaleFactor)
	});
}

type KeetaAnchorQueueStorageDriverPostgresOptions = {
	/**
	 * Function that returns a Postgres connection pool.
	 */
	pool: () => Promise<pg.Pool>;

	/**
	 * The prefix to use for the database tables. Defaults to 'queue',
	 * resulting in table names 'queue_entries', 'queue_idempotent_keys',
	 * and `queue_schema_version`.
	 */
	tablePrefix?: string | undefined;

	/**
	 * Vacuum settings for the entries table, applied each time the
	 * driver initializes.  Any value left out uses the default
	 * ({@link DefaultVacuumPolicy}).  Pass `false` to leave the table's
	 * vacuum settings alone, for example when an operator manages them.
	 */
	vacuumPolicy?: Partial<KeetaAnchorQueueStorageDriverPostgresVacuumPolicy> | false;
};

export default class KeetaAnchorQueueStorageDriverPostgres<QueueRequest extends JSONSerializable = JSONSerializable, QueueResult extends JSONSerializable = JSONSerializable> implements KeetaAnchorQueueStorageDriver<QueueRequest, QueueResult> {
	private readonly logger: Logger | undefined;
	private poolInternal: (() => Promise<pg.Pool>) | null = null;
	private tablePrefix: string | undefined;
	private tableNameEntries: string;
	private tableNameSchemaVersion: string;
	private tableNameIdempotentKeys: string;
	private dbInitializationPromise: Promise<boolean> | null = null;
	private serializationRetryCount = 0;
	private debugForceIndexScan = false;

	readonly name = 'KeetaAnchorQueueStorageDriverPostgres';
	readonly id: string;
	readonly path: string[] = [];
	private readonly pathStr: string;
	private toctouDelay: (() => Promise<void>) | undefined = undefined;
	private readonly vacuumPolicy: Partial<KeetaAnchorQueueStorageDriverPostgresVacuumPolicy> | false;
	private readonly vacuumStorageParameters: { [name: string]: string } | null;

	constructor(options: NonNullable<ConstructorParameters<KeetaAnchorQueueStorageDriverConstructor<QueueRequest, QueueResult>>[0]> & KeetaAnchorQueueStorageDriverPostgresOptions) {
		this.id = options?.id ?? crypto.randomUUID();
		this.logger = options?.logger;
		this.tablePrefix = options?.tablePrefix;
		this.poolInternal = options.pool;
		this.vacuumPolicy = options.vacuumPolicy ?? {};
		this.vacuumStorageParameters = null;
		if (this.vacuumPolicy !== false) {
			this.vacuumStorageParameters = VacuumPolicyStorageParameters({ ...DefaultVacuumPolicy, ...this.vacuumPolicy });
		}
		this.path = options.path ?? [];
		this.pathStr = ['root', ...this.path].join('.');
		Object.freeze(this.path);

		this.tableNameEntries = `${this.tablePrefix ?? 'queue'}_entries`;
		this.tableNameIdempotentKeys = `${this.tablePrefix ?? 'queue'}_idempotent_keys`;
		this.tableNameSchemaVersion = `${this.tablePrefix ?? 'queue'}_schema_version`;

		this.methodLogger('new')?.debug('Initialized Postgres queue storage driver');
	}

	private async initializeDBConnection(pool: pg.Pool): Promise<pg.Pool> {
		const logger = this.methodLogger('initializeDBConnection');

		if (this.dbInitializationPromise !== null) {
			logger?.debug('DB schema initialization already in progress or completed, waiting for it to finish');

			await this.dbInitializationPromise;
			return(pool);
		}

		this.dbInitializationPromise = (async () => {
			logger?.debug('Initializing DB schema for queue storage driver on tables', [this.tableNameEntries, this.tableNameIdempotentKeys]);

			const client = await pool.connect();
			try {
				/*
				 * Random lock key (32-bit integer), to ensure
				 * that multiple instances of this driver
				 * (potentially across different
				 * instances/process) will run the migration
				 * sequentially to avoid multiple concurrent
				 * migrations from competing with each other
				 * and causing delays
				 */
				const lockId = 0x24995E48;
				logger?.debug('Acquiring advisory lock for schema migration');
				await client.query('SELECT pg_advisory_lock($1)', [lockId]);

				try {
					// Create schema version table if it doesn't exist
					await client.query(`
						CREATE TABLE IF NOT EXISTS ${this.tableNameSchemaVersion} (
							version INTEGER NOT NULL,
							applied_at BIGINT NOT NULL,
							PRIMARY KEY (version)
						)`);

					// Check current schema version
					const versionResult = await client.query<{ version: number }>(`SELECT MAX(version) as version FROM ${this.tableNameSchemaVersion}`);
					const currentVersion = versionResult.rows[0]?.version ?? 0;

					logger?.debug(`Current queue schema version: ${currentVersion}`);

					// Version 1: Initial schema
					if (currentVersion < 1) {
						logger?.debug('Applying schema version 1: Initial tables and indexes');

						await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');
						try {
							await client.query(`
								CREATE TABLE IF NOT EXISTS ${this.tableNameEntries} (
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

							await client.query(`
								CREATE TABLE IF NOT EXISTS ${this.tableNameIdempotentKeys} (
									entry_id TEXT NOT NULL,
									idempotent_id TEXT NOT NULL,
									path TEXT NOT NULL,
									UNIQUE (idempotent_id, path),
									PRIMARY KEY (entry_id, idempotent_id, path),
									FOREIGN KEY (entry_id, path) REFERENCES ${this.tableNameEntries}(id, path)
								)`);

							// Old single-column indexes (for pre-version-2 schemas)
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_status ON ${this.tableNameEntries}(status)`);
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_updated ON ${this.tableNameEntries}(updated)`);
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameIdempotentKeys}_idempotent_id ON ${this.tableNameIdempotentKeys}(idempotent_id)`);

							await client.query(`INSERT INTO ${this.tableNameSchemaVersion} (version, applied_at) VALUES (1, $1)`, [Date.now()]);
							await client.query('COMMIT');
							logger?.debug('Applied schema version 1');
						} catch (error) {
							await client.query('ROLLBACK');
							throw(error);
						}
					}

					// Version 2: Partition-aware composite indexes
					if (currentVersion < 2) {
						logger?.debug('Applying schema version 2: Partition-aware composite indexes');

						// Now drop old indexes and record version
						await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');
						try {
							// Create new partition-aware indexes
							logger?.debug('Creating partition-aware indexes...');

							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_path_status ON ${this.tableNameEntries}(path, status)`);
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_path_updated ON ${this.tableNameEntries}(path, updated)`);
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_path_status_updated ON ${this.tableNameEntries}(path, status, updated)`);
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameIdempotentKeys}_path_idempotent_id ON ${this.tableNameIdempotentKeys}(path, idempotent_id)`);

							// Drop old indexes that are now redundant (these will fail gracefully if indexes don't exist)
							logger?.debug('Dropping old single-column indexes...');
							await client.query(`DROP INDEX IF EXISTS idx_${this.tableNameEntries}_status`);
							await client.query(`DROP INDEX IF EXISTS idx_${this.tableNameEntries}_updated`);
							await client.query(`DROP INDEX IF EXISTS idx_${this.tableNameIdempotentKeys}_idempotent_id`);

							await client.query(`INSERT INTO ${this.tableNameSchemaVersion} (version, applied_at) VALUES (2, $1)`, [Date.now()]);
							await client.query('COMMIT');
							logger?.debug('Applied schema version 2');
						} catch (error) {
							await client.query('ROLLBACK');
							throw(error);
						}
					}

					// Version 3: Index that serves the query() order (oldest updated first, ties by id)
					if (currentVersion < 3) {
						logger?.debug('Applying schema version 3: Queue order index');

						await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');
						try {
							/*
							 * This blocks writes to the entries table while
							 * the index builds.  For a large table, an operator
							 * can build it ahead of time with
							 * "CREATE INDEX CONCURRENTLY" under the same name,
							 * and this step then only drops the old index.
							 */
							await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableNameEntries}_path_status_updated_id ON ${this.tableNameEntries}(path, status, updated, id)`);

							/*
							 * The new index serves every query the old one did
							 */
							await client.query(`DROP INDEX IF EXISTS idx_${this.tableNameEntries}_path_status_updated`);

							await client.query(`INSERT INTO ${this.tableNameSchemaVersion} (version, applied_at) VALUES (3, $1)`, [Date.now()]);
							await client.query('COMMIT');
							logger?.debug('Applied schema version 3');
						} catch (error) {
							await client.query('ROLLBACK');
							throw(error);
						}
					}

					logger?.debug('Schema is up to date');

					await this.applyVacuumPolicy(client);
				} finally {
					// Always release the advisory lock
					// Note: Advisory locks are session-based and auto-release on disconnect,
					// but we explicitly unlock for clarity and to avoid holding locks longer than needed
					try {
						logger?.debug('Releasing advisory lock');
						await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
					} catch (unlockError) {
						// Log but don't throw - the lock will be auto-released when connection closes
						logger?.debug('Failed to explicitly release advisory lock (will auto-release on disconnect):', unlockError);
					}
				}
			} finally {
				client.release();
			}

			logger?.debug('Completed DB schema initialization for queue storage driver');

			return(true);
		})();

		await this.dbInitializationPromise;

		return(pool);
	}

	/**
	 * Set the entries table's vacuum storage parameters to the
	 * configured policy.  This runs on every initialization rather than
	 * as a versioned migration, so an upgraded database gets the
	 * settings and a changed policy takes effect.  The table is only
	 * altered when its settings differ.
	 *
	 * Changing storage parameters requires owning the table.  Without
	 * that privilege the queue still works, only more slowly while a
	 * large backlog drains, so a warning is logged and startup goes on.
	 */
	private async applyVacuumPolicy(client: pg.PoolClient): Promise<void> {
		const logger = this.methodLogger('applyVacuumPolicy');
		const wanted = this.vacuumStorageParameters;
		if (wanted === null) {
			logger?.debug('Vacuum policy disabled, leaving the entries table settings alone');
			return;
		}

		const current = await client.query<{ reloptions: string[] | null }>('SELECT reloptions FROM pg_class WHERE oid = to_regclass($1)', [this.tableNameEntries]);
		const currentParameters = new Map<string, string>();
		for (const option of current.rows[0]?.reloptions ?? []) {
			const separator = option.indexOf('=');
			currentParameters.set(option.slice(0, separator), option.slice(separator + 1));
		}

		const differs = Object.entries(wanted).some(function([name, value]) {
			return(currentParameters.get(name) !== value);
		});
		if (!differs) {
			logger?.debug('Entries table vacuum settings are up to date');
			return;
		}

		const assignments = Object.entries(wanted).map(function([name, value]) {
			return(`${name} = ${value}`);
		});

		try {
			await client.query(`ALTER TABLE ${this.tableNameEntries} SET (${assignments.join(', ')})`);
			logger?.debug('Applied entries table vacuum settings:', assignments);
		} catch (error: unknown) {
			if (typeof error === 'object' && error !== null && 'code' in error && error.code === InsufficientPrivilegeSQLState) {
				logger?.warn(`Could not set vacuum settings on ${this.tableNameEntries} (the role does not own it); a large backlog may drain more slowly between vacuums:`, error);
				return;
			}

			throw(error);
		}
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
		for (let retry = 0; retry < 16; retry++) {
			if (this.poolInternal === null) {
				logger?.debug('Aborting DB operation retries because the instance was destroyed');

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

				let detectedRetryableError = false;
				if (error instanceof Error) {
					const errorCode = 'code' in error ? error.code : null;
					if (errorCode === '40001' || errorCode === '40P01') {
						// Track serialization retries for instrumentation
						this.serializationRetryCount++;

						detectedRetryableError = true;
						logger?.debug('Detected retryable error with code', errorCode);
					}
				}

				if (detectedRetryableError) {
					const minBackoff = 100;
					const maxBackoff = 30_000;
					const backoffIntervalSize = Math.min(maxBackoff - minBackoff, (retry + 50) ** 2);
					const backoff = Math.round((Math.random() * backoffIntervalSize)) + minBackoff;

					logger?.debug(`Retrying DB operation in ${backoff}ms (retry #${retry}) from`, new Error().stack);
					await asleep(backoff);

					continue;
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

	private async dbTransaction<T>(className: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
		const pool = await this.newDBConnection();
		const logger = this.methodLogger(className);

		const debugForceIndexScan = this.debugForceIndexScan;

		const result = await this.runWithRetry(async function() {
			const client = await pool.connect();

			try {
				logger?.debug('Starting DB transaction');
				await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');
				logger?.debug('DB transaction started');

				if (debugForceIndexScan) {
					await client.query('SET LOCAL enable_seqscan TO off');
				}

				const retval = await fn(client);

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
		return(await this.dbTransaction('add', async (client): Promise<KeetaAnchorQueueRequestID> => {
			const logger = this.methodLogger('add');
			let entryID = ConvertStringToRequestID(info?.id);
			entryID ??= ConvertStringToRequestID(crypto.randomUUID());

			logger?.debug(`Enqueuing request with id ${String(entryID)}`);

			const currentTime = Date.now();
			const requestJSON = JSON.stringify(request);

			/**
			 * The status to use for the new entry
			 */
			const status = info?.status ?? 'pending';


			const insertedEntry = await client.query<{ id: string }>(`
				INSERT INTO ${this.tableNameEntries} (
					id, path, request, output, last_error, status,
					created, updated, worker, failures
				) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, NULL, 0)
				ON CONFLICT (id, path) DO NOTHING
				RETURNING id`,
			[entryID, this.pathStr, requestJSON, status, currentTime, currentTime]);

			if (insertedEntry.rows.length === 0) {
				logger?.debug(`Request with id ${String(entryID)} already exists, ignoring`);
				return(entryID);
			}

			await this.toctouDelay?.();

			const idempotentIDs = info?.idempotentKeys;
			if (idempotentIDs && idempotentIDs.size > 0) {
				const keys = Array.from(idempotentIDs);

				const insertedKeys = await client.query<{ idempotent_id: string }>(`
					INSERT INTO ${this.tableNameIdempotentKeys}(entry_id, path, idempotent_id)
					SELECT $1, $2, unnest($3::text[])
					ON CONFLICT (idempotent_id, path) DO NOTHING
					RETURNING idempotent_id`,
				[entryID, this.pathStr, keys]);

				const foundKeySet = new Set(keys);
				for (const row of insertedKeys.rows) {
					foundKeySet.delete(ConvertStringToRequestID(row.idempotent_id));
				}

				if (insertedKeys.rows.length !== keys.length) {
					throw(new Errors.IdempotentExistsError('One or more idempotent entries already exist in the queue', foundKeySet));
				}

				await this.toctouDelay?.();
			}

			return(entryID);
		}));
	}

	async setStatus(id: KeetaAnchorQueueRequestID, status: KeetaAnchorQueueStatus, ancillary?: KeetaAnchorQueueEntryAncillaryData<QueueResult>): Promise<void> {
		const { oldStatus } = ancillary ?? {};

		return(await this.dbTransaction('setStatus', async (client): Promise<void> => {
			const logger = this.methodLogger('setStatus');
			const existingEntry = await client.query<{ status: KeetaAnchorQueueStatus; failures: number; last_error: string | null; output: string | null }>(`SELECT status, failures, last_error, output FROM ${this.tableNameEntries} WHERE id = $1 AND path = $2 FOR UPDATE`, [id, this.pathStr]);
			if (existingEntry.rows.length === 0) {
				throw(new Error(`Request with ID ${String(id)} not found`));
			}

			await this.toctouDelay?.();

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
				updateQuery = `UPDATE ${this.tableNameEntries}
				               SET status = $1, updated = $2, worker = $3, failures = $4, last_error = $5, output = $6
				               WHERE id = $7 AND path = $8 AND status = $9`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr, oldStatus];
			} else {
				updateQuery = `UPDATE ${this.tableNameEntries}
				               SET status = $1, updated = $2, worker = $3, failures = $4, last_error = $5, output = $6
				               WHERE id = $7 AND path = $8`;
				updateParams = [status, currentTime, workerValue, newFailures, newLastError, newOutput, id, this.pathStr];
			}

			const result = await client.query(updateQuery, updateParams);

			await this.toctouDelay?.();

			if (oldStatus && result.rowCount === 0) {
				const currentEntry = await client.query<{ status: KeetaAnchorQueueStatus }>(`SELECT status FROM ${this.tableNameEntries} WHERE id = $1 AND path = $2`, [id, this.pathStr]);
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
				 FROM ${this.tableNameEntries} WHERE id = $1 AND path = $2`,
				[id, this.pathStr]
			);

			if (row.rows.length === 0) {
				return(null);
			}

			const entry = row.rows[0];
			if (!entry) {
				return(null);
			}

			return(await this.decodeEntryRow(client, entry));
		}));
	}

	/**
	 * Turn an entries row into a queue entry, with its idempotent keys
	 */
	private async decodeEntryRow(client: pg.PoolClient, row: QueueEntryRow): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>> {
		const idempotentRows = await client.query<IdempotentRow>(
			`SELECT idempotent_id FROM ${this.tableNameIdempotentKeys} WHERE entry_id = $1 AND path = $2`,
			[row.id, this.pathStr]
		);

		let idempotentKeys: Set<KeetaAnchorQueueRequestID> | undefined = undefined;
		if (idempotentRows.rows.length > 0) {
			idempotentKeys = new Set(idempotentRows.rows.map(function(idempotentRow: IdempotentRow) {
				return(ConvertStringToRequestID(idempotentRow.idempotent_id));
			}));
		}

		return({
			id: ConvertStringToRequestID(row.id),
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

	/**
	 * Move the oldest entry in a status to "processing" in one statement.
	 *
	 * The inner SELECT locks its row with SKIP LOCKED, so concurrent
	 * claims take different entries.  Postgres locks rows below the
	 * LIMIT, so a row that left the status after the statement started
	 * is re-checked and passed over, and the scan moves on to the next
	 * one.  The entry is returned as it was before the claim.
	 */
	async claimNext(status: KeetaAnchorQueueStatus, worker: KeetaAnchorQueueWorkerID): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> {
		return(await this.dbTransaction('claimNext', async (client): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult> | null> => {
			const result = await client.query<QueueEntryRow>(
				`UPDATE ${this.tableNameEntries} AS e
				 SET status = 'processing', updated = $3, worker = $4
				 FROM (
					SELECT id, path, status, updated, worker FROM ${this.tableNameEntries}
					WHERE path = $1 AND status = $2
					ORDER BY updated, id
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				 ) AS previous
				 WHERE e.id = previous.id AND e.path = previous.path
				 RETURNING e.id, e.request, e.output, e.last_error, previous.status, e.created, previous.updated, previous.worker, e.failures`,
				[this.pathStr, status, Date.now(), worker]
			);

			const row = result.rows[0];
			if (row === undefined) {
				return(null);
			}

			this.methodLogger('claimNext')?.debug(`Claimed request with id ${row.id} from status "${status}" for worker`, worker);

			return(await this.decodeEntryRow(client, row));
		}));
	}

	/**
	 * Build the SQL for {@link query}, ordered as the storage driver
	 * contract requires (oldest updated first, ties by id) so that the
	 * (path, status, updated, id) index serves both the filter and the
	 * order
	 */
	private buildQuerySQL(filter?: KeetaAnchorQueueFilter): { text: string; params: (string | number)[]; } {
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

		let text = `SELECT id, request, output, last_error, status, created, updated, worker, failures FROM ${this.tableNameEntries}`;
		text += ' WHERE ' + conditions.join(' AND ');
		text += ' ORDER BY updated, id';

		if (filter?.limit !== undefined) {
			text += ` LIMIT $${paramIndex++}`;
			params.push(filter.limit);
		}

		return({ text: text, params: params });
	}

	async query(filter?: KeetaAnchorQueueFilter): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> {
		return(await this.dbTransaction('query', async (client): Promise<KeetaAnchorQueueEntry<QueueRequest, QueueResult>[]> => {
			const logger = this.methodLogger('query');
			logger?.debug(`Querying queue with id ${this.id} with filter:`, filter);

			const { text, params } = this.buildQuerySQL(filter);
			const rows = await client.query<QueueEntryRow>(text, params);

			const entries: KeetaAnchorQueueEntry<QueueRequest, QueueResult>[] = [];

			for (const row of rows.rows) {
				entries.push(await this.decodeEntryRow(client, row));
			}

			logger?.debug(`Queried queue with id ${this.id} with filter:`, filter, '-- found', entries.length, 'entries');

			return(entries);
		}));
	}

	async delete(input: KeetaAnchorQueueDeleteInput[]): Promise<void> {
		if (input.length === 0) {
			return;
		}

		await this.dbTransaction('delete', async (client): Promise<void> => {
			const logger = this.methodLogger('delete');
			const ids = input.map(function(entry) {
				return(String(entry.id));
			});
			const statuses = input.map(function(entry) {
				return(entry.status);
			});

			const deletedRows = await client.query<{ id: string }>(
				`WITH targets(id, status) AS (
					SELECT * FROM unnest($2::text[], $3::text[])
				),
				deleted_idempotent AS (
					DELETE FROM ${this.tableNameIdempotentKeys} k
					USING ${this.tableNameEntries} e, targets t
					WHERE k.path = $1 AND k.entry_id = e.id AND e.path = $1
						AND e.id = t.id AND e.status = t.status
				)
				DELETE FROM ${this.tableNameEntries} e
				USING targets t
				WHERE e.path = $1 AND e.id = t.id AND e.status = t.status
				RETURNING e.id`,
				[this.pathStr, ids, statuses]
			);

			const deleted = deletedRows.rowCount ?? 0;
			if (deleted > 0) {
				logger?.debug(`Deleted ${deleted} entries from queue ${this.id}`);
			}
		});
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
			path: [...this.path, path],
			tablePrefix: this.tablePrefix,
			vacuumPolicy: this.vacuumPolicy
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

	/** @internal */
	_Testing(key: string): {
		setToctouDelay(delay: number): void;
		unsetToctouDelay(): void;
		getSerializationRetryCount(): number;
		resetSerializationRetryCount(): void;
		enableDebugForceIndexScan(): void;
		disableDebugForceIndexScan(): void;
		explainQuery(filter?: KeetaAnchorQueueFilter): Promise<string>;
	} {
		if (key !== 'bc81abf8-e43b-490b-b486-744fb49a5082') {
			throw(new Error('This is a testing only method'));
		}

		return({
			setToctouDelay: (delay: number): void => {
				this.toctouDelay = async (): Promise<void> => {
					return(await asleep(delay));
				};
			},
			unsetToctouDelay: (): void => {
				this.toctouDelay = undefined;
			},
			getSerializationRetryCount: (): number => {
				return(this.serializationRetryCount);
			},
			resetSerializationRetryCount: (): void => {
				this.serializationRetryCount = 0;
			},
			enableDebugForceIndexScan: (): void => {
				this.debugForceIndexScan = true;
			},
			disableDebugForceIndexScan: (): void => {
				this.debugForceIndexScan = false;
			},
			explainQuery: async (filter?: KeetaAnchorQueueFilter): Promise<string> => {
				return(await this.dbTransaction('explainQuery', async (client): Promise<string> => {
					const { text, params } = this.buildQuerySQL(filter);
					const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, params);
					return(plan.rows.map(function(row) {
						return(row['QUERY PLAN']);
					}).join('\n'));
				}));
			}
		});
	}
}
