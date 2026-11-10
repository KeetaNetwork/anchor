// cspell:ignore autovacuum regclass reloptions
import { suite, test, expect } from 'vitest';
import * as pg from 'pg';
import type { Logger } from '../../log/index.ts';
import { getTestingPostgresConfig } from '../../utils/tests/postgres.js';
import KeetaAnchorQueueStorageDriverPostgres from './queue_postgres.js';

const postgresConfig = getTestingPostgresConfig();

/**
 * The status query() starts every pick from, oldest first
 */
const PickSQL = (table: string): string => {
	return(`SELECT id FROM ${table} WHERE path = 'root' AND status = 'pending' ORDER BY updated, id LIMIT 4`);
};

function randomTablePrefix(): string {
	return(`vacuum_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`);
}

function newPool(): pg.Pool {
	if (postgresConfig === null) {
		throw(new Error('internal error: Postgres configuration not available'));
	}

	return(new pg.Pool({
		host: postgresConfig.host,
		port: postgresConfig.port,
		user: postgresConfig.user,
		password: postgresConfig.password
	}));
}

/**
 * A pool plus a unique table prefix, with every table under that prefix
 * dropped on dispose
 */
async function useTables(): Promise<{ pool: pg.Pool; prefix: string; entries: string; [Symbol.asyncDispose]: () => Promise<void>; }> {
	const pool = newPool();
	const prefix = randomTablePrefix();

	return({
		pool: pool,
		prefix: prefix,
		entries: `${prefix}_entries`,
		[Symbol.asyncDispose]: async function() {
			await pool.query(`DROP TABLE IF EXISTS ${prefix}_idempotent_keys, ${prefix}_entries, ${prefix}_schema_version`);
			await pool.end();
		}
	});
}

/**
 * Create a driver on the given tables and run its initialization
 */
async function initializeDriver(pool: pg.Pool, prefix: string, options?: Partial<ConstructorParameters<typeof KeetaAnchorQueueStorageDriverPostgres>[0]>): Promise<KeetaAnchorQueueStorageDriverPostgres> {
	const queue = new KeetaAnchorQueueStorageDriverPostgres({
		tablePrefix: prefix,
		pool: async function() {
			return(pool);
		},
		...options
	});
	await queue.query({ limit: 1 });

	return(queue);
}

async function storageParameters(pool: pg.Pool, table: string): Promise<{ [name: string]: string }> {
	const result = await pool.query<{ reloptions: string[] | null }>('SELECT reloptions FROM pg_class WHERE oid = to_regclass($1)', [table]);
	const retval: { [name: string]: string } = {};
	for (const option of result.rows[0]?.reloptions ?? []) {
		const separator = option.indexOf('=');
		retval[option.slice(0, separator)] = option.slice(separator + 1);
	}

	return(retval);
}

/**
 * Shared buffers read by one pick, from EXPLAIN (ANALYZE, BUFFERS)
 */
async function pickBuffers(client: pg.PoolClient, table: string): Promise<number> {
	const result = await client.query<{ 'QUERY PLAN': [{ Plan: { 'Shared Hit Blocks': number; 'Shared Read Blocks': number; }; }]; }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${PickSQL(table)}`);
	const plan = result.rows[0]?.['QUERY PLAN'][0].Plan;
	if (plan === undefined) {
		throw(new Error('internal error: EXPLAIN returned no plan'));
	}

	return(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']);
}

suite.skipIf(postgresConfig === null)('Postgres Driver Vacuum Policy', function() {
	test('Applies The Default Vacuum Policy', async function() {
		await using tables = await useTables();
		await using queue = await initializeDriver(tables.pool, tables.prefix);

		expect(queue).toBeDefined();
		expect(await storageParameters(tables.pool, tables.entries)).toEqual({
			vacuum_index_cleanup: 'on',
			autovacuum_vacuum_threshold: '10000',
			autovacuum_vacuum_scale_factor: '0',
			autovacuum_analyze_scale_factor: '0.02'
		});
	});

	test('Leaves The Table Alone When Disabled, And Applies A Policy On Upgrade', async function() {
		await using tables = await useTables();

		/*
		 * A table whose driver does not manage vacuum settings stands
		 * in for one created before the vacuum policy existed
		 */
		await using unmanaged = await initializeDriver(tables.pool, tables.prefix, { vacuumPolicy: false });
		expect(unmanaged).toBeDefined();
		expect(await storageParameters(tables.pool, tables.entries)).toEqual({});

		await using custom = await initializeDriver(tables.pool, tables.prefix, { vacuumPolicy: { vacuumThreshold: 500 }});
		expect(custom).toBeDefined();
		expect(await storageParameters(tables.pool, tables.entries)).toMatchObject({
			vacuum_index_cleanup: 'on',
			autovacuum_vacuum_threshold: '500',
			autovacuum_vacuum_scale_factor: '0'
		});

		/*
		 * A changed policy takes effect on the next initialization
		 */
		await using changed = await initializeDriver(tables.pool, tables.prefix, { vacuumPolicy: { vacuumThreshold: 2000, vacuumScaleFactor: 0.05 }});
		expect(changed).toBeDefined();
		expect(await storageParameters(tables.pool, tables.entries)).toMatchObject({
			autovacuum_vacuum_threshold: '2000',
			autovacuum_vacuum_scale_factor: '0.05'
		});
	});

	test('Rejects Invalid Vacuum Policy Values', function() {
		const pool = async function(): Promise<pg.Pool> {
			throw(new Error('not used'));
		};

		for (const vacuumPolicy of [
			{ vacuumThreshold: -1 },
			{ vacuumThreshold: 1.5 },
			{ vacuumScaleFactor: Number.NaN },
			{ vacuumScaleFactor: 101 },
			{ analyzeScaleFactor: -0.1 }
		]) {
			expect(function() {
				return(new KeetaAnchorQueueStorageDriverPostgres({ pool: pool, vacuumPolicy: vacuumPolicy }));
			}).toThrow(/Invalid/);
		}
	});

	test('Starts Without Vacuum Settings When The Role Does Not Own The Table', async function() {
		await using tables = await useTables();
		await using owner = await initializeDriver(tables.pool, tables.prefix, { vacuumPolicy: false });
		expect(owner).toBeDefined();

		const role = `${tables.prefix}_role`;
		const password = crypto.randomUUID();
		await tables.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
		await using roleCleanup = {
			[Symbol.asyncDispose]: async function() {
				await tables.pool.query(`DROP OWNED BY ${role}`);
				await tables.pool.query(`DROP ROLE ${role}`);
			}
		};
		expect(roleCleanup).toBeDefined();
		await tables.pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
		await tables.pool.query(`GRANT ALL ON ${tables.prefix}_entries, ${tables.prefix}_idempotent_keys, ${tables.prefix}_schema_version TO ${role}`);

		if (postgresConfig === null) {
			throw(new Error('internal error: Postgres configuration not available'));
		}
		const rolePool = new pg.Pool({ host: postgresConfig.host, port: postgresConfig.port, user: role, password: password, database: postgresConfig.user });
		await using rolePoolCleanup = {
			[Symbol.asyncDispose]: async function() {
				await rolePool.end();
			}
		};
		expect(rolePoolCleanup).toBeDefined();

		const warnings: unknown[][] = [];
		const logger = {
			...console,
			debug: function() { /* quiet */ },
			info: function() { /* quiet */ },
			log: function() { /* quiet */ },
			warn: function(...args: unknown[]) {
				warnings.push(args);
			}
		} satisfies Logger;

		await using notOwner = await initializeDriver(rolePool, tables.prefix, { logger: logger });
		await notOwner.add({ key: 'still-works' });

		expect(await notOwner.query({ status: 'pending' })).toHaveLength(1);
		expect(warnings.some(function(args) {
			return(String(args[1] ?? args[0]).includes('Could not set vacuum settings'));
		})).toBe(true);
		expect(await storageParameters(tables.pool, tables.entries)).toEqual({});
	});

	/*
	 * Reproduces the slowdown the policy fixes: draining the oldest
	 * entries leaves dead index entries where every pick starts, and on
	 * a large table a vacuum skips cleaning the index unless
	 * vacuum_index_cleanup is on
	 */
	test('A Vacuum Clears The Dead Index Entries A Drain Leaves', async function() {
		await using tables = await useTables();
		await using queue = await initializeDriver(tables.pool, tables.prefix);
		expect(queue).toBeDefined();

		/*
		 * Drained rows must sit on under 2% of the table's pages,
		 * the share below which a vacuum skips index cleanup unless
		 * vacuum_index_cleanup is on
		 */
		const tableRows = 300_000;
		const drainedRows = 1_500;
		await tables.pool.query(`INSERT INTO ${tables.entries} (id, path, request, status, created, updated)
			SELECT 'job' || n, 'root', '"x"', 'pending', n, n FROM generate_series(1, ${tableRows}) AS n`);
		await tables.pool.query(`VACUUM ANALYZE ${tables.entries}`);

		const client = await tables.pool.connect();
		try {
			const before = await pickBuffers(client, tables.entries);

			/*
			 * Process the oldest entries the way the runner does: to
			 * processing, then to completed
			 */
			for (const status of ['processing', 'completed']) {
				await client.query(`UPDATE ${tables.entries} SET status = $1, updated = updated + ${tableRows * 2} WHERE id IN (SELECT 'job' || n FROM generate_series(1, ${drainedRows}) AS n)`, [status]);
			}

			const afterDrain = await pickBuffers(client, tables.entries);
			expect(afterDrain).toBeGreaterThan(before + 5);

			await client.query(`VACUUM ${tables.entries}`);

			const afterVacuum = await pickBuffers(client, tables.entries);
			expect(afterVacuum).toBeLessThanOrEqual(before + 2);
		} finally {
			client.release();
		}
	}, 60_000);
});
