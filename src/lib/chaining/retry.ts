import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { GenericAccount, TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Logger } from '../log/index.js';
import { AnchorChainingError } from './errors.js';

const DEFAULT_MAX_TOTAL_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Ledger/vote error codes that indicate a half-published or contended send the
 * account can recover and re-publish, rather than a terminal rejection.
 */
export const RECOVERABLE_LEDGER_CODES = [
	'LEDGER_SUCCESSOR_VOTE_EXISTS',
	'LEDGER_NOT_SUCCESSOR',
	'VOTE_EXPIRED',
	'LEDGER_NOT_EMPTY'
] as const;

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

function defaultSleep(ms: number): Promise<void> {
	return(new Promise(function(resolve) {
		setTimeout(resolve, ms);
	}));
}

/**
 * Default retry gate: only {@link KeetaAnchorError}s flagged retryable.
 */
function defaultIsRetryable(err: unknown): boolean {
	if (AnchorChainingError.isInstance(err)) {
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

	return(new AnchorChainingError('INTERNAL', `withRetry: non-Error thrown: ${String(err)}`, { cause: err }));
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
		throw(new AnchorChainingError('INTERNAL', `withRetry: maxAttempts must be >= 1 (got ${maxAttempts})`));
	}

	const maxTotalMs = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
	if (!Number.isFinite(maxTotalMs) || maxTotalMs < 0) {
		throw(new AnchorChainingError('INTERNAL', `withRetry: maxTotalMs must be >= 0 and finite (got ${maxTotalMs})`));
	}

	const backoff = options.backoff ?? DEFAULT_BACKOFF;
	const isRetryable = options.isRetryable ?? defaultIsRetryable;
	const sleep = options.sleep ?? defaultSleep;
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
	throw(new AnchorChainingError(
		'RECOVERABLE_SEND_FAILED',
		`withRetry: exhausted after ${attemptsMade} attempt(s) in ${elapsedMs}ms (budget ${maxTotalMs}ms): ${cause.message}`,
		{ cause }
	));
}

/**
 * Returns true when `err` is a Keeta ledger/vote error whose code indicates a
 * recoverable, re-publishable send (see {@link RECOVERABLE_LEDGER_CODES}).
 */
export function isRecoverableLedgerError(err: unknown): boolean {
	if (!KeetaNet.lib.Error.isInstance(err)) {
		return(false);
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(RECOVERABLE_LEDGER_CODES.includes(err.code as (typeof RECOVERABLE_LEDGER_CODES)[number]));
}

/**
 * Extract the first published block hash from a `send`/`publishBuilder` result.
 */
function firstPublishedBlockHash(published: Awaited<ReturnType<KeetaNet.UserClient['send']>>): string | undefined {
	let publishedBlocks;
	if ('blocks' in published) {
		publishedBlocks = published.blocks;
	} else {
		publishedBlocks = published.voteStaple.blocks;
	}

	const sendBlock = publishedBlocks[0];
	if (sendBlock === undefined) {
		return(undefined);
	}

	return(sendBlock.hash.toString());
}

/**
 * Parameters for a single recoverable Keeta send.
 */
export interface RecoverableSendParams {
	to: GenericAccount | string;
	value: bigint;
	token: TokenAddress | string;
	external?: string | undefined;
	account: InstanceType<typeof KeetaNet.lib.Account>;
}

/**
 * Options governing recovery and retry of {@link recoverableSend}.
 */
export interface RecoverableSendOptions {
	maxAttempts?: number;
	logger?: Logger | undefined;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Publish a Keeta send, recovering and re-publishing on recoverable
 * ledger/vote errors. On a recoverable error the account's pending block is
 * recovered (published) before the send is retried, so a contended or
 * half-published send is driven forward rather than left stranded.
 *
 * @returns The published send block hash, or `undefined` when the published
 *          result carried no blocks.
 */
export async function recoverableSend(
	client: KeetaNet.UserClient,
	params: RecoverableSendParams,
	options?: RecoverableSendOptions
): Promise<string | undefined> {
	const { to, value, token, external, account } = params;
	const logger = options?.logger;

	return(await withRetry(async function() {
		try {
			const published = await client.send(to, value, token, external, { account });
			return(firstPublishedBlockHash(published));
		} catch (err) {
			if (isRecoverableLedgerError(err)) {
				logger?.debug('recoverableSend', `Recoverable ledger error on send; attempting account recovery`, { err });
				try {
					const pending = await client.pendingBlock({ account });
					if (pending) {
						await client.recover(true, { account });
					}
				} catch (recoverErr) {
					logger?.debug('recoverableSend', `Account recovery attempt failed; will retry send`, { recoverErr });
				}
			}

			throw(err);
		}
	}, {
		maxAttempts: options?.maxAttempts ?? 3,
		isRetryable: isRecoverableLedgerError,
		loggerContext: 'recoverableSend',
		...(logger ? { logger } : {}),
		...(options?.sleep ? { sleep: options.sleep } : {})
	}));
}
