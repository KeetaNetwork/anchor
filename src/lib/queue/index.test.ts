import { test, expect, suite, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from '../log/index.ts';
import { asleep } from '../utils/asleep.js';
import { AsyncDisposableStack } from '../utils/defer.js';
import type { JSONSerializable } from '../utils/json.ts';

import {
	KeetaAnchorQueueRunnerJSON,
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

import { KeetaAnchorQueueStorageDriverFile } from './drivers/queue_file.js';

const DEBUG = false;
import { KeetaAnchorQueueStorageDriverSQLite3 } from './drivers/queue_sqlite3.js';
import * as sqlite from 'sqlite';
import * as sqlite3 from 'sqlite3';

let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

const RunKey = crypto.randomUUID();
function generateRequestID(): KeetaAnchorQueueRequestID {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(crypto.randomUUID() as unknown as KeetaAnchorQueueRequestID);
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
							} catch (error) {
								/* Ignore */
							}
						}
					}
				}
			});
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
		logger: logger
	});

	const processCallCountByKey = new Map<string, number>();
	await using runner = new KeetaAnchorQueueRunnerJSON<RequestType, ResponseType>({
		queue: queue,
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
		logger: logger
	});

	/*
	 * Set some lower timeouts and retry counts for testing
	 *
	 * These might move to supported interfaces in the future
	 */
	runner._testingSetParams('bc81abf8-e43b-490b-b486-744fb49a5082', 100, 100, 3);

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
		await runner._testingQueue('bc81abf8-e43b-490b-b486-744fb49a5082').setStatus(id, 'processing', { oldStatus: 'pending' });
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
		const before_any_jobs = await runner.run(0);
		expect(before_any_jobs).toBe(false);

		const id_1 = await runner.add({ key: 'timedout_late_two', newStatus: 'completed' });
		const id_2 = await runner.add({ key: 'timedout_late_two', newStatus: 'completed' });
		{
			const after_jobs_before_processing = await runner.run(0);
			expect(after_jobs_before_processing).toBe(true);
			const status_1 = await runner.get(id_1);
			const status_2 = await runner.get(id_2);
			expect(status_1?.status).toBe('pending');
			expect(status_2?.status).toBe('pending');
		}
		{
			vi.useRealTimers();
			const after_jobs = await runner.run(10);
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

test('Pipeline Basic Tests', async function() {
	await using cleanup = new AsyncDisposableStack();
	vi.useFakeTimers();
	cleanup.defer(function() {
		vi.useRealTimers();
	});

	function createStage<INPUT extends JSONSerializable, OUTPUT extends JSONSerializable>(name: string, processor: (entry: KeetaAnchorQueueEntry<INPUT, OUTPUT>) => Promise<{ status: 'completed'; output: OUTPUT; }>) {
		return(new KeetaAnchorQueueRunnerJSON<INPUT, OUTPUT>({
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
	stage1._testingSetParams('bc81abf8-e43b-490b-b486-744fb49a5082', 100, 300_000, 10_000);
	stage2._testingSetParams('bc81abf8-e43b-490b-b486-744fb49a5082', 100, 300_000, 10_000);
	stage3._testingSetParams('bc81abf8-e43b-490b-b486-744fb49a5082', 100, 300_000, 10_000);
	stage4._testingSetParams('bc81abf8-e43b-490b-b486-744fb49a5082', 100, 300_000, 10_000);

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
		 * Extract the parent IDs from the final entries and ensure that
		 * they cover 4 of the original 5 IDs
		 */
		const finalEntryIDs = finalEntries.map(function(entry) {
			return([...(entry.parents ?? [])]);
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
			return([...(entry.parents ?? [])]);
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
let running  = false;
		let testRunner: any = function(...args: Parameters<typeof test.sequential>) {
			const fn = args[1];
			// @ts-ignore
			test.sequential(args[0], async function(...innerArgs) {
				if (running) {
					throw(new Error('Driver Tests: Concurrent test execution detected, tests must be run sequentially from: ' + args[0]));
				}
				running = true;
				console.log(`Driver Tests: Starting test '${args[0]}' for driver '${driver}'`);
				try {
					// @ts-ignore
					return(await fn(...innerArgs));
				} finally {
					running = false;
					console.log(`Driver Tests: Finished test '${args[0]}' for driver '${driver}'`);
				}
			}, ...args.slice(2));
		};
		if (shouldSkip) {
			suiteRunner = suite.skip;
			testRunner = test.skip;
		}

		suiteRunner(driver, function(): void {
			suite(`Basic Tests`, async function(): Promise<void> {
				let queue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>;
				let driverInstanceDestroy: () => Promise<void>;
				beforeAll(async function() {
					const driverInstance = await driverConfig.create('basic_test');
					queue = driverInstance.queue;
					driverInstanceDestroy = driverInstance[Symbol.asyncDispose].bind(driverInstance);
				});
				afterAll(async function() {
					await driverInstanceDestroy();
				});

				/* Test that we can add and get an entry */
				testRunner('Add and Get Entry', async function() {
					const id = await queue.add({ key: 'test1' });
					expect(id).toBeDefined();
					const entry = await queue.get(id);
					expect(entry).toBeDefined();
					expect(entry?.id).toBe(id);
					expect(entry?.request).toEqual({ key: 'test1' });
					expect(entry?.status).toBe('pending');
					expect(entry?.output).toBeNull();
					expect(entry?.lastError).toBeNull();
					expect(entry?.failures).toBe(0);
					expect(entry?.worker).toBeNull();
					expect(entry?.created).toBeInstanceOf(Date);
					expect(entry?.updated).toBeInstanceOf(Date);
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
				});

				/* Test that we can set status of an entry and that locking works (i.e. oldStatus must match) */
				testRunner('Set Status with oldStatus', async function() {
					const id = await queue.add({ key: 'test3' });
					await queue.setStatus(id, 'processing', { oldStatus: 'pending' });
					const entry = await queue.get(id);
					expect(entry?.status).toBe('processing');

					await expect(queue.setStatus(id, 'completed', { oldStatus: 'pending' })).rejects.toThrow();

					await queue.setStatus(id, 'completed', { oldStatus: 'processing' });
					const completedEntry = await queue.get(id);
					expect(completedEntry?.status).toBe('completed');
				}, 300_000);

				/* Test that we can add an entry with an ID that already exists and it does nothing (idempotent add) */
				testRunner('Idempotent Add', async function() {
					const customID = generateRequestID();
					const id1 = await queue.add({ key: 'first' }, { id: customID });
					expect(id1).toBe(customID);

					const id2 = await queue.add({ key: 'second' }, { id: customID });
					expect(id2).toBe(customID);

					const entry = await queue.get(customID);
					expect(entry?.request).toEqual({ key: 'first' });
				});

				/* Test that we can add an entry with parent and it fails if the parent exists with the appropriate error */
				testRunner('Add with Parents', async function() {
					const parentID1 = generateRequestID();
					const parentID2 = generateRequestID();
					const parentID3 = generateRequestID();
					await queue.add({ key: 'parent1' }, { id: parentID1 });
					await queue.add({ key: 'parent2' }, { id: parentID2 });
					await queue.add({ key: 'parent3' }, { id: parentID3 });

					// Add first child with one parent - should succeed
					const childID1 = generateRequestID();
					await queue.add({ key: 'child1' }, { id: childID1, parents: new Set([parentID1]) });

					// Try to add second child with same parent - should fail with parentID1 in parentIDsFound
					const childID2 = generateRequestID();
					try {
						await queue.add({ key: 'child2' }, { id: childID2, parents: new Set([parentID1]) });
					} catch (error: unknown) {
						expect(Errors.ParentExistsError.isInstance(error)).toBe(true);
						if (!Errors.ParentExistsError.isInstance(error)) {
							throw(new Error('internal error: Error is not ParentExistsError'));
						}

						expect(error.parentIDsFound).toBeDefined();
						expect(error.parentIDsFound?.size).toBe(1);
						expect(error.parentIDsFound?.has(parentID1)).toBe(true);
					}

					// Add third child with multiple parents where none conflict - should succeed
					const childID3 = generateRequestID();
					await queue.add({ key: 'child3' }, { id: childID3, parents: new Set([parentID2, parentID3]) });

					// Try to add fourth child where one parent conflicts - should fail with only conflicting parent in parentIDsFound
					const childID4 = generateRequestID();
					const parentID4 = generateRequestID();
					await queue.add({ key: 'parent4' }, { id: parentID4 });
					try {
						await queue.add({ key: 'child4' }, { id: childID4, parents: new Set([parentID2, parentID4]) });
					} catch (error: unknown) {
						expect(Errors.ParentExistsError.isInstance(error)).toBe(true);
						if (!Errors.ParentExistsError.isInstance(error)) {
							throw(new Error('internal error: Error is not ParentExistsError'));
						}

						expect(error.parentIDsFound).toBeDefined();
						expect(error.parentIDsFound?.size).toBe(1);
						expect(error.parentIDsFound?.has(parentID2)).toBe(true);
						expect(error.parentIDsFound?.has(parentID4)).toBe(false);
					}

					// Try to add fifth child where multiple parents conflict - should fail with all conflicting parents in parentIDsFound
					const childID5 = generateRequestID();
					try {
						await queue.add({ key: 'child5' }, { id: childID5, parents: new Set([parentID1, parentID2, parentID3]) });
						expect.fail('Should have thrown an error');
					} catch (error: unknown) {
						expect(Errors.ParentExistsError.isInstance(error)).toBe(true);
						if (Errors.ParentExistsError.isInstance(error)) {
							expect(error.parentIDsFound).toBeDefined();
							expect(error.parentIDsFound?.size).toBe(3);
							expect(error.parentIDsFound?.has(parentID1)).toBe(true);
							expect(error.parentIDsFound?.has(parentID2)).toBe(true);
							expect(error.parentIDsFound?.has(parentID3)).toBe(true);
						}
					}
				});

				/* Test that we can query entries in various ways */
				testRunner('Query Entries', async function() {
					const existingIDs = await queue.query();
					await queue.add({ key: 'query1' });
					const id2 = await queue.add({ key: 'query2' });
					const id3 = await queue.add({ key: 'query3' });

					await queue.setStatus(id2, 'completed', { output: 'done' });
					await queue.setStatus(id3, 'failed_temporarily');

					const allEntries = await queue.query();
					expect(allEntries.length).toEqual(existingIDs.length + 3);

					const pendingEntries = await queue.query({ status: 'pending' });
					expect(pendingEntries.some(function(entry) {
						// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
						const req = entry.request as { key?: string };
						return(req.key === 'query1');
					})).toBe(true);

					const completedEntries = await queue.query({ status: 'completed' });
					expect(completedEntries.some(function(entry) {
						return(entry.id === id2);
					})).toBe(true);

					const failedEntries = await queue.query({ status: 'failed_temporarily' });
					expect(failedEntries.some(function(entry) {
						return(entry.id === id3);
					})).toBe(true);

					const limitedEntries = await queue.query({ limit: 2 });
					expect(limitedEntries.length).toBeLessThanOrEqual(2);

					const futureDate = new Date(Date.now() + 100000);
					const updatedBeforeEntries = await queue.query({ updatedBefore: futureDate });
					expect(updatedBeforeEntries.length).toBeGreaterThanOrEqual(3);

					const pastDate = new Date(Date.now() - 100000);
					const noEntriesBeforePast = await queue.query({ updatedBefore: pastDate });
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
					const entryID = await queue.add({ key: 'concurrent_status_change' });
					const initialEntry = await queue.get(entryID);
					expect(initialEntry?.status).toBe('pending');

					const concurrentUpdates = 20;
					const updatePromises: Promise<{ success: boolean; error?: unknown }>[] = [];

					for (let index = 0; index < concurrentUpdates; index++) {
						updatePromises.push((async function() {
							try {
								await queue.setStatus(entryID, 'processing', { oldStatus: 'pending' });
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

					const finalEntry = await queue.get(entryID);
					expect(finalEntry?.status).toBe('processing');
				}, 60_000);

				/* Test that inserting new keys with a common parent ID is handled correctly (i.e., only one insert succeeds, others fail with parentIDsFound) */
				testRunner('Concurrent Adds with Common Parent', async function() {
					const parentID = generateRequestID();
					await queue.add({ key: 'parent' }, { id: parentID });

					const concurrentAdds = 20;
					const addPromises: Promise<{ success: boolean; id?: KeetaAnchorQueueRequestID | undefined; parentIDsFound?: Set<KeetaAnchorQueueRequestID> | undefined }>[] = [];

					for (let index = 0; index < concurrentAdds; index++) {
						addPromises.push((async function() {
							try {
								const childID = generateRequestID();
								const id = await queue.add({ key: `child_${index}` }, { id: childID, parents: new Set([parentID]) });
								return({ success: true, id: id, parentIDsFound: undefined });
							} catch (error: unknown) {
								if (Errors.ParentExistsError.isInstance(error)) {
									return({ success: false, id: undefined, parentIDsFound: error.parentIDsFound });
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
							expect(result.parentIDsFound).toBeDefined();
							expect(result.parentIDsFound?.size).toBe(1);
							expect(result.parentIDsFound?.has(parentID)).toBe(true);
						}
					}
				}, 60_000);
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
				});
			}
		});
	}
});
