/**
 * Generic retry with truncated exponential backoff.
 *
 * Ported from the Asset Movement Anchor SDK durability layer so both packages
 * share one retry policy shape.
 */

import type { Logger } from '../log/index.js';
import { KeetaAnchorError } from '../error.js';
import { asleep } from './asleep.js';

const DEFAULT_MAX_TOTAL_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export const RetryErrorCodes = [
	'INVALID_OPTION',
	'NON_ERROR_THROWN',
	'RETRY_EXHAUSTED'
] as const;

export type RetryErrorCode = typeof RetryErrorCodes[number];

/**
 * Diagnostic metadata captured when a retry budget is exhausted.
 */
export interface RetryExhaustedDetails {
	attempts: number;
	elapsedMs: number;
}

export interface RetryErrorOptions {
	retryExhausted?: RetryExhaustedDetails;
	cause?: unknown;
}

/**
 * Error raised by {@link withRetry} when it gives up or is misconfigured.
 *
 * This error is raised and handled in-process, so unlike the service errors in
 * `lib/error.ts` it is not part of any wire protocol.
 */
export class KeetaAnchorRetryError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorRetryError';
	private readonly keetaAnchorRetryErrorObjectTypeID!: string;
	private static readonly keetaAnchorRetryErrorObjectTypeID = 'c2f6d0a1-9d2f-4a3b-9a24-8f5a1d0c7e63';
	readonly code: RetryErrorCode;
	readonly attempts?: number;
	readonly elapsedMs?: number;

	constructor(code: RetryErrorCode, message: string, options: RetryErrorOptions = {}) {
		super(message);

		this.code = code;
		this.statusCode = 500;

		if (options.retryExhausted !== undefined) {
			this.attempts = options.retryExhausted.attempts;
			this.elapsedMs = options.retryExhausted.elapsedMs;
		}

		if (options.cause !== undefined) {
			Object.defineProperty(this, 'cause', {
				value: options.cause,
				enumerable: false,
				writable: false,
				configurable: true
			});
		}

		Object.defineProperty(this, 'keetaAnchorRetryErrorObjectTypeID', {
			value: KeetaAnchorRetryError.keetaAnchorRetryErrorObjectTypeID,
			enumerable: false
		});
	}

	static override isInstance(input: unknown): input is KeetaAnchorRetryError {
		return(this.hasPropWithValue(input, 'keetaAnchorRetryErrorObjectTypeID', KeetaAnchorRetryError.keetaAnchorRetryErrorObjectTypeID));
	}
}

/**
 * Strategy for computing the next backoff delay.
 */
export type BackoffStrategy = (attempt: number) => number;

/**
 * Options for {@link withRetry}.
 */
export interface RetryOptions {
	maxAttempts?: number;
	maxTotalMs?: number;
	backoff?: BackoffStrategy;
	isRetryable?: (err: unknown) => boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	logger?: Logger | undefined;
	loggerContext?: string;
}

export type PublicRetryOptions = Omit<RetryOptions, 'isRetryable' | 'logger' | 'loggerContext'>;

/**
 * Truncated exponential backoff with random jitter.
 *
 * @see {@link https://cloud.google.com/storage/docs/retry-strategy#exponential-backoff | Google Cloud: truncated exponential backoff}
 */
export function jitteredBackoff(input: { baseMs: number; maxMs: number }): BackoffStrategy {
	return(function(attempt) {
		const cap = Math.min(input.maxMs, input.baseMs * (2 ** attempt));
		const delay = Math.round(Math.random() * cap);
		return(delay);
	});
}

const DEFAULT_BACKOFF: BackoffStrategy = jitteredBackoff({
	baseMs: DEFAULT_BASE_BACKOFF_MS,
	maxMs: DEFAULT_MAX_BACKOFF_MS
});

/**
 * Default retry gate.
 */
function defaultIsRetryable(err: unknown): boolean {
	if (KeetaAnchorError.isInstance(err)) {
		return(err.retryable);
	}

	return(false);
}

/**
 * Normalize an unknown thrown value into an `Error` instance.
 */
function toError(err: unknown): Error {
	if (err instanceof Error) {
		return(err);
	}

	return(new KeetaAnchorRetryError('NON_ERROR_THROWN', `withRetry: non-Error thrown: ${String(err)}`));
}

/**
 * Read a numeric `retryAfterMs` hint from a thrown error, if present.
 */
function readRetryAfterMs(err: unknown): number | undefined {
	if (err === null || typeof err !== 'object' || !('retryAfterMs' in err)) {
		return(undefined);
	}

	const candidate: unknown = err.retryAfterMs;
	if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
		return(undefined);
	}

	return(candidate);
}

/**
 * Run `fn` with backoff between attempts. Stops on a non-retryable error,
 * once `maxTotalMs` is exhausted, or once `maxAttempts` is reached.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
	if (Number.isNaN(maxAttempts) || maxAttempts < 1) {
		throw(new KeetaAnchorRetryError('INVALID_OPTION', `withRetry: maxAttempts must be >= 1 (got ${maxAttempts})`));
	}

	const maxTotalMs = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
	if (!Number.isFinite(maxTotalMs) || maxTotalMs < 0) {
		throw(new KeetaAnchorRetryError('INVALID_OPTION', `withRetry: maxTotalMs must be >= 0 and finite (got ${maxTotalMs})`));
	}

	const backoff = options.backoff ?? DEFAULT_BACKOFF;
	const isRetryable = options.isRetryable ?? defaultIsRetryable;
	const sleep = options.sleep ?? asleep;
	const now = options.now ?? Date.now;
	const logger = options.logger;
	const context = options.loggerContext ?? 'withRetry';

	const startMs = now();
	let lastError: unknown;
	let attemptsMade = 0;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		attemptsMade = attempt + 1;
		try {
			const result = await fn();
			return(result);
		} catch (err) {
			lastError = err;

			if (!isRetryable(err)) {
				throw(toError(err));
			}

			if (attempt >= maxAttempts - 1) {
				break;
			}

			const elapsedMs = now() - startMs;
			const remainingMs = maxTotalMs - elapsedMs;
			if (remainingMs <= 0) {
				break;
			}

			const retryAfterMs = readRetryAfterMs(err);
			const baseDelay = retryAfterMs ?? backoff(attempt);
			const delay = Math.max(0, Math.min(baseDelay, remainingMs));

			logger?.debug(context, `Retrying in ${delay}ms (attempt ${attempt + 1}, elapsed ${elapsedMs}ms / budget ${maxTotalMs}ms)`, { err });
			await sleep(delay);
		}
	}

	const elapsedMs = now() - startMs;
	const cause = toError(lastError);
	throw(new KeetaAnchorRetryError(
		'RETRY_EXHAUSTED',
		`withRetry: exhausted after ${attemptsMade} attempt(s) in ${elapsedMs}ms (budget ${maxTotalMs}ms): ${cause.message}`,
		{ retryExhausted: { attempts: attemptsMade, elapsedMs }, cause }
	));
}
