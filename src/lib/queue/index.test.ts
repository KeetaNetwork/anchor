import { test, expect, suite, beforeAll, afterAll, vi } from 'vitest';
import type { Logger } from '../log/index.ts';
import { asleep } from '../utils/asleep.js';
import { AsyncDisposableStack } from '../utils/defer.js';
import type { JSONSerializable } from '../utils/json.ts';
import { hash } from '../utils/tests/hash.js';

import {
	KeetaAnchorQueueRunnerJSONConfigProc,
	KeetaAnchorQueueStorageDriverMemory
} from './index.js';
import type {
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueEntry,
	KeetaAnchorQueueStorageDriver,
	KeetaAnchorQueueRequestID
} from './index.ts';
import { Errors } from './common.js';

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import KeetaAnchorQueueStorageDriverFile from './drivers/queue_file.js';
import KeetaAnchorQueueStorageDriverSQLite3 from './drivers/queue_sqlite3.js';
import KeetaAnchorQueueStorageDriverRedis from './drivers/queue_redis.js';
import KeetaAnchorQueueStorageDriverPostgres from './drivers/queue_postgres.js';

import * as sqlite from 'sqlite';
import * as sqlite3 from 'sqlite3';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import * as pg from 'pg';

const DEBUG = false;
let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

const TestingKey = 'bc81abf8-e43b-490b-b486-744fb49a5082';

const RunKey = crypto.randomUUID();
function generateRequestID(): KeetaAnchorQueueRequestID {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID);
}

function getTestingRedisConfig(): { host: string; port: number; password: string | undefined; } | null {
	const host = process.env['ANCHOR_TESTING_REDIS_HOST'];
	const portStr = process.env['ANCHOR_TESTING_REDIS_PORT'];

	if (!host || !portStr) {
		return(null);
	}

	const password = process.env['ANCHOR_TESTING_REDIS_SECRET'];

	const port = Number(portStr);
	if (isNaN(port) || port <= 0 || port >= 65536) {
		return(null);
	}

	return({ host: host, port: port, password: password });
}

function getTestingPostgresConfig(): { host: string; port: number; user: string; password: string; } | null {
	const host = process.env['ANCHOR_TESTING_POSTGRES_HOST'];
	const portStr = process.env['ANCHOR_TESTING_POSTGRES_PORT'];
	const user = process.env['ANCHOR_TESTING_POSTGRES_USER'];
	const password = process.env['ANCHOR_TESTING_POSTGRES_PASS'];

	if (!host || !portStr || !user || !password) {
		return(null);
	}

	const port = Number(portStr);
	if (isNaN(port) || port <= 0 || port >= 65536) {
		return(null);
	}

	return({ host: host, port: port, user: user, password: password });
}

const drivers: {
	[driverName: string]: {
		persistent: boolean;
		skip: boolean | (() => Promise<boolean>);
		create: (key: string, options?: { leave?: boolean }) => Promise<{
			queue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
			[Symbol.asyncDispose]: () => Promise<void>;
		}>;
	}
} = {
	'Memory': {
		persistent: false,
		skip: false,
		create: async function(key: string) {
			const queue = new KeetaAnchorQueueStorageDriverMemory({ id: key, logger: logger });
			return({
				queue: queue,
				[Symbol.asyncDispose]: async function() {
					return(await queue[Symbol.asyncDispose]());
				}
			});
		}
	},
	'File': {
		persistent: true,
		skip: false,
		create: async function(key: string, options = { leave: false }) {
			const filePath = path.join(os.tmpdir(), `anchor-queue-tests-${RunKey}-${key}.file.json`);

			const queue = new KeetaAnchorQueueStorageDriverFile({
				filePath: filePath,
				id: key,
				logger: logger
			});
			return({
				queue: queue,
				[Symbol.asyncDispose]: async function() {
					await queue[Symbol.asyncDispose]();
					if (options?.leave !== true) {
						try {
							fs.unlinkSync(filePath);
						} catch {
							/* Ignore */
						}
					}
				}
			});
		}
	},
	'SQLite3': {
		persistent: true,
		skip: false,
		create: async function(key: string, options = { leave: false }) {
			const filePath = path.join(os.tmpdir(), `anchor-queue-tests-${RunKey}-${key}.sqlite3.db`);

			const queue = new KeetaAnchorQueueStorageDriverSQLite3({
				db: async function() {
					return(await sqlite.open({
						filename: filePath,
						driver: sqlite3.Database,
						mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
					}));
				},
				id: key,
				logger: logger
			});
			return({
				queue: queue,
				[Symbol.asyncDispose]: async function() {
					await queue[Symbol.asyncDispose]();
					if (options?.leave !== true) {
						for (const addFileSuffix of ['', '-shm', '-wal']) {
							try {
								fs.unlinkSync(`${filePath}${addFileSuffix}`);
							} catch {
								/* Ignore */
							}
						}
					}
				}
			});
		}
	},
	'Redis': {
		persistent: true,
		skip: async function() {
			return(getTestingRedisConfig() === null);
		},
		create: async function(key: string, options = { leave: false }) {
			const redisConfig = getTestingRedisConfig();
			if (!redisConfig) {
				throw(new Error('Redis configuration not available'));
			}

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			let client = undefined as RedisClientType | undefined;

			const queue = new KeetaAnchorQueueStorageDriverRedis({
				redis: async function(): Promise<RedisClientType> {
					if (!client) {
						const clientOptions: Parameters<typeof createClient>[0] = {
							socket: {
								host: redisConfig.host,
								port: redisConfig.port
							}
						};
						if (redisConfig.password) {
							clientOptions.password = redisConfig.password;
						}
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						client = createClient(clientOptions) as RedisClientType;
						await client.connect();
					}
					return(client);
				},
				id: key,
				path: [`key_${key}_${RunKey}`],
				logger: logger
			});

			return({
				queue: queue,
				[Symbol.asyncDispose]: async function() {
					await queue[Symbol.asyncDispose]();
					if (client) {
						if (!options?.leave) {
							const keys = await client.keys(`queue:root*`);
							if (keys.length > 0) {
								await client.del(keys);
							}
						}
						await client.quit();
					}
				}
			});
		}
	},
	'PostgreSQL': {
		persistent: true,
		skip: async function() {
			return(getTestingPostgresConfig() === null);
		},
		create: async function(key: string, options = { leave: false }) {
			const postgresConfig = getTestingPostgresConfig();
			if (!postgresConfig) {
				throw(new Error('Postgres configuration not available'));
			}

			let dbNameKey = key;
			if (dbNameKey.length > 14) {
				dbNameKey = dbNameKey.slice(0, 6) + hash(dbNameKey, 8);
			}

			const dbName = `anchor_test_${dbNameKey}_${RunKey.replace(/-/g, '_')}`;
			let pool: pg.Pool | undefined;
			let adminPool: pg.Pool | undefined;

			try {
				adminPool = new pg.Pool({
					host: postgresConfig.host,
					port: postgresConfig.port,
					user: postgresConfig.user,
					password: postgresConfig.password,
					database: undefined
				});

				try {
					await adminPool.query(`CREATE DATABASE "${dbName}"`);
				} catch (error: unknown) {
					if (!(error instanceof Error && error.message.includes('already exists'))) {
						throw(error);
					}
				}

				await adminPool.end();
				adminPool = undefined;

				pool = new pg.Pool({
					host: postgresConfig.host,
					port: postgresConfig.port,
					user: postgresConfig.user,
					password: postgresConfig.password,
					database: dbName
				});

				const queue = new KeetaAnchorQueueStorageDriverPostgres({
					pool: async function(): Promise<pg.Pool> {
						if (!pool) {
							throw(new Error('Pool is not available'));
						}
						return(pool);
					},
					id: key,
					logger: logger
				});

				return({
					queue: queue,
					[Symbol.asyncDispose]: async function() {
						await queue[Symbol.asyncDispose]();

						await pool?.end();
						pool = undefined;

						if (!options?.leave) {
							try {
								const cleanupPool = new pg.Pool({
									host: postgresConfig.host,
									port: postgresConfig.port,
									user: postgresConfig.user,
									password: postgresConfig.password,
									database: undefined
								});

								await cleanupPool.query(`DROP DATABASE "${dbName}"`);
								await cleanupPool.end();
							} catch {
								/* Ignore */
							}
						}
					}
				});
			} catch (error: unknown) {
				await adminPool?.end();
				adminPool = undefined;

				await pool?.end();
				pool = undefined;
				throw(error);
			}
		}
	}
};

test('Queue Runner Basic Tests', async function() {
	type RequestType = {
		key: string;
		newStatus: KeetaAnchorQueueStatus;
	};

	type ResponseType = string;

	await using cleanup = new AsyncDisposableStack();
	vi.useFakeTimers();
	cleanup.defer(function() {
		vi.useRealTimers();
	});

	await using queue = new KeetaAnchorQueueStorageDriverMemory({
		id: 'basic-tests',
		logger: logger
	});

	const processCallCountByKey = new Map<string, number>();
	await using runner = new KeetaAnchorQueueRunnerJSONConfigProc<RequestType, ResponseType>({
		id: 'basic-tests-runner',
		queue: queue,
		logger: logger,
		processor: async function(entry) {
			const key = entry.request.key;
			if (key.startsWith('timedout_early')) {
				await asleep(500);
			}

			const callCount = processCallCountByKey.get(key) ?? 0;
			processCallCountByKey.set(key, callCount + 1);

			if (key.startsWith('timedout_late')) {
				await asleep(500);
			}

			if (key.startsWith('error')) {
				throw(new Error('Processing error'));
			}

			return({ status: entry.request.newStatus, output: 'OK' });
		}
	});

	/*
	 * Set some lower timeouts and retry counts for testing
	 *
	 * These might move to supported interfaces in the future
	 */
	runner._Testing(TestingKey).setParams(100, 100, 3);

	{
		logger?.debug('basic', '> Test that jobs complete and fail as expected and that retries are handled correctly');

		/*
		 * Enqueue three jobs:
		 *   - one that will complete successfully
		 *   - one that will fail manually (i.e. the processor returns 'failed_temporarily')
		 *   - one that will fail automatically (i.e. the processor throws an error)
		 */
		const id_completed = await runner.add({ key: 'one', newStatus: 'completed' });
		const id_failed_manually = await runner.add({ key: 'two', newStatus: 'failed_temporarily' });
		const id_failed_auto = await runner.add({ key: 'error_three', newStatus: 'completed' });
		await runner.run();
		{
			const status_completed = await runner.get(id_completed);
			const status_failed_manually = await runner.get(id_failed_manually);
			const status_failed_auto = await runner.get(id_failed_auto);
			expect(status_completed?.status).toBe('completed');
			expect(status_failed_manually?.status).toBe('failed_temporarily');
			expect(status_failed_auto?.status).toBe('failed_temporarily');
			expect(status_completed?.output).toBe('OK');
			expect(status_completed?.lastError).toBe(null);
			expect(status_failed_manually?.output).toBe('OK');
			expect(status_failed_manually?.lastError).toBe(null);
			expect(status_failed_auto?.output).toBe(null);
			expect(status_failed_auto?.lastError).toBe('Error: Processing error');
			expect(processCallCountByKey.get('one')).toBe(1);
			expect(processCallCountByKey.get('two')).toBe(1);
			expect(processCallCountByKey.get('error_three')).toBe(1);
		}

		/*
		 * Verify that re-running without maintenance does not retry
		 * failed (or completed) jobs
		 */
		for (let retries = 0; retries < 10; retries++) {
			vi.advanceTimersByTime(100);
			await runner.run();
		}
		{
			const status_completed = await runner.get(id_completed);
			const status_failed_manually = await runner.get(id_failed_manually);
			const status_failed_auto = await runner.get(id_failed_auto);
			expect(status_completed?.status).toBe('completed');
			expect(status_failed_manually?.status).toBe('failed_temporarily');
			expect(status_failed_auto?.status).toBe('failed_temporarily');
			expect(processCallCountByKey.get('one')).toBe(1);
			expect(processCallCountByKey.get('two')).toBe(1);
			expect(processCallCountByKey.get('error_three')).toBe(1);
		}

		/*
		 * Test that re-running with maintenance will move the failed jobs
		 * back to pending and then they will be retried
		 */
		for (let retries = 0; retries < 30; retries++) {
			vi.advanceTimersByTime(100);
			await runner.maintain();
			await runner.run();
		}
		{
			const status_completed = await runner.get(id_completed);
			const status_failed_manually = await runner.get(id_failed_manually);
			const status_failed_auto = await runner.get(id_failed_auto);
			expect(status_completed?.status).toBe('completed');
			expect(status_failed_manually?.status).toBe('failed_permanently');
			expect(status_failed_auto?.status).toBe('failed_permanently');
			expect(processCallCountByKey.get('one')).toBe(1);
			expect(processCallCountByKey.get('two')).toBe(3);
			expect(processCallCountByKey.get('error_three')).toBe(3);
		}

		/*
		 * Test that the runner knows that there are no more jobs to run
		 */
		expect(await runner.run()).toBe(false);
	}

	{
		logger?.debug('basic', '> Test that jobs that timeout are handled correctly');

		const id_early = await runner.add({ key: 'timedout_early_one', newStatus: 'completed' });
		const id_late = await runner.add({ key: 'timedout_late_one', newStatus: 'completed' });
		vi.useRealTimers();
		await runner.run();
		vi.useFakeTimers();
		{
			const status_early = await runner.get(id_early);
			const status_late = await runner.get(id_late);
			expect(status_early?.status).toBe('aborted');
			expect(status_late?.status).toBe('aborted');
			expect(processCallCountByKey.get('timedout_early_one')).toBe(undefined);
			expect(processCallCountByKey.get('timedout_late_one')).toBe(1);
		}
	}

	{
		logger?.debug('basic', '> Test that stuck jobs are detected ');

		const id = await runner.add({ key: 'stuck', newStatus: 'completed' });

		/* Pretend the job is processing */
		await runner._Testing(TestingKey).queue().setStatus(id, 'processing', { oldStatus: 'pending' });
		vi.advanceTimersByTime(100 * 10 + 200);
		await runner.run();
		{
			const status = await runner.get(id);
			expect(status?.status).toBe('processing');
			expect(processCallCountByKey.get('stuck')).toBe(undefined);
		}

		await runner.maintain();
		{
			const status = await runner.get(id);
			expect(status?.status).toBe('stuck');
			expect(processCallCountByKey.get('stuck')).toBe(undefined);
		}
	}

	{
		logger?.debug('basic', '> Test the runner timeout works correctly');
		const before_any_jobs = await runner.run({ timeoutMs: 0 });
		expect(before_any_jobs).toBe(false);

		const id_1 = await runner.add({ key: 'timedout_late_two', newStatus: 'completed' });
		const id_2 = await runner.add({ key: 'timedout_late_two', newStatus: 'completed' });
		{
			const after_jobs_before_processing = await runner.run({ timeoutMs: 0 });
			expect(after_jobs_before_processing).toBe(true);
			const status_1 = await runner.get(id_1);
			const status_2 = await runner.get(id_2);
			expect(status_1?.status).toBe('pending');
			expect(status_2?.status).toBe('pending');
		}
		{
			vi.useRealTimers();
			const after_jobs = await runner.run({ timeoutMs: 10 });
			vi.useFakeTimers();
			expect(after_jobs).toBe(true);
			const status_1 = await runner.get(id_1);
			const status_2 = await runner.get(id_2);

			/*
			 * Since we do not know which job will be processed first, just
			 * check that one is aborted and one is still pending
			 */
			const statuses = [status_1?.status ?? '<unknown>', status_2?.status ?? '<unknown>'].sort();

			expect(statuses).toEqual(['aborted', 'pending']);
		}
	}
});

test('Queue Runner Aborted and Stuck Jobs Tests', async function() {
	type RequestType = {
		key: string;
		newStatus: KeetaAnchorQueueStatus;
	};

	type ResponseType = string;

	await using cleanup = new AsyncDisposableStack();
	vi.useFakeTimers();
	cleanup.defer(function() {
		vi.useRealTimers();
	});

	await using queue = new KeetaAnchorQueueStorageDriverMemory({
		id: 'aborted-stuck-test',
		logger: logger
	});

	const processCallCountByKey = new Map<string, number>();
	const processAbortedCallCountByKey = new Map<string, number>();
	const processStuckCallCountByKey = new Map<string, number>();
	await using runner = new KeetaAnchorQueueRunnerJSONConfigProc<RequestType, ResponseType>({
		id: 'aborted-stuck-test-runner',
		queue: queue,
		logger: logger,
		processor: async function(entry) {
			const key = entry.request.key;
			if (key.startsWith('timedout_early')) {
				await asleep(500);
			}

			const callCount = processCallCountByKey.get(key) ?? 0;
			processCallCountByKey.set(key, callCount + 1);

			if (key.startsWith('timedout_late')) {
				await asleep(500);
			}

			if (key.startsWith('error')) {
				throw(new Error('Processing error'));
			}

			return({ status: entry.request.newStatus, output: 'OK' });
		},
		processorAborted: async function(entry) {
			const callCount = processAbortedCallCountByKey.get(entry.request.key) ?? 0;
			processAbortedCallCountByKey.set(entry.request.key, callCount + 1);

			if (entry.request.key.includes('forward')) {
				return({ status: 'completed', output: 'OK' });
			}

			if (entry.request.key.includes('backward')) {
				return({ status: 'pending', output: null });
			}
			throw(new Error('Got some other kind of aborted job'));
		},
		processorStuck: async function(entry) {
			const callCount = processStuckCallCountByKey.get(entry.request.key) ?? 0;
			processStuckCallCountByKey.set(entry.request.key, callCount + 1);

			if (entry.request.key.includes('forward')) {
				return({ status: 'completed', output: 'OK' });
			}

			if (entry.request.key.includes('backward')) {
				return({ status: 'pending', output: null });
			}
			throw(new Error('Got some other kind of stuck job'));
		}
	});

	runner._Testing(TestingKey).setParams(100, 50, 3);

	const id_aborted = await runner.add({ key: 'timedout_late_forward_aborted', newStatus: 'completed' });

	/**
	 * Test that aborted jobs are handled by the aborted processor
	 */
	{
		logger?.debug('aborted', '> Test that aborted jobs are handled by the aborted processor');

		/*
		 * Run the job, it should be aborted and then processed by the
		 * aborted processor which will complete it (since the key contains 'forward')
		 */
		{
			/*
			 * First run to pick up the job -- it will timeout and consume the
			 * entire time budget for the `run` call so it will not transition
			 * from aborted to processing to completed in the same run
			 */
			vi.useRealTimers();
			await runner.run({ timeoutMs: 50 });
			vi.useFakeTimers();

			const status_aborted = await runner.get(id_aborted);
			expect(status_aborted?.status).toBe('aborted');

			/* The main processor was called once -- resulting a timeout, leading to the aborted status */
			expect(processCallCountByKey.get('timedout_late_forward_aborted')).toBe(1);

			/* We haven't run the queue again so the aborted processor should not have been called yet */
			expect(processAbortedCallCountByKey.get('timedout_late_forward_aborted')).toBe(undefined);
		}

		{
			/*
			 * Next, run the process again and this time it
			 * should be processed by the aborted processor
			 */
			vi.useRealTimers();
			await runner.run();
			vi.useFakeTimers();

			const status_aborted = await runner.get(id_aborted);
			expect(status_aborted?.status).toBe('completed');

			/* The main processor was already called above and not called again, so should remain 1 */
			expect(processCallCountByKey.get('timedout_late_forward_aborted')).toBe(1);

			/* The aborted processor should have been called once */
			expect(processAbortedCallCountByKey.get('timedout_late_forward_aborted')).toBe(1);
		}
	}

	/**
	 * Test that stuck jobs are handled by the stuck processor
	 */
	{
		logger?.debug('stuck', '> Test that stuck jobs are handled by the stuck processor');
		const id_stuck = await runner.add({ key: 'timedout_late_forward_stuck', newStatus: 'completed' });
		/*
		 * Move the job to the stuck status manually.  This
		 * simulates a job that was processing but the worker
		 * died without completing it.
		 */
		await runner.setStatus(id_stuck, 'stuck', { oldStatus: 'pending' });

		/*
		 * Run the job, it should be processed by the
		 * stuck processor which will complete it (since the key contains 'forward')
		 */
		{
			await runner.run();

			const status_stuck = await runner.get(id_stuck);
			expect(status_stuck?.status).toBe('completed');

			/* Since we moved the job directly to stuck, it never ran so processCallCount is undefined */
			expect(processCallCountByKey.get('timedout_late_forward_stuck')).toBe(undefined);

			/* The stuck processor should have been called once */
			expect(processStuckCallCountByKey.get('timedout_late_forward_stuck')).toBe(1);
		}
	}
});


for (const singleWorkerID of [true, false]) {
	let mode = 'Multiple Workers IDs';
	let name = 'multiworker';
	if (singleWorkerID) {
		mode = 'Single Worker ID';
		name = 'singleworker';
	}

	type RequestType = {
		key: string;
		newStatus: KeetaAnchorQueueStatus;
	};

	type ResponseType = string;

	test(`Queue Runner ${mode} Tests`, async function() {
		const runnerCount = 10;
		const messageCount = runnerCount * 5;

		await using cleanup = new AsyncDisposableStack();
		vi.useFakeTimers();
		cleanup.defer(function() {
			vi.useRealTimers();
		});

		await using queue = new KeetaAnchorQueueStorageDriverMemory({
			id: `${name}-test`,
			logger: logger
		});

		const processCallCountByKey = new Map<string, number>();
		let running = false;
		function runnerArgs(index: number): ConstructorParameters<typeof KeetaAnchorQueueRunnerJSONConfigProc<RequestType, ResponseType>>[0] {
			let configuredRunnerCount = runnerCount;
			let configuredWorkerID = index;
			if (singleWorkerID) {
				configuredRunnerCount = 1;
				configuredWorkerID = 0;
			}
			return({
				id: `${name}-test-runner-${index}`,
				queue: queue,
				logger: logger,
				workers: {
					count: configuredRunnerCount,
					id: configuredWorkerID
				},
				processor: async function(entry) {
					await using cleanupProcessor = new AsyncDisposableStack();
					if (singleWorkerID) {
						if (running) {
							throw(new Error('Processor is already running a job, but this runner is supposed to be sequential'));
						}
						running = true;
						cleanupProcessor.defer(function() {
							running = false;
						});
					}

					const calls = processCallCountByKey.get(entry.request.key) ?? 0;
					processCallCountByKey.set(entry.request.key, calls + 1);

					vi.advanceTimersByTime(50);

					return({ status: entry.request.newStatus, output: 'OK' });
				}
			});
		};

		const runners = Array.from({ length: runnerCount }).map(function(_ignored_value, index) {
			const runner = new KeetaAnchorQueueRunnerJSONConfigProc<RequestType, ResponseType>({
				...runnerArgs(index)
			});
			cleanup.defer(async function() {
				await runner.destroy();
			});

			runner._Testing(TestingKey).setParams(3, 100, 3, 1);

			return(runner);
		});

		function getRunnerFromIndex(index: number) {
			const runner = runners[index % runners.length];
			if (!runner) {
				throw(new Error('internal error: runner is undefined'));
			}
			return(runner);
		}

		const ids = await Promise.all(Array.from({ length: messageCount }).map(async function(_ignored_key, index) {
			const runner = getRunnerFromIndex(index);
			return(await runner.add({ key: `key_${index}`, newStatus: 'completed' }));
		}));

		/**
		 * Helper function to call `runner.run` in parallel multiple times, with a specified timeout
		 */
		async function runInParallel(count: number, maxRetries: number, timeoutMs?: number): Promise<{ completed: number; failed: number; result: boolean | undefined; error: unknown; }> {
			const results = await Promise.allSettled(Array.from({ length: count }).map(async function(_ignored_key, index) {
				const runner = getRunnerFromIndex(index);

				let retval = false;
				for (let retries = 0; retries < maxRetries; retries++) {
					retval = await runner.run({ timeoutMs });
				}

				return(retval);
			}));

			let completedCount = 0;
			let failedCount = 0;
			let resultValue: boolean | undefined = undefined;
			let resultError: unknown = undefined;
			for (const result of results) {
				if (result.status === 'fulfilled') {
					completedCount++;
					resultValue = result.value;
				} else if (result.status === 'rejected') {
					failedCount++;
					resultError = result.reason;
				}
			}

			return({ completed: completedCount, failed: failedCount, result: resultValue, error: resultError });
		}

		/**
		 * Test that a sequential queue processes jobs one at a time
		 */
		{
			logger?.debug(name, '> Test that no workers run the same job concurrently');

			const maxRunAttempts = 20;

			const results = await runInParallel(maxRunAttempts, 8, 100);
			expect({ completed: results.completed, failed: results.failed }).toEqual({ completed: maxRunAttempts, failed: 0 });

			/*
			 * Ensure that every job is processed either 0 or 1 times only
			 */
			for (const [key, count] of processCallCountByKey.entries()) {
				if (count !== 1) {
					expect.fail(`Key ${key} was processed ${count} times, expected only once`);
				}
			}

			/*
			 * Ensure that the expected number of jobs were
			 * processed since this is a deterministic process
			 * because the timers are being faked
			 */
			if (singleWorkerID) {
				expect(processCallCountByKey.size).toBe(10);
			} else {
				expect(processCallCountByKey.size).toBe(23);
			}

			const id0 = ids[0];
			if (id0 === undefined) {
				throw(new Error('internal error: ids[0] is undefined'));
			}

			/*
			 * Check that all runners see the same completed status for the first job
			 */
			for (let runnerIndex = 0; runnerIndex < runners.length; runnerIndex++) {
				const runner = getRunnerFromIndex(runnerIndex);
				const entry = await runner.get(id0);
				expect(entry?.status).toBe('completed');
				expect(entry?.output).toBe('OK');
			}
		}
	});
}

test('Pipeline Basic Tests', async function() {
	await using cleanup = new AsyncDisposableStack();
	vi.useFakeTimers();
	cleanup.defer(function() {
		vi.useRealTimers();
	});

	function createStage<INPUT extends JSONSerializable, OUTPUT extends JSONSerializable>(name: string, processor: (entry: KeetaAnchorQueueEntry<INPUT, OUTPUT>) => Promise<{ status: 'completed'; output: OUTPUT; }>) {
		return(new KeetaAnchorQueueRunnerJSONConfigProc<INPUT, OUTPUT>({
			id: `${name}_runner`,
			processor: processor,
			queue: new KeetaAnchorQueueStorageDriverMemory({
				id: `${name}_queue`,
				logger: logger
			}),
			logger: logger
		}));
	}

	/*
	 * Define some stages, we will later create a pipeline
	 *
	 * Each stage is a queue that has a processor function that
	 * is faulty on purpose to simulate processing errors.
	 *
	 * Each request creates an entry that is processed by the
	 * processor for that runner and the output is stored
	 * in the entry output.
	 */
	const stage1 = createStage<string, number>('stage1', async function(entry) {
		if (Math.random() < 0.5) {
			throw(new Error('Simulated random processing error'));
		}
		return({ status: 'completed', output: entry.request.length });
	});
	const stage2 = createStage<number, boolean>('stage2', async function(entry) {
		if (Math.random() < 0.9) {
			throw(new Error('Simulated random processing error'));
		}
		return({ status: 'completed', output: entry.request % 2 === 0 });
	});
	const stage3 = createStage<boolean, string>('stage3', async function(entry) {
		if (Math.random() < 0.01) {
			throw(new Error('Simulated random processing error'));
		}
		return({ status: 'completed', output: entry.request ? 'even' : 'odd' });
	});
	const stage4 = createStage<string[], string>('stage4', async function(entry) {
		if (Math.random() < 0.05) {
			throw(new Error('Simulated random processing error'));
		}
		return({ status: 'completed', output: `Results: ${entry.request.sort().join(', ')}` });
	});

	/*
	 * Helper function to run the queues until they are no longer
	 * runnable after advancing time forward to deal with failure
	 * retries
	 */
	async function runAndMaintainQueues() {
		let sequentialFalseCount = 0;
		for (let retry = 0; retry < 10000; retry++) {
			await stage1.run();
			await stage1.maintain();
			const runResult = await stage1.runnable();

			/* Advance time by 10x the process timeout to simulate time passing */
			vi.advanceTimersByTime(300_000 * 10);

			if (!runResult) {
				sequentialFalseCount++;
			} else {
				sequentialFalseCount = 0;
			}

			if (sequentialFalseCount >= 5) {
				/* Assume the pipeline is done if we have multiple empty runs */
				break;
			}
		}
	}

	/*
	 * Set the retry parameters to be more aggressive for testing
	 */
	stage1._Testing(TestingKey).setParams(100, 300_000, 10_000);
	stage2._Testing(TestingKey).setParams(100, 300_000, 10_000);
	stage3._Testing(TestingKey).setParams(100, 300_000, 10_000);
	stage4._Testing(TestingKey).setParams(100, 300_000, 10_000);

	/*
	 * Create a pipeline: stage1 -> stage2 -> stage3 -> stage4 (batched, 2 min/2 max)
	 */
	stage1.pipe(stage2).pipe(stage3).pipeBatch(stage4, 2, 2);
	const id1 = await stage1.add('hello');
	const id2 = await stage1.add('a');
	const id3 = await stage1.add('abc');
	const id4 = await stage1.add('defg');
	const id5 = await stage1.add('blah');

	/*
	 * Run the queues until they are no longer runnable, simulating
	 * time passing to allow for failed entries to be set back to
	 * pending and become runnable again
	 */
	await runAndMaintainQueues();

	/*
	 * Ensure that the initial stages have the expected number of
	 * moved/completed entries
	 */
	expect(await stage1.query({ status: 'completed' })).toHaveLength(0);
	expect(await stage1.query({ status: 'moved' })).toHaveLength(5);
	expect(await stage2.query({ status: 'completed' })).toHaveLength(0);
	expect(await stage2.query({ status: 'moved' })).toHaveLength(5);
	expect(await stage3.query({ status: 'completed' })).toHaveLength(1);
	expect(await stage3.query({ status: 'moved' })).toHaveLength(4);
	expect(await stage4.query({ status: 'completed' })).toHaveLength(2);
	expect(await stage4.query({ status: 'moved' })).toHaveLength(0);

	/*
	 * Make sure the final entries comprise 4 of the original 5 entries,
	 * and store the left over one
	 */
	let finalLeftoverID: typeof id1 | undefined;
	const seenFinalIDs = new Set<typeof id1>();
	{
		/*
		 * Get the entries for the final stage
		 */
		const finalEntries = await stage4.query({ status: 'completed' });
		expect(finalEntries).toHaveLength(2);

		/*
		 * Add the final entry IDs to a set for later checking
		 */
		for (const entry of finalEntries) {
			seenFinalIDs.add(entry.id);
		}

		/*
		 * Extract the idempotent IDs from the final entries and ensure that
		 * they cover 4 of the original 5 IDs
		 */
		const finalEntryIDs = finalEntries.map(function(entry) {
			return([...(entry.idempotentKeys ?? [])]);
		}).flat();
		expect(finalEntryIDs).toHaveLength(4);
		const idsAfterRemovingDuplicates = new Set([id1, id2, id3, id4, id5]);
		for (const id of finalEntryIDs) {
			expect(idsAfterRemovingDuplicates.has(id)).toBe(true);
			idsAfterRemovingDuplicates.delete(id);
		}

		/*
		 * There should be only one ID left over, store it for later
		 */
		expect(idsAfterRemovingDuplicates.size).toBe(1);
		finalLeftoverID = idsAfterRemovingDuplicates.values().next().value;
	}
	if (!finalLeftoverID) {
		throw(new Error('internal error: No final leftover ID'));
	}

	/*
	 * Now add another entry and run it through the pipeline
	 */
	const id6 = await stage1.add('');
	await runAndMaintainQueues();

	{
		const finalEntries = (await stage4.query({ status: 'completed' })).filter(function(entry) {
			return(!seenFinalIDs.has(entry.id));
		});
		expect(finalEntries).toHaveLength(1);
		const finalEntryIDs = finalEntries.map(function(entry) {
			return([...(entry.idempotentKeys ?? [])]);
		}).flat();
		expect(finalEntryIDs).toHaveLength(2);
		expect(finalEntryIDs).toContain(finalLeftoverID);
		expect(finalEntryIDs).toContain(id6);
	}
});

suite.sequential('Driver Tests', async function() {
	for (const driver in drivers) {
		const driverConfig = drivers[driver];
		if (driverConfig === undefined) {
			throw(new Error(`internal error: Missing driver config for driver '${driver}'`));
		}

		let shouldSkip = false;
		if (driverConfig.skip !== undefined) {
			if (typeof driverConfig.skip === 'function') {
				shouldSkip = await driverConfig.skip();
			} else {
				shouldSkip = driverConfig.skip;
			}
		}

		let suiteRunner: typeof suite | typeof suite.skip = suite;
		let testRunner: typeof test | typeof test.skip = test;
		if (shouldSkip) {
			suiteRunner = suite.skip;
			testRunner = test.skip;
		}

		suiteRunner(driver, function(): void {
			suite(`Basic Tests`, async function(): Promise<void> {
				let queue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
				let driverInstance: Awaited<ReturnType<typeof driverConfig.create>>;
				beforeAll(async function() {
					driverInstance = await driverConfig.create('basic_test');
					queue = driverInstance.queue;
				});

				afterAll(async function() {
					await driverInstance[Symbol.asyncDispose]();
				});

				/* Test that we can add and get an entry */
				testRunner('Add and Get Entry', async function() {
					for (const createWithStatus of [undefined, 'pending', 'processing'] as const) {
						const id = await queue.add({ key: 'test1' }, { status: createWithStatus });
						expect(id).toBeDefined();
						const entry = await queue.get(id);
						expect(entry).toBeDefined();
						expect(entry?.id).toBe(id);
						expect(entry?.request).toEqual({ key: 'test1' });
						expect(entry?.status).toBe(createWithStatus ?? 'pending');
						expect(entry?.output).toBeNull();
						expect(entry?.lastError).toBeNull();
						expect(entry?.failures).toBe(0);
						expect(entry?.worker).toBeNull();
						expect(entry?.created).toBeInstanceOf(Date);
						expect(entry?.updated).toBeInstanceOf(Date);
					}

					/*
					 * Test getting a non-existent entry
					 */
					{
						const entry = await queue.get(generateRequestID());
						expect(entry).toBeNull();
					}
				});

				/* Test that we can set status of an entry */
				testRunner('Set Status', async function() {
					const id = await queue.add({ key: 'test2' });
					await queue.setStatus(id, 'processing');
					const entry = await queue.get(id);
					expect(entry?.status).toBe('processing');

					await queue.setStatus(id, 'completed', { output: 'result' });
					const updatedEntry = await queue.get(id);
					expect(updatedEntry?.status).toBe('completed');
					expect(updatedEntry?.output).toBe('result');

					await queue.setStatus(id, 'failed_temporarily', { output: 'result_failed' });
					const failedEntry = await queue.get(id);
					expect(failedEntry?.status).toBe('failed_temporarily');
					expect(failedEntry?.output).toBe('result_failed');
					expect(failedEntry?.failures).toBe(1);
				});

				/* Test that we can set status of an entry and that locking works (i.e. oldStatus must match) */
				testRunner('Set Status with oldStatus', async function() {
					await using queueLocal = await queue.partition('set-status-with-oldstatus');

					/*
					 * Add a Time-of-Check to Time-of-Use delay to simulate
					 * a network delay that would cause some clients to be
					 * able to compete to add the same ID
					 */
					queueLocal._Testing?.(TestingKey).setToctouDelay?.(300);

					const id = await queueLocal.add({ key: 'test3' });
					await queueLocal.setStatus(id, 'processing', { oldStatus: 'pending' });
					const entry = await queueLocal.get(id);
					expect(entry?.status).toBe('processing');

					await expect(async function() {
						return(await queueLocal.setStatus(id, 'completed', { oldStatus: 'pending' }));
					}).rejects.toThrow(Errors.IncorrectStateAssertedError);

					await queueLocal.setStatus(id, 'completed', { oldStatus: 'processing' });
					const completedEntry = await queueLocal.get(id);
					expect(completedEntry?.status).toBe('completed');
				}, 300_000);

				/* Test that we can add and get an entry with a specific status */
				testRunner('Add Entry with Initial Status', async function() {
					const id = await queue.add({ key: 'with_status' }, { status: 'moved' });
					const entry = await queue.get(id);
					expect(entry?.status).toBe('moved');

					await queue.setStatus(id, 'completed', { output: 'result' });
					const updatedEntry = await queue.get(id);
					expect(updatedEntry?.status).toBe('completed');
					expect(updatedEntry?.output).toBe('result');
				});

				/* Test that we can add an entry with an ID that already exists and it does nothing (idempotent add) */
				testRunner('Idempotent Add', async function() {
					const customID = generateRequestID();
					const id1 = await queue.add({ key: 'first' }, { id: customID });
					expect(id1).toBe(customID);

					const id2 = await queue.add({ key: 'second' }, { id: customID });
					expect(id2).toBe(customID);

					const entry = await queue.get(customID);
					expect(entry?.request).toEqual({ key: 'first' });

					/*
					 * Test adding the same ID concurrently
					 */
					{
						await using queueLocal = await queue.partition('idempotent-add-concurrently');

						/*
						 * Add a Time-of-Check to Time-of-Use delay to simulate
						 * a network delay that would cause some clients to be
						 * able to compete to add the same ID
						 */
						queueLocal._Testing?.(TestingKey).setToctouDelay?.(300);

						const allIds = await Promise.all(Array.from({ length: 20 }).map(async function(_ignored_value, index) {
							return(await queueLocal.add({ key: `test${index + 1}` }, { id: 'custom_id_123' }));
						}));

						for (const id of allIds) {
							expect(id).toBe('custom_id_123');
						}
						const id1 = allIds[0];
						if (id1 === undefined) {
							throw(new Error('internal error: id1 is undefined'));
						}
						const entry = await queueLocal.get(id1);

						expect(entry).toBeDefined();
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
						expect(entry?.request).toEqual({ key: expect.stringMatching(/^test/) });

						const id1_again = await queueLocal.add({ key: 'test1' }, { id: 'custom_id_123' });
						expect(id1_again).toBe('custom_id_123');
						const entry_again = await queueLocal.get(id1_again);
						expect(entry_again).toBeDefined();
					}
				});

				/* Test that we can add an entry with idempotent ID and it fails if the idempotent key exists with the appropriate error */
				testRunner('Add with Idempotent Keys', async function() {
					const parentID1 = generateRequestID();
					const parentID2 = generateRequestID();
					const parentID3 = generateRequestID();
					await queue.add({ key: 'parent1' }, { id: parentID1 });
					await queue.add({ key: 'parent2' }, { id: parentID2 });
					await queue.add({ key: 'parent3' }, { id: parentID3 });

					// Add first child with one parent - should succeed
					const childID1 = generateRequestID();
					await queue.add({ key: 'child1' }, { id: childID1, idempotentKeys: new Set([parentID1]) });

					// Try to add second child with same parent - should fail with parentID1 in idempotentIDsFound
					const childID2 = generateRequestID();
					try {
						await queue.add({ key: 'child2' }, { id: childID2, idempotentKeys: new Set([parentID1]) });
					} catch (error: unknown) {
						expect(Errors.IdempotentExistsError.isInstance(error)).toBe(true);
						if (!Errors.IdempotentExistsError.isInstance(error)) {
							throw(new Error('internal error: Error is not IdempotentExistsError'));
						}

						expect(error.idempotentIDsFound).toBeDefined();
						expect(error.idempotentIDsFound?.size).toBe(1);
						expect(error.idempotentIDsFound?.has(parentID1)).toBe(true);
					}

					// Add third child with multiple idempotent keys where none conflict - should succeed
					const childID3 = generateRequestID();
					await queue.add({ key: 'child3' }, { id: childID3, idempotentKeys: new Set([parentID2, parentID3]) });

					// Try to add fourth child where one idempotent ID conflicts - should fail with only conflicting idempotent ID in idempotentIDsFound
					const childID4 = generateRequestID();
					const parentID4 = generateRequestID();
					await queue.add({ key: 'parent4' }, { id: parentID4 });
					try {
						await queue.add({ key: 'child4' }, { id: childID4, idempotentKeys: new Set([parentID2, parentID4]) });
					} catch (error: unknown) {
						expect(Errors.IdempotentExistsError.isInstance(error)).toBe(true);
						if (!Errors.IdempotentExistsError.isInstance(error)) {
							throw(new Error('internal error: Error is not IdempotentExistsError'));
						}

						expect(error.idempotentIDsFound).toBeDefined();
						expect(error.idempotentIDsFound?.size).toBe(1);
						expect(error.idempotentIDsFound?.has(parentID2)).toBe(true);
						expect(error.idempotentIDsFound?.has(parentID4)).toBe(false);
					}

					// Try to add fifth child where multiple idempotent keys conflict - should fail with all conflicting idempotent IDs in idempotentIDsFound
					const childID5 = generateRequestID();
					try {
						await queue.add({ key: 'child5' }, { id: childID5, idempotentKeys: new Set([parentID1, parentID2, parentID3]) });
						expect.fail('Should have thrown an error');
					} catch (error: unknown) {
						expect(Errors.IdempotentExistsError.isInstance(error)).toBe(true);
						if (Errors.IdempotentExistsError.isInstance(error)) {
							expect(error.idempotentIDsFound).toBeDefined();
							expect(error.idempotentIDsFound?.size).toBe(3);
							expect(error.idempotentIDsFound?.has(parentID1)).toBe(true);
							expect(error.idempotentIDsFound?.has(parentID2)).toBe(true);
							expect(error.idempotentIDsFound?.has(parentID3)).toBe(true);
						}
					}
				});

				/* Test that we can query entries in various ways */
				testRunner('Query Entries', async function() {
					await using queueInfo = await driverConfig.create('query-entries');
					const localQueue = queueInfo.queue;

					const id1 = await localQueue.add({ key: 'query1' });
					const id2 = await localQueue.add({ key: 'query2' });
					const id3 = await localQueue.add({ key: 'query3' });
					const id4 = await localQueue.add({ key: 'query4' });

					await localQueue.setStatus(id2, 'completed', { output: 'done' });
					await localQueue.setStatus(id3, 'failed_temporarily');
					await localQueue.setStatus(id4, 'processing');

					for (const withLimit of [undefined, 10]) {
						const addQueryArgs: Parameters<typeof localQueue.query>[0] = {};
						if (withLimit !== undefined) {
							addQueryArgs.limit = withLimit;
						}

						const allEntries = await localQueue.query({ ...addQueryArgs });
						expect(allEntries.length).toEqual(4);

						const pendingEntries = await localQueue.query({ status: 'pending', ...addQueryArgs });
						expect(pendingEntries.length).toBe(1);
						expect(pendingEntries[0]?.id).toBe(id1);

						const completedEntries = await localQueue.query({ status: 'completed', ...addQueryArgs });
						expect(completedEntries.length).toBe(1);
						expect(completedEntries[0]?.id).toBe(id2);

						const failedEntries = await localQueue.query({ status: 'failed_temporarily', ...addQueryArgs });
						expect(failedEntries.length).toBe(1);
						expect(failedEntries[0]?.id).toBe(id3);

						const processingEntries = await localQueue.query({ status: 'processing', ...addQueryArgs });
						expect(processingEntries.length).toBe(1);
						expect(processingEntries[0]?.id).toBe(id4);
					}

					const limitedEntries = await localQueue.query({ limit: 2 });
					expect(limitedEntries.length).toBe(2);

					const futureDate = new Date(Date.now() + 100000);
					const updatedBeforeEntries = await localQueue.query({ updatedBefore: futureDate });
					expect(updatedBeforeEntries.length).toBe(4);

					const pastDate = new Date(Date.now() - 100000);
					const noEntriesBeforePast = await localQueue.query({ updatedBefore: pastDate });
					expect(noEntriesBeforePast.length).toBe(0);
				});

				/* Test that mutating the entry results does not affect the stored entry */
				testRunner('Entry Immutability', async function() {
					const id = await queue.add({ key: 'immutable', nested: { value: 42 }});
					const entry1 = await queue.get(id);
					expect(entry1).toBeDefined();

					if (entry1) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						const req1 = entry1.request as { key: string; nested: { value: number }};
						req1.key = 'modified';
						req1.nested.value = 99;
						entry1.status = 'completed';
					}

					const entry2 = await queue.get(id);
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					const req2 = entry2?.request as { key: string; nested: { value: number }};
					expect(req2.key).toBe('immutable');
					expect(req2.nested.value).toBe(42);
					expect(entry2?.status).toBe('pending');

					const entries = await queue.query({ status: 'pending' });
					if (entries.length > 0 && entries[0]) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						const req = entries[0].request as { key: string };
						req.key = 'altered';
						entries[0].status = 'aborted';
					}

					const entry3 = await queue.get(id);
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					const req3 = entry3?.request as { key: string };
					expect(req3.key).toBe('immutable');
					expect(entry3?.status).toBe('pending');
				});

				/* Test that errors are recorded in the entry correctly */
				testRunner('Error Recording', async function() {
					const entryID = await queue.add({ key: 'error_test' });
					await queue.setStatus(entryID, 'failed_temporarily', { error: 'Something went wrong' });

					const entryWithError = await queue.get(entryID);
					expect(entryWithError?.lastError).toBe('Something went wrong');
					expect(entryWithError?.status).toBe('failed_temporarily');
				});

				/* Test that marking a entry as `failed_temporarily` increments the failure count */
				testRunner('Failure Count Increment', async function() {
					const entryID = await queue.add({ key: 'failure_count_test' });
					const initialEntry = await queue.get(entryID);
					expect(initialEntry?.failures).toBe(0);

					await queue.setStatus(entryID, 'failed_temporarily');
					const afterFirstFailure = await queue.get(entryID);
					expect(afterFirstFailure?.failures).toBe(1);

					await queue.setStatus(entryID, 'pending');
					await queue.setStatus(entryID, 'failed_temporarily');
					const afterSecondFailure = await queue.get(entryID);
					expect(afterSecondFailure?.failures).toBe(2);

					await queue.setStatus(entryID, 'pending');
					await queue.setStatus(entryID, 'failed_temporarily');
					const afterThirdFailure = await queue.get(entryID);
					expect(afterThirdFailure?.failures).toBe(3);
				});

				/* Test that marking an entry as pending/completed does not reset the failure count */
				testRunner('Failure Count Persistence', async function() {
					const entryID = await queue.add({ key: 'failure_persist_test' });

					await queue.setStatus(entryID, 'failed_temporarily');
					await queue.setStatus(entryID, 'failed_temporarily');
					const afterFailures = await queue.get(entryID);
					expect(afterFailures?.failures).toBe(2);

					await queue.setStatus(entryID, 'pending');
					const afterPending = await queue.get(entryID);
					expect(afterPending?.failures).toBe(2);

					await queue.setStatus(entryID, 'completed', { output: 'done' });
					const afterCompleted = await queue.get(entryID);
					expect(afterCompleted?.failures).toBe(2);
				});

				/* Test that marking an entry as pending/completed clears the lastError */
				testRunner('Error Clearing', async function() {
					const entryID = await queue.add({ key: 'error_clear_test' });

					await queue.setStatus(entryID, 'failed_temporarily', { error: 'First error' });
					const afterFirstError = await queue.get(entryID);
					expect(afterFirstError?.lastError).toBe('First error');

					await queue.setStatus(entryID, 'pending');
					const afterPending = await queue.get(entryID);
					expect(afterPending?.lastError).toBeNull();

					await queue.setStatus(entryID, 'failed_temporarily', { error: 'Second error' });
					const afterSecondError = await queue.get(entryID);
					expect(afterSecondError?.lastError).toBe('Second error');

					await queue.setStatus(entryID, 'completed', { output: 'success' });
					const afterCompleted = await queue.get(entryID);
					expect(afterCompleted?.lastError).toBeNull();
				});

				/* Test that updating the status of a non-existent entry throws an error */
				testRunner('Set Status Non-Existent Entry', async function() {
					const nonExistentID = generateRequestID();

					await expect(queue.setStatus(nonExistentID, 'completed')).rejects.toThrow();
				});

				/* Test that the entry `updated` changes when the entry is modified */
				testRunner('Updated Timestamp Change', async function() {
					const entryID = await queue.add({ key: 'updated_test' });
					const initialEntry = await queue.get(entryID);
					expect(initialEntry).toBeDefined();
					const initialUpdated = initialEntry?.updated;
					expect(initialUpdated).toBeInstanceOf(Date);

					await asleep(10);

					await queue.setStatus(entryID, 'processing');
					const afterStatusChange = await queue.get(entryID);
					const updatedAfterChange = afterStatusChange?.updated;
					expect(updatedAfterChange).toBeInstanceOf(Date);
					expect(updatedAfterChange?.getTime()).toBeGreaterThan(initialUpdated?.getTime() ?? 0);
				});

				/* Test that the entry `created` is not changed */
				testRunner('Created Timestamp Immutability', async function() {
					const entryID = await queue.add({ key: 'created_test' });
					const initialEntry = await queue.get(entryID);
					expect(initialEntry).toBeDefined();
					const initialCreated = initialEntry?.created;
					expect(initialCreated).toBeInstanceOf(Date);

					await asleep(10);

					await queue.setStatus(entryID, 'processing');
					const afterFirstChange = await queue.get(entryID);
					expect(afterFirstChange?.created).toEqual(initialCreated);

					await queue.setStatus(entryID, 'completed', { output: 'result' });
					const afterSecondChange = await queue.get(entryID);
					expect(afterSecondChange?.created).toEqual(initialCreated);

					await queue.setStatus(entryID, 'failed_temporarily', { error: 'error' });
					const afterThirdChange = await queue.get(entryID);
					expect(afterThirdChange?.created).toEqual(initialCreated);
				});

				/* Test that many concurrent adds to different keys work correctly */
				testRunner('Concurrent Adds', async function() {
					const concurrentAdds = 50;
					const addPromises: Promise<KeetaAnchorQueueRequestID>[] = [];

					for (let index = 0; index < concurrentAdds; index++) {
						addPromises.push(queue.add({ key: `concurrent_add_${index}`, value: index }));
					}

					const ids = await Promise.all(addPromises);
					expect(ids).toHaveLength(concurrentAdds);

					const uniqueIDs = new Set(ids);
					expect(uniqueIDs.size).toBe(concurrentAdds);

					for (let index = 0; index < concurrentAdds; index++) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						const entry = await queue.get(ids[index] as KeetaAnchorQueueRequestID);
						expect(entry).toBeDefined();
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						const req = entry?.request as { key: string; value: number };
						expect(req.key).toMatch(/^concurrent_add_\d+$/);
						expect(req.value).toBeGreaterThanOrEqual(0);
						expect(req.value).toBeLessThan(concurrentAdds);
					}
				}, 60_000);

				/* Test that after adding a key, many concurrent changes to the same key are handled correctly (i.e., exactly one succeeds when using oldStatus all others fail) */
				testRunner('Concurrent Status Changes', async function() {
					await using queueLocal = await queue.partition('concurrent-status-changes');
					queueLocal._Testing?.(TestingKey).setToctouDelay?.(300);

					const entryID = await queueLocal.add({ key: 'concurrent_status_change' });
					const initialEntry = await queueLocal.get(entryID);
					expect(initialEntry?.status).toBe('pending');

					const concurrentUpdates = 20;
					const updatePromises: Promise<{ success: boolean; error?: unknown }>[] = [];

					for (let index = 0; index < concurrentUpdates; index++) {
						updatePromises.push((async function() {
							try {
								await queueLocal.setStatus(entryID, 'processing', { oldStatus: 'pending' });
								return({ success: true });
							} catch (error: unknown) {
								return({ success: false, error: error });
							}
						})());
					}

					const results = await Promise.all(updatePromises);

					const successCount = results.filter(function(result) {
						return(result.success);
					}).length;
					const failureCount = results.filter(function(result) {
						return(!result.success);
					}).length;

					expect(successCount).toBe(1);
					expect(failureCount).toBe(concurrentUpdates - 1);

					const finalEntry = await queueLocal.get(entryID);
					expect(finalEntry?.status).toBe('processing');
				}, 30_000);

				/* Test that inserting new keys with a common idempotent ID is handled correctly (i.e., only one insert succeeds, others fail with IdempotentExistsError) */
				testRunner('Concurrent Adds with Common Idempotent Key', async function() {
					const parentID = generateRequestID();
					await queue.add({ key: 'parent' }, { id: parentID });

					const concurrentAdds = 20;
					const addPromises: Promise<{ success: boolean; id?: KeetaAnchorQueueRequestID | undefined; idempotentIDsFound?: Set<KeetaAnchorQueueRequestID> | undefined }>[] = [];

					for (let index = 0; index < concurrentAdds; index++) {
						addPromises.push((async function() {
							try {
								const childID = generateRequestID();
								const id = await queue.add({ key: `child_${index}` }, { id: childID, idempotentKeys: new Set([parentID]) });
								return({ success: true, id: id, idempotentIDsFound: undefined });
							} catch (error: unknown) {
								if (Errors.IdempotentExistsError.isInstance(error)) {
									return({ success: false, id: undefined, idempotentIDsFound: error.idempotentIDsFound });
								}
								throw(error);
							}
						})());
					}

					const results = await Promise.all(addPromises);

					const successCount = results.filter(function(result) {
						return(result.success);
					}).length;
					const failureCount = results.filter(function(result) {
						return(!result.success);
					}).length;

					expect(successCount).toBe(1);
					expect(failureCount).toBe(concurrentAdds - 1);

					for (const result of results) {
						if (!result.success) {
							expect(result.idempotentIDsFound).toBeDefined();
							expect(result.idempotentIDsFound?.size).toBe(1);
							expect(result.idempotentIDsFound?.has(parentID)).toBe(true);
						}
					}
				}, 60_000);

				testRunner('Add by String ID', async function() {
					await using driverInstance = await driverConfig.create('string_id_test');
					const localQueue = driverInstance.queue;

					const runner = new KeetaAnchorQueueRunnerJSONConfigProc<{ key: string; }, null>({
						id: 'string_id_runner',
						processor: async function() {
							return({ status: 'completed', output: null });
						},
						queue: localQueue,
						logger: logger
					});
					const id = await runner.add({ key: 'string_id_one' }, { id: 'custom-string-id-one' });
					while (await runner.run()) {
						await asleep(50);
					}
					expect(id).toBe('custom-string-id-one');
					const status = await runner.get(id);
					expect(status?.status).toBe('completed');
				});

				/* Test that partitioning works and we can add and get entries from different partitions */
				testRunner('Partitioning', async function() {
					/* Ensure we can add and get from different partitions and they do not conflict */
					const id1 = await queue.add({ key: 'partition_test_1' });
					let id2: typeof id1;
					{
						await using partition1 = await queue.partition('partition1');
						await using partition2 = await queue.partition('partition2');
						id2 = await partition1.add({ key: 'partition_test_2' });
						const id3 = await partition2.add({ key: 'partition_test_3' });

						async function shouldNotHave(queueToCheck: typeof queue, id: typeof id1) {
							const value = await queueToCheck.get(id);
							expect(value).toBeNull();
						}

						const entry1 = await queue.get(id1);
						expect(entry1?.request).toEqual({ key: 'partition_test_1' });
						const entry2 = await partition1.get(id2);
						expect(entry2?.request).toEqual({ key: 'partition_test_2' });
						const entry3 = await partition2.get(id3);
						expect(entry3?.request).toEqual({ key: 'partition_test_3' });

						await shouldNotHave(partition1, id1);
						await shouldNotHave(partition2, id1);
						await shouldNotHave(queue, id2);
						await shouldNotHave(partition2, id2);
						await shouldNotHave(queue, id3);
						await shouldNotHave(partition1, id3);

						/* Ensure we can access the partition while the parent queue is still in use */
						const partition1_again = await queue.partition('partition1');
						const entry2_again = await partition1_again.get(id2);
						expect(entry2_again?.request).toEqual({ key: 'partition_test_2' });
					}

					/* Ensure we can access the partition again after all access has been closed */
					{
						const partition1_again = await queue.partition('partition1');
						const entry2_again = await partition1_again.get(id2);
						expect(entry2_again?.request).toEqual({ key: 'partition_test_2' });
					}

					/* Ensure we can use the same ID in two different partitions and they do not conflict */
					{
						await using partition3 = await queue.partition('partition3');

						const entry1 = await queue.get(id1);
						expect(entry1?.request).toEqual({ key: 'partition_test_1' });

						const id1_again = await partition3.add({ key: 'partition_test_1_again' }, { id: id1 });
						expect(id1_again).toBe(id1);

						const entry1_again = await queue.get(id1_again);
						expect(entry1_again?.request).toEqual({ key: 'partition_test_1' });

						const entry1_partition = await partition3.get(id1);
						expect(entry1_partition?.request).toEqual({ key: 'partition_test_1_again' });
					}
				});
			});

			if (driverConfig.persistent) {
				testRunner('Persistence Tests', async function() {
					const id1 = await (async function() {
						await using driverInstance = await driverConfig.create('persistence_test', { leave: true });
						const queue = driverInstance.queue;

						const id = await queue.add({ foo: 'bar' });

						return(id);
					})();

					const entry = await (async function() {
						await using driverInstance = await driverConfig.create('persistence_test');
						const queue = driverInstance.queue;
						const entry = await queue.get(id1);
						return(entry);
					})();

					expect(entry).toBeDefined();
					expect(entry?.request).toEqual({ foo: 'bar' });
					expect(entry?.status).toBe('pending');
					expect(entry?.id).toBe(id1);

					const [ part0_id1, part1_id1 ] = await (async function() {
						await using driverInstance = await driverConfig.create('partition_persistence_test', { leave: true });
						const queue = driverInstance.queue;

						await using partition = await queue.partition('part1');

						return([
							await queue.add({ partition: 'part0' }),
							await partition.add({ partition: 'part1' })
						]);
					})();

					const [ part0_entry, part1_entry ] = await (async function() {
						await using driverInstance = await driverConfig.create('partition_persistence_test');
						const queue = driverInstance.queue;

						await using partition = await queue.partition('part1');

						return([
							await queue.get(part0_id1),
							await partition.get(part1_id1)
						]);
					})();
					expect(part0_entry).toBeDefined();
					expect(part0_entry?.request).toEqual({ partition: 'part0' });
					expect(part1_entry).toBeDefined();
					expect(part1_entry?.request).toEqual({ partition: 'part1' });
				});
			}
		});
	}
});
