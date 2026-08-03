import { test, expect, describe } from 'vitest';
import { createAnchorChainingPollRetryHandler } from './poll-retry.js';

type HandlerConfig = Parameters<typeof createAnchorChainingPollRetryHandler>[0];

/**
 * Handler wired for tests: backoff is compressed to about a millisecond so a
 * full retry budget costs single-digit milliseconds of real time. Tests that
 * assert on the delay itself override the options.
 */
function makeHandler(overrides?: Partial<HandlerConfig>) {
	return(createAnchorChainingPollRetryHandler({
		scope: 'test',
		deadline: Date.now() + 60_000,
		timeoutMessage: 'test timed out',
		options: { baseBackoffMs: 1, maxBackoffMs: 1 },
		...overrides
	}));
}

describe('poll-retry: consecutive failure budget', function() {
	test('tolerates 5 consecutive failures', async function() {
		const handler = makeHandler();

		for (let attempt = 0; attempt < 5; attempt++) {
			await handler.failure(new Error('blip'));
		}

		handler.success();
	});

	test('the sixth consecutive failure rethrows the identical object', async function() {
		const handler = makeHandler();
		const error = new Error('blip');

		for (let attempt = 0; attempt < 5; attempt++) {
			await handler.failure(error);
		}

		await expect(handler.failure(error)).rejects.toBe(error);
	});

	test('the counter resets on an interleaved success', async function() {
		const handler = makeHandler();
		const error = new Error('blip');

		for (let attempt = 0; attempt < 5; attempt++) {
			await handler.failure(error);
		}

		handler.success();

		/*
		 * Without the reset the first of these would already be failure six
		 * and would throw.
		 */
		for (let attempt = 0; attempt < 5; attempt++) {
			await handler.failure(error);
		}

		await expect(handler.failure(error)).rejects.toBe(error);
	});

	test('maxConsecutiveFailures 0 fails on the first error', async function() {
		const handler = makeHandler({ options: { maxConsecutiveFailures: 0 }});
		const error = new Error('blip');

		await expect(handler.failure(error)).rejects.toBe(error);
	});

	test('maxConsecutiveFailures is configurable upwards', async function() {
		const handler = makeHandler({ options: { maxConsecutiveFailures: 8, baseBackoffMs: 1, maxBackoffMs: 1 }});
		const error = new Error('blip');

		for (let attempt = 0; attempt < 8; attempt++) {
			await handler.failure(error);
		}

		await expect(handler.failure(error)).rejects.toBe(error);
	});
});

describe('poll-retry: deadline', function() {
	test('an expired deadline throws the timeout message preserving the cause', async function() {
		const handler = makeHandler({ deadline: Date.now() - 1 });
		const error = new Error('blip');

		const thrown = await handler.failure(error).then(function() {
			return(null);
		}, function(caught: unknown) {
			return(caught);
		});

		expect(thrown).toBeInstanceOf(Error);
		if (!(thrown instanceof Error)) {
			throw(new Error('Expected an Error'));
		}

		expect(thrown.message).toEqual('test timed out');
		expect(thrown.cause).toBe(error);
	});

	test('the budget is consulted before the deadline', async function() {
		const handler = makeHandler({ deadline: Date.now() - 1, options: { maxConsecutiveFailures: 0 }});
		const error = new Error('blip');

		/*
		 * Both are exhausted at once, so the caller gets the diagnostic
		 * provider error rather than a bare timeout.
		 */
		await expect(handler.failure(error)).rejects.toBe(error);
	});

	test('the backoff sleep is clipped to the remaining budget', async function() {
		const handler = makeHandler({
			deadline: Date.now() + 30,
			options: { baseBackoffMs: 10_000, maxBackoffMs: 10_000 }
		});

		const startedAt = Date.now();
		await handler.failure(new Error('blip'));

		expect(Date.now() - startedAt).toBeLessThan(500);
	});
});

describe('poll-retry: abort', function() {
	test('an aborted signal returns instead of throwing and never counts the failure', async function() {
		const controller = new AbortController();
		controller.abort();

		const handler = makeHandler({ abortSignal: controller.signal });
		const error = new Error('blip');

		/*
		 * Far more than the budget. The loop that owns this handler throws its
		 * own abort message at the top of the next iteration, so the handler
		 * must stay silent.
		 */
		for (let attempt = 0; attempt < 10; attempt++) {
			await handler.failure(error);
		}
	});
});

describe('poll-retry: backoff', function() {
	test('equal jitter never sleeps less than half the configured delay', async function() {
		const handler = makeHandler({ options: { baseBackoffMs: 40, maxBackoffMs: 40 }});

		const startedAt = Date.now();
		await handler.failure(new Error('blip'));
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeGreaterThanOrEqual(18);
		expect(elapsed).toBeLessThan(500);
	});

	test('the delay grows with consecutive failures and is capped', async function() {
		const handler = makeHandler({ options: { baseBackoffMs: 20, maxBackoffMs: 160 }});
		const delays: number[] = [];

		for (let attempt = 0; attempt < 4; attempt++) {
			const startedAt = Date.now();
			await handler.failure(new Error('blip'));
			delays.push(Date.now() - startedAt);
		}

		const first = delays[0];
		const fourth = delays[3];
		if (first === undefined || fourth === undefined) {
			throw(new Error('Expected four measured delays'));
		}

		/*
		 * Un-jittered the schedule is 20, 40, 80, 160, so with equal jitter the
		 * first sleep is at most 20ms and the fourth is at least 80ms.
		 */
		expect(first).toBeLessThan(60);
		expect(fourth).toBeGreaterThanOrEqual(70);
		expect(fourth).toBeGreaterThan(first);
	});
});
