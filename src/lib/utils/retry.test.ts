import { describe, expect, it } from 'vitest';

import type { RetryOptions } from './retry.js';
import { KeetaAnchorError } from '../error.js';
import { KeetaAnchorRetryError, jitteredBackoff, withRetry } from './retry.js';

/**
 * A manually-advanced monotonic clock.
 */
interface NumericClock {
	now: () => number;
	advance: (ms: number) => void;
}

function numericClock(start = 0): NumericClock {
	let current = start;

	return({
		now: function() {
			return(current);
		},
		advance: function(ms) {
			current += ms;
		}
	});
}

interface RecordingSleep {
	sleep: (ms: number) => Promise<void>;
	observed: number[];
}

/**
 * A `sleep` that records each requested delay and advances `clock` by it
 * instead of waiting in real time.
 */
function recordingSleep(clock: NumericClock): RecordingSleep {
	const observed: number[] = [];

	const sleep = async function(ms: number): Promise<void> {
		observed.push(ms);
		clock.advance(ms);
		await Promise.resolve();
	};

	return({ sleep, observed });
}

/**
 * A retryable anchor error, standing in for the typed errors services raise
 * when they shed load.
 */
class RetryableTestError extends KeetaAnchorError {
	constructor(message: string) {
		super(message);

		this.retryable = true;
	}
}

type Outcome<T> = { ok: T } | { err: unknown };

interface Scripted<T> {
	fn: () => Promise<T>;
	calls: () => number;
}

/**
 * A `fn` that yields each outcome in order, throwing for `err` entries and
 * resolving for `ok` entries.
 */
function scriptedFn<T>(outcomes: Outcome<T>[]): Scripted<T> {
	let index = 0;

	return({
		fn: async function() {
			const outcome = outcomes[index];
			index++;

			if (outcome === undefined) {
				throw(new Error('scriptedFn: exhausted'));
			}

			if ('err' in outcome) {
				throw(outcome.err);
			}

			const result = await Promise.resolve(outcome.ok);
			return(result);
		},
		calls: function() {
			return(index);
		}
	});
}

interface RetryRun {
	settled: Promise<string>;
	observed: number[];
	calls: () => number;
}

/**
 * Drive `withRetry` over a scripted `fn` against a recording clock, exposing
 * the in-flight promise, the observed sleeps, and the attempt count.
 */
function runRetry(outcomes: Outcome<string>[], options: Partial<RetryOptions> = {}): RetryRun {
	const clock = numericClock();
	const { sleep, observed } = recordingSleep(clock);
	const script = scriptedFn<string>(outcomes);
	const settled = withRetry(script.fn, { now: clock.now, sleep, ...options });

	return({ settled, observed, calls: script.calls });
}

describe('jitteredBackoff', function() {
	const backoff = jitteredBackoff({ baseMs: 100, maxMs: 1_000 });

	it.each([
		{ attempt: 0, cap: 100 },
		{ attempt: 1, cap: 200 },
		{ attempt: 2, cap: 400 },
		{ attempt: 3, cap: 800 },
		{ attempt: 4, cap: 1_000 },
		{ attempt: 10, cap: 1_000 }
	])('attempt $attempt stays within [0, $cap]', function({ attempt, cap }) {
		const samples = Array.from({ length: 256 }, function() {
			return(backoff(attempt));
		});

		expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...samples)).toBeLessThanOrEqual(cap);
	});
});

/**
 * Default `isRetryable` only retries typed errors with `retryable=true`; tests
 * that drive raw `Error` failures must opt in explicitly.
 */
const ALWAYS_RETRY: RetryOptions['isRetryable'] = function() {
	return(true);
};

/**
 * Resolve `promise` and reflect a rejection into the value channel so a test
 * can assert on the thrown error without rebinding through a try/catch.
 */
async function caught(promise: Promise<unknown>): Promise<unknown> {
	const result = await promise.catch(function(err: unknown) {
		return(err);
	});
	return(result);
}

describe('withRetry happy paths', function() {
	interface HappyCase {
		name: string;
		outcomes: Outcome<string>[];
		options: Partial<RetryOptions>;
		expected: { value: string; observed: number[]; calls: number };
	}

	const cases: HappyCase[] = [
		{
			name: 'returns immediately on success without sleeping',
			outcomes: [ { ok: 'done' } ],
			options: { backoff: function() { return(50); } },
			expected: { value: 'done', observed: [], calls: 1 }
		},
		{
			name: 'retries a raw Error with backoff then succeeds when isRetryable opts in',
			outcomes: [ { err: new Error('boom') }, { err: new Error('boom') }, { ok: 'ok' } ],
			options: { maxTotalMs: 60_000, backoff: function() { return(50); }, isRetryable: ALWAYS_RETRY },
			expected: { value: 'ok', observed: [ 50, 50 ], calls: 3 }
		},
		{
			name: 'default isRetryable retries a typed error marked retryable',
			outcomes: [ { err: new RetryableTestError('rate limited') }, { ok: 'ok' } ],
			options: { maxTotalMs: 60_000, backoff: function() { return(50); } },
			expected: { value: 'ok', observed: [ 50 ], calls: 2 }
		},
		{
			name: 'honors retryAfterMs from the error over the backoff',
			outcomes: [ { err: Object.assign(new Error('rate'), { retryAfterMs: 200 }) }, { ok: 'ok' } ],
			options: { maxTotalMs: 60_000, backoff: function() { return(50); }, isRetryable: ALWAYS_RETRY },
			expected: { value: 'ok', observed: [ 200 ], calls: 2 }
		}
	];

	it.each(cases)('$name', async function({ outcomes, options, expected }) {
		const run = runRetry(outcomes, options);
		expect(await run.settled).toBe(expected.value);
		expect(run.observed).toEqual(expected.observed);
		expect(run.calls()).toBe(expected.calls);
	});
});

describe('withRetry non-retryable paths', function() {
	interface FatalCase {
		name: string;
		outcomes: Outcome<string>[];
		options: Partial<RetryOptions>;
		expectedMessage: string;
	}

	const cases: FatalCase[] = [
		{
			name: 'throws immediately when the gate forbids retry',
			outcomes: [ { err: new Error('fatal') }, { ok: 'never' } ],
			options: { isRetryable: function() { return(false); } },
			expectedMessage: 'fatal'
		},
		{
			name: 'default isRetryable does not retry a raw Error',
			outcomes: [ { err: new Error('raw') }, { ok: 'never' } ],
			options: {},
			expectedMessage: 'raw'
		}
	];

	it.each(cases)('$name', async function({ outcomes, options, expectedMessage }) {
		const run = runRetry(outcomes, options);

		await expect(run.settled).rejects.toThrow(expectedMessage);
		expect(run.observed).toEqual([]);
		expect(run.calls()).toBe(1);
	});

	it('rethrows the identical error object', async function() {
		const error = new Error('fatal');
		const run = runRetry([ { err: error } ], { isRetryable: function() { return(false); } });

		await expect(run.settled).rejects.toBe(error);
	});

	it('rejects an invalid maxAttempts', async function() {
		await expect(withRetry(async function() {
			return('never');
		}, { maxAttempts: 0 })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
	});
});

describe('withRetry abort', function() {
	it('throws ABORTED without calling fn when the signal is already aborted', async function() {
		const controller = new AbortController();
		controller.abort();

		const run = runRetry([ { ok: 'never' } ], { abortSignal: controller.signal });
		const settled = await caught(run.settled);

		expect(KeetaAnchorRetryError.isInstance(settled)).toBe(true);
		expect(settled).toMatchObject({ code: 'ABORTED' });
		expect(run.calls()).toBe(0);
	});

	it('stops retrying once the signal aborts, keeping the last error as cause', async function() {
		const controller = new AbortController();
		const error = new Error('blip');
		const outcomes: Outcome<string>[] = [ { err: error }, { err: error }, { ok: 'never' } ];

		const clock = numericClock();
		const script = scriptedFn<string>(outcomes);
		const observed: number[] = [];

		/*
		 * Abort while the second backoff is in flight, the window a caller
		 * cancelling mid-poll actually lands in.
		 */
		const sleep = async function(ms: number): Promise<void> {
			observed.push(ms);
			clock.advance(ms);
			if (observed.length === 2) {
				controller.abort();
			}
			await Promise.resolve();
		};

		const settled = await caught(withRetry(script.fn, {
			now: clock.now,
			sleep,
			maxTotalMs: 60_000,
			backoff: function() {
				return(50);
			},
			isRetryable: ALWAYS_RETRY,
			abortSignal: controller.signal
		}));

		expect(KeetaAnchorRetryError.isInstance(settled)).toBe(true);
		expect(settled).toMatchObject({ code: 'ABORTED', cause: error });
		expect(observed).toEqual([ 50, 50 ]);
		expect(script.calls()).toBe(2);
	});

	it('ignores the signal when it never aborts', async function() {
		const controller = new AbortController();
		const run = runRetry([ { err: new Error('blip') }, { ok: 'ok' } ], {
			maxTotalMs: 60_000,
			backoff: function() {
				return(50);
			},
			isRetryable: ALWAYS_RETRY,
			abortSignal: controller.signal
		});

		expect(await run.settled).toBe('ok');
		expect(run.observed).toEqual([ 50 ]);
	});
});

describe('withRetry exhaustion', function() {
	interface ExhaustionCase {
		name: string;
		outcomes: Outcome<string>[];
		options: Partial<RetryOptions>;
		expected: { attempts: number; observed: number[]; calls: number; causeMessage: string };
	}

	const cases: ExhaustionCase[] = [
		{
			name: 'after maxAttempts is exceeded',
			outcomes: [ { err: new Error('e1') }, { err: new Error('e2') }, { err: new Error('e3') } ],
			options: { maxAttempts: 3, maxTotalMs: 60_000, backoff: function() { return(10); }, isRetryable: ALWAYS_RETRY },
			expected: { attempts: 3, observed: [ 10, 10 ], calls: 3, causeMessage: 'e3' }
		},
		{
			name: 'when the budget clamps the next delay',
			outcomes: [ { err: new Error('b1') }, { err: new Error('b2') } ],
			options: { maxTotalMs: 100, backoff: function() { return(1_000); }, isRetryable: ALWAYS_RETRY },
			expected: { attempts: 2, observed: [ 100 ], calls: 2, causeMessage: 'b2' }
		}
	];

	it.each(cases)('throws RETRY_EXHAUSTED $name', async function({ outcomes, options, expected }) {
		const run = runRetry(outcomes, options);
		const settled = await caught(run.settled);
		const anyNumber: unknown = expect.any(Number);
		const causeMatcher: unknown = expect.objectContaining({ message: expected.causeMessage });

		expect(KeetaAnchorRetryError.isInstance(settled)).toBe(true);
		expect(settled).toMatchObject({
			code: 'RETRY_EXHAUSTED',
			attempts: expected.attempts,
			elapsedMs: anyNumber,
			cause: causeMatcher
		});
		expect(run.observed).toEqual(expected.observed);
		expect(run.calls()).toBe(expected.calls);
	});

	it('reports the cause message in the thrown message', async function() {
		const run = runRetry([ { err: new Error('still down') } ], { maxAttempts: 1, isRetryable: ALWAYS_RETRY });

		await expect(run.settled).rejects.toThrow('still down');
		expect(run.calls()).toBe(1);
	});
});
