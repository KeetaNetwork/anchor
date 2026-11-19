import { describe, expect, test } from 'vitest';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import * as pg from 'pg';
import type { KeetaAnchorReplayGuard } from './replay-guard.js';
import { MemoryReplayGuard } from './replay-guard.js';
import { RedisReplayGuard } from './replay-guard-redis.js';
import { PostgresReplayGuard } from './replay-guard-postgres.js';
import { getTestingRedisConfig } from '../utils/tests/redis.js';
import { getTestingPostgresConfig } from '../utils/tests/postgres.js';

/**
 * One store that several server instances share. Each call to
 * `newInstance` returns a guard with its own connection, as a separate
 * process would have.
 */
interface SharedStore extends AsyncDisposable {
	newInstance(): Promise<KeetaAnchorReplayGuard>;
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
				await first.query(`DROP TABLE IF EXISTS ${tableName}`);
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
	test('deletes expired claims and refuses a table name it cannot write safely', async function() {
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
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
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
});
