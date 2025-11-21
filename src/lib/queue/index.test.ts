import { test, expect, vi } from 'vitest';
import type { Logger } from '../log/index.ts';
import {
	KeetaAnchorQueueRunnerJSON,
	KeetaAnchorQueueStorageDriverMemory
} from './index.js';
import type {
	KeetaAnchorQueueStatus,
	KeetaAnchorQueueEntry
} from './index.ts';
import { asleep } from '../utils/asleep.js';
import { AsyncDisposableStack } from '../utils/defer.js';
import type { JSONSerializable } from '../utils/json.ts';

const DEBUG = false;
let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

type RequestType = {
	key: string;
	newStatus: KeetaAnchorQueueStatus;
};

type ResponseType = string;

test('Queue Runner Basic Tests', async function() {
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
			return([...(entry.parentEntryIDs ?? [])]);
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
			return([...(entry.parentEntryIDs ?? [])]);
		}).flat();
		expect(finalEntryIDs).toHaveLength(2);
		expect(finalEntryIDs).toContain(finalLeftoverID);
		expect(finalEntryIDs).toContain(id6);
	}
});
