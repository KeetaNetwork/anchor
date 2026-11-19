// cspell:ignore TIMESTAMPTZ xact

import type * as pg from 'pg';
import type { Logger } from '../log/index.js';
import type { KeetaAnchorReplayGuard } from './replay-guard.js';

/**
 * Options for {@link PostgresReplayGuard}
 */
export interface PostgresReplayGuardOptions {
	/**
	 * Returns a Postgres connection pool. Every instance of a server must
	 * reach the same database.
	 */
	pool: () => Promise<pg.Pool>;

	/**
	 * Name of the table the guard keeps its claims in. Created, with a
	 * `<tableName>_schema_version` table beside it, when the guard is
	 * first used. Defaults to `replay_guard_claims`.
	 */
	tableName?: string | undefined;

	/**
	 * How often, at most, one instance deletes expired claims, in
	 * milliseconds. Defaults to one minute.
	 */
	sweepIntervalMs?: number | undefined;

	/**
	 * Receives errors from deleting expired claims, which never fail a
	 * claim
	 */
	logger?: Logger | undefined;
}

/**
 * Table names are written into the SQL, so they are limited to plain
 * identifiers short enough that the names built from them, such as
 * `<tableName>_schema_version`, fit the 63 bytes Postgres allows
 */
const TableNamePattern = /^[a-z_][a-z0-9_]{0,47}$/;

/**
 * Key of the advisory lock that instances hold while they bring the
 * tables to the current schema version, one at a time
 */
const SCHEMA_LOCK_ID = 0x5245504C;

/**
 * {@link KeetaAnchorReplayGuard} shared through Postgres, for servers
 * that run several instances behind one URL. A claim inserts its key,
 * or takes over the row of an expired claim, in one statement, so a
 * nonce spent at one instance is refused at every other.
 */
export class PostgresReplayGuard implements KeetaAnchorReplayGuard {
	readonly #pool: PostgresReplayGuardOptions['pool'];
	readonly #tableName: string;
	readonly #sweepIntervalMs: number;
	readonly #logger: Logger | undefined;
	#ready: Promise<pg.Pool> | undefined;
	#lastSweep = 0;

	constructor(options: PostgresReplayGuardOptions) {
		const tableName = options.tableName ?? 'replay_guard_claims';
		if (!TableNamePattern.test(tableName)) {
			throw(new Error(`Invalid tableName ${tableName}: use lowercase letters, digits and underscores, at most 48 characters`));
		}

		this.#pool = options.pool;
		this.#tableName = tableName;
		this.#sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
		this.#logger = options.logger;
	}

	async claim(key: string, expiresAt: Date): Promise<boolean> {
		const pool = await this.#getPool();
		const now = new Date();

		const result = await pool.query(`
			INSERT INTO ${this.#tableName} (key, expires_at) VALUES ($1, $2)
			ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at
			WHERE ${this.#tableName}.expires_at <= $3
			RETURNING key
		`, [ key, expiresAt, now ]);

		const claimed = result.rowCount === 1;

		/* The claim is recorded, so a failed sweep must not fail it */
		try {
			await this.#sweep(pool, now);
		} catch (error: unknown) {
			this.#logger?.error('PostgresReplayGuard::claim', 'Could not delete expired claims:', error);
		}

		return(claimed);
	}

	async #getPool(): Promise<pg.Pool> {
		this.#ready ??= (async () => {
			const pool = await this.#pool();
			const client = await pool.connect();
			try {
				/* Instances starting together migrate the tables one at a time */
				await client.query('BEGIN');
				await client.query('SELECT pg_advisory_xact_lock($1)', [ SCHEMA_LOCK_ID ]);
				await client.query(`
					CREATE TABLE IF NOT EXISTS ${this.#tableName}_schema_version (
						version INTEGER PRIMARY KEY,
						applied_at TIMESTAMPTZ NOT NULL
					)
				`);
				const versionResult = await client.query<{ version: number | null }>(`SELECT MAX(version) AS version FROM ${this.#tableName}_schema_version`);
				const currentVersion = versionResult.rows[0]?.version ?? 0;

				/* Version 1: the claims table and its expiry index */
				if (currentVersion < 1) {
					await client.query(`
						CREATE TABLE ${this.#tableName} (
							key TEXT PRIMARY KEY,
							expires_at TIMESTAMPTZ NOT NULL
						)
					`);
					await client.query(`CREATE INDEX ${this.#tableName}_expires_at ON ${this.#tableName} (expires_at)`);
					await client.query(`INSERT INTO ${this.#tableName}_schema_version (version, applied_at) VALUES (1, now())`);
				}

				await client.query('COMMIT');
			} catch (error: unknown) {
				await client.query('ROLLBACK');
				throw(error);
			} finally {
				client.release();
			}

			return(pool);
		})();

		try {
			return(await this.#ready);
		} catch (error: unknown) {
			/* Try again on the next claim */
			this.#ready = undefined;
			throw(error);
		}
	}

	/**
	 * Delete expired claims, at most once per sweep interval. A claim
	 * never depends on this, since an expired row is taken over in place.
	 */
	async #sweep(pool: pg.Pool, now: Date): Promise<void> {
		if (now.valueOf() - this.#lastSweep < this.#sweepIntervalMs) {
			return;
		}

		this.#lastSweep = now.valueOf();
		await pool.query(`DELETE FROM ${this.#tableName} WHERE expires_at <= $1`, [ now ]);
	}
}
