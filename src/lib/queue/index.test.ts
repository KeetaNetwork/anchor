import { test, expect, vi } from 'vitest';
import type { Logger } from '../log/index.ts';
import {
	KeetaAnchorQueueStorageRunnerJSON,
	KeetaAnchorQueueStorageDriverMemory
} from './index.js';
import type {
	KeetaAnchorQueueStatus
} from './index.ts';
import { asleep } from '../utils/asleep.js';
import { AsyncDisposableStack } from '../utils/defer.js';

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

test('Runner Basic Tests', async function() {
	await using cleanup = new AsyncDisposableStack();
	vi.useFakeTimers();
	cleanup.defer(function() {
		vi.useRealTimers();
	});

	await using queue = new KeetaAnchorQueueStorageDriverMemory({
		logger: logger
	});

	const processCallCountByKey = new Map<string, number>();
	await using runner = new KeetaAnchorQueueStorageRunnerJSON<RequestType, ResponseType>({
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
