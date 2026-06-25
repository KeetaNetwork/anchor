import { test, expect, describe } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import {
	AnchorChainingError,
	RECOVERABLE_LEDGER_CODES,
	isRecoverableLedgerError,
	jitteredBackoff,
	withRetry
} from './index.js';

/**
 * A `fn` for {@link withRetry} that throws `error` on its first `failures`
 * invocations and then resolves with `value`, recording its call count.
 */
function failingThenSucceed<T>(failures: number, value: T, error: () => unknown): { fn: () => Promise<T>; calls: () => number } {
	let calls = 0;
	const fn = async (): Promise<T> => {
		calls++;
		if (calls <= failures) {
			throw(error());
		}

		return(value);
	};

	return({ fn, calls: () => calls });
}

/** A no-op clock and capturing sleep, so retries are deterministic and instant. */
function deterministicTiming(): { now: () => number; sleep: (ms: number) => Promise<void>; delays: number[] } {
	const delays: number[] = [];
	return({
		now: () => 0,
		sleep: async (ms: number) => { delays.push(ms); },
		delays
	});
}

describe('isRecoverableLedgerError', function() {
	test.each([ ...RECOVERABLE_LEDGER_CODES ])('treats Keeta ledger error %s as recoverable', function(code) {
		expect(isRecoverableLedgerError(new KeetaNet.lib.Error(code, ''))).toBe(true);
	});

	test.each([
		{ label: 'a non-recoverable Keeta code', value: new KeetaNet.lib.Error('LEDGER_INVALID_BALANCE', '') },
		{ label: 'a plain Error', value: new Error('LEDGER_SUCCESSOR_VOTE_EXISTS') },
		{ label: 'a chaining error', value: new AnchorChainingError('RECOVERABLE_SEND_FAILED') },
		{ label: 'a bare string', value: 'LEDGER_SUCCESSOR_VOTE_EXISTS' },
		{ label: 'undefined', value: undefined },
		{ label: 'null', value: null }
	])('does not treat $label as recoverable', function({ value }) {
		expect(isRecoverableLedgerError(value)).toBe(false);
	});
});

describe('jitteredBackoff', function() {
	test.each([ 0, 1, 2, 5, 10 ])('produces an integer delay within the truncated cap at attempt %i', function(attempt) {
		const backoff = jitteredBackoff({ baseMs: 500, maxMs: 30_000 });
		const cap = Math.min(30_000, 500 * (2 ** attempt));

		for (let i = 0; i < 50; i++) {
			const delay = backoff(attempt);
			expect(Number.isInteger(delay)).toBe(true);
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThanOrEqual(cap);
		}
	});
});

describe('withRetry', function() {
	test('returns the first result without sleeping when fn succeeds', async function() {
		const timing = deterministicTiming();
		const { fn, calls } = failingThenSucceed(0, 'ok', () => new Error('unused'));

		const result = await withRetry(fn, { now: timing.now, sleep: timing.sleep });
		expect(result).toEqual('ok');
		expect(calls()).toEqual(1);
		expect(timing.delays).toHaveLength(0);
	});

	test('rethrows a non-retryable error immediately', async function() {
		const timing = deterministicTiming();
		const { fn, calls } = failingThenSucceed(1, 'ok', () => new Error('terminal'));

		await expect(withRetry(fn, { now: timing.now, sleep: timing.sleep, isRetryable: () => false })).rejects.toThrow('terminal');
		expect(calls()).toEqual(1);
		expect(timing.delays).toHaveLength(0);
	});

	test('retries a retryable error and returns the eventual success', async function() {
		const timing = deterministicTiming();
		const { fn, calls } = failingThenSucceed(2, 'recovered', () => new Error('transient'));

		const result = await withRetry(fn, { now: timing.now, sleep: timing.sleep, isRetryable: () => true });
		expect(result).toEqual('recovered');
		expect(calls()).toEqual(3);
		expect(timing.delays).toHaveLength(2);
	});

	test('exhausts maxAttempts and throws a RECOVERABLE_SEND_FAILED error', async function() {
		const timing = deterministicTiming();
		const { fn, calls } = failingThenSucceed(Number.POSITIVE_INFINITY, 'never', () => new Error('still failing'));

		const error: unknown = await withRetry(fn, { now: timing.now, sleep: timing.sleep, isRetryable: () => true, maxAttempts: 3 }).catch((e: unknown) => e);
		expect(AnchorChainingError.isInstance(error)).toBe(true);
		if (AnchorChainingError.isInstance(error)) {
			expect(error.code).toEqual('RECOVERABLE_SEND_FAILED');
			expect(error.message).toContain('exhausted');
		}

		expect(calls()).toEqual(3);
	});

	test('stops once the maxTotalMs budget is exhausted', async function() {
		const delays: number[] = [];
		let clock = 0;
		const { fn, calls } = failingThenSucceed(Number.POSITIVE_INFINITY, 'never', () => new Error('slow upstream'));

		const error: unknown = await withRetry(fn, {
			now: () => clock,
			sleep: async (ms: number) => { delays.push(ms); clock += 2_000; },
			isRetryable: () => true,
			backoff: () => 10,
			maxAttempts: 10,
			maxTotalMs: 1_000
		}).catch((e: unknown) => e);
		expect(AnchorChainingError.isInstance(error)).toBe(true);
		expect(calls()).toEqual(2);
		expect(delays).toEqual([ 10 ]);
	});

	test('rejects an invalid maxAttempts before invoking fn', async function() {
		const { fn, calls } = failingThenSucceed(0, 'ok', () => new Error('unused'));

		const error: unknown = await withRetry(fn, { maxAttempts: 0 }).catch((e: unknown) => e);
		expect(AnchorChainingError.isInstance(error)).toBe(true);
		if (AnchorChainingError.isInstance(error)) {
			expect(error.code).toEqual('INTERNAL');
		}
		expect(calls()).toEqual(0);
	});

	test('honors a retryAfterMs hint over the backoff strategy', async function() {
		const timing = deterministicTiming();
		const hinted = () => Object.assign(new Error('rate limited'), { retryAfterMs: 50 });
		const { fn } = failingThenSucceed(1, 'ok', hinted);

		const result = await withRetry(fn, { now: timing.now, sleep: timing.sleep, isRetryable: () => true, backoff: () => 9_999 });
		expect(result).toEqual('ok');
		expect(timing.delays).toEqual([ 50 ]);
	});

	test('uses the backoff strategy when no retryAfterMs hint is present', async function() {
		const timing = deterministicTiming();
		const { fn } = failingThenSucceed(1, 'ok', () => new Error('transient'));

		const result = await withRetry(fn, { now: timing.now, sleep: timing.sleep, isRetryable: () => true, backoff: () => 123 });
		expect(result).toEqual('ok');
		expect(timing.delays).toEqual([ 123 ]);
	});
});
