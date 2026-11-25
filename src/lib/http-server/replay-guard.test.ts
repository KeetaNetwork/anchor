// cspell:ignore plpgsql

import { describe, expect, test } from 'vitest';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import * as pg from 'pg';
import type { Logger } from '../log/index.js';
import type { KeetaAnchorReplayGuard } from './replay-guard.js';
import { MemoryReplayGuard } from './replay-guard.js';
import { RedisReplayGuard } from './replay-guard-redis.js';
import { PostgresReplayGuard } from './replay-guard-postgres.js';
import { getTestingRedisConfig } from '../utils/tests/redis.js';
import { getTestingPostgresConfig } from '../utils/tests/postgres.js';

test('MemoryReplayGuard accepts a key once until its claim expires', async function() {
	const guard = new MemoryReplayGuard();
	const future = new Date(Date.now() + 60_000);

	expect(await guard.claim('a', future)).toBe(true);
	expect(await guard.claim('a', future)).toBe(false);
	expect(await guard.claim('b', future)).toBe(true);

	const past = new Date(Date.now() - 1);
	expect(await guard.claim('c', past)).toBe(true);
	expect(await guard.claim('c', future)).toBe(true);
});

test('MemoryReplayGuard refuses new claims while it is full of live ones, and never forgets a live claim', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 2 });
	const future = new Date(Date.now() + 60_000);

	expect(await guard.claim('first', future)).toBe(true);
	expect(await guard.claim('second', future)).toBe(true);
	expect(await guard.claim('third', future)).toBe(false);

	/* The earlier claims are still held */
	expect(await guard.claim('first', future)).toBe(false);
	expect(await guard.claim('second', future)).toBe(false);
});

test('MemoryReplayGuard accepts new claims again once earlier ones expire', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 1 });

	expect(await guard.claim('short', new Date(Date.now() + 50))).toBe(true);
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(false);

	await new Promise(function(resolve) {
		setTimeout(resolve, 100);
	});
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(true);
});

test('MemoryReplayGuard counts only live claims toward its limit, even behind a longer claim', async function() {
	const guard = new MemoryReplayGuard({ maxEntries: 2 });

	/* The long claim is first in insertion order, so the expired one sits behind it */
	expect(await guard.claim('long', new Date(Date.now() + 60_000))).toBe(true);
	expect(await guard.claim('short', new Date(Date.now() + 50))).toBe(true);

	await new Promise(function(resolve) {
		setTimeout(resolve, 100);
	});
	expect(await guard.claim('next', new Date(Date.now() + 60_000))).toBe(true);
	expect(await guard.claim('long', new Date(Date.now() + 60_000))).toBe(false);
});

/**
 * One store that several server instances share. Each call to
 * `newInstance` returns a guard with its own connection, as a separate
 * process would have.
 */
interface SharedStore extends AsyncDisposable {
	newInstance(): Promise<KeetaAnchorReplayGuard>;
}

async function dropTables(pool: pg.Pool, tableName: string): Promise<void> {
	await pool.query(`DROP TABLE IF EXISTS ${tableName}, ${tableName}_schema_version`);
}

function randomName(): string {
	return(`t${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`);
}

async function memoryStore(): Promise<SharedStore> {
	/* A process-local guard is shared only by handing out the same object */
	const guard = new MemoryReplayGuard();

	return({
		async newInstance() {
			return(guard);
		},
		async [Symbol.asyncDispose]() {
			/* Nothing to release */
		}
	});
}

async function redisStore(): Promise<SharedStore> {
	const config = getTestingRedisConfig();
	if (config === null) {
		throw(new Error('Redis configuration not available'));
	}

	const keyPrefix = randomName();
	const clients: RedisClientType[] = [];

	return({
		async newInstance() {
			const options: Parameters<typeof createClient>[0] = { socket: { host: config.host, port: config.port }};
			if (config.password) {
				options.password = config.password;
			}
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const client = createClient(options) as RedisClientType;
			await client.connect();
			clients.push(client);

			return(new RedisReplayGuard({
				redis: async function() {
					return(client);
				},
				keyPrefix
			}));
		},
		async [Symbol.asyncDispose]() {
			for (const client of clients) {
				await client.quit();
			}
		}
	});
}

async function postgresStore(): Promise<SharedStore> {
	const config = getTestingPostgresConfig();
	if (config === null) {
		throw(new Error('Postgres configuration not available'));
	}

	const tableName = randomName();
	const pools: pg.Pool[] = [];

	return({
		async newInstance() {
			const pool = new pg.Pool({ ...config });
			pools.push(pool);

			return(new PostgresReplayGuard({
				pool: async function() {
					return(pool);
				},
				tableName,
				sweepIntervalMs: 0
			}));
		},
		async [Symbol.asyncDispose]() {
			const [ first ] = pools;
			if (first !== undefined) {
				await dropTables(first, tableName);
			}
			for (const pool of pools) {
				await pool.end();
			}
		}
	});
}

const stores: { name: string; skip: boolean; open: () => Promise<SharedStore>; }[] = [
	{ name: 'Memory', skip: false, open: memoryStore },
	{ name: 'Redis', skip: getTestingRedisConfig() === null, open: redisStore },
	{ name: 'Postgres', skip: getTestingPostgresConfig() === null, open: postgresStore }
];

function inMs(ms: number): Date {
	return(new Date(Date.now() + ms));
}

for (const store of stores) {
	describe.skipIf(store.skip)(`${store.name} replay guard shared by several instances`, function() {
		test('a nonce claimed at one instance is refused at every other until it expires', async function() {
			await using shared = await store.open();
			const first = await shared.newInstance();
			const second = await shared.newInstance();

			expect(await first.claim('nonce-a', inMs(60_000))).toBe(true);
			expect(await second.claim('nonce-a', inMs(60_000))).toBe(false);
			expect(await first.claim('nonce-a', inMs(60_000))).toBe(false);
			expect(await second.claim('nonce-b', inMs(60_000))).toBe(true);
		});

		test('an expired claim can be made again from any instance', async function() {
			await using shared = await store.open();
			const first = await shared.newInstance();
			const second = await shared.newInstance();

			expect(await first.claim('short', inMs(100))).toBe(true);
			await new Promise(function(resolve) {
				setTimeout(resolve, 250);
			});
			expect(await second.claim('short', inMs(60_000))).toBe(true);
			expect(await first.claim('short', inMs(60_000))).toBe(false);
		});

		test('one of many concurrent claims of a nonce wins', async function() {
			await using shared = await store.open();
			const instances = await Promise.all(Array.from({ length: 8 }, function() {
				return(shared.newInstance());
			}));

			const results = await Promise.all(instances.map(function(instance) {
				return(instance.claim('contended', inMs(60_000)));
			}));
			expect(results.filter(Boolean)).toHaveLength(1);
		});
	});
}

describe.skipIf(getTestingPostgresConfig() === null)('PostgresReplayGuard', function() {
	test('deletes expired claims, records its schema version, and refuses a table name it cannot write safely', async function() {
		const config = getTestingPostgresConfig();
		if (config === null) {
			throw(new Error('Postgres configuration not available'));
		}

		const pool = new pg.Pool({ ...config });
		const tableName = randomName();
		try {
			const guard = new PostgresReplayGuard({
				pool: async function() {
					return(pool);
				},
				tableName,
				sweepIntervalMs: 0
			});

			expect(await guard.claim('old', inMs(50))).toBe(true);
			await new Promise(function(resolve) {
				setTimeout(resolve, 150);
			});
			expect(await guard.claim('new', inMs(60_000))).toBe(true);

			const rows = await pool.query<{ key: string }>(`SELECT key FROM ${tableName} ORDER BY key`);
			expect(rows.rows.map(function(row) {
				return(row.key);
			})).toEqual([ 'new' ]);

			/* A second guard on the same table finds it at the current version */
			const again = new PostgresReplayGuard({
				pool: async function() {
					return(pool);
				},
				tableName
			});
			expect(await again.claim('new', inMs(60_000))).toBe(false);
			const versions = await pool.query<{ version: number }>(`SELECT version FROM ${tableName}_schema_version`);
			expect(versions.rows).toEqual([{ version: 1 }]);
		} finally {
			await dropTables(pool, tableName);
			await pool.end();
		}

		expect(function() {
			return(new PostgresReplayGuard({
				pool: async function() {
					return(pool);
				},
				tableName: 'claims; DROP TABLE users'
			}));
		}).toThrow('Invalid tableName');
	});
	test('a claim holds when deleting expired claims fails', async function() {
		const config = getTestingPostgresConfig();
		if (config === null) {
			throw(new Error('Postgres configuration not available'));
		}

		const pool = new pg.Pool({ ...config });
		const tableName = randomName();
		const errors: unknown[][] = [];
		function ignore(): void {
			/* Only errors are checked */
		}
		const logger: Logger = {
			log: ignore,
			debug: ignore,
			info: ignore,
			warn: ignore,
			error: function(...args: unknown[]) {
				errors.push(args);
			}
		};
		try {
			const guard = new PostgresReplayGuard({
				pool: async function() {
					return(pool);
				},
				tableName,
				sweepIntervalMs: 0,
				logger
			});
			expect(await guard.claim('first', inMs(60_000))).toBe(true);

			/* Make every DELETE on the claims table fail */
			await pool.query(`CREATE FUNCTION ${tableName}_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`);
			await pool.query(`CREATE TRIGGER ${tableName}_refuse BEFORE DELETE ON ${tableName} FOR EACH STATEMENT EXECUTE FUNCTION ${tableName}_refuse()`);

			expect(await guard.claim('second', inMs(60_000))).toBe(true);
			expect(await guard.claim('second', inMs(60_000))).toBe(false);
			expect(errors).toHaveLength(2);
		} finally {
			await dropTables(pool, tableName);
			await pool.query(`DROP FUNCTION IF EXISTS ${tableName}_refuse()`);
			await pool.end();
		}
	});
});
