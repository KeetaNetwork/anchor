import * as KeetaNet from "@keetanetwork/keetanet-client";
import type { Logger } from '../log/index.js';

export type AnchorChainingPollOptions = {
	maxConsecutiveFailures?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
};

interface AnchorChainingPollRetryHandlerConfig {
	/** Logger namespace, for example 'AnchorChainingPlan::pollTransferStatus'. */
	scope: string;

	/** Absolute wall-clock cutoff, shared with the poll loop that owns it. */
	deadline: number;

	/** Message thrown if the deadline is reached while retrying. */
	timeoutMessage: string;

	options?: AnchorChainingPollOptions | undefined;
	logger?: Logger | undefined;
	abortSignal?: AbortSignal | undefined;
}

const POLL_RETRY_DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const POLL_RETRY_DEFAULT_BASE_BACKOFF_MS = 1000;
const POLL_RETRY_DEFAULT_MAX_BACKOFF_MS = 8000;
const POLL_RETRY_BACKOFF_MULTIPLIER = 2;

/** Largest value setTimeout accepts before it overflows and fires immediately. */
const POLL_RETRY_MAX_TIMER_DELAY_MS = 2_147_483_647;

function computePollBackoffMs(consecutiveFailures: number, policy: Required<AnchorChainingPollOptions>, random: () => number = Math.random): number {
	if (consecutiveFailures < 1) {
		return(0);
	}

	const growth = policy.baseBackoffMs * (POLL_RETRY_BACKOFF_MULTIPLIER ** (consecutiveFailures - 1));
	const raw = Math.min(policy.maxBackoffMs, growth);
	const delay = Math.round((raw / 2) + (random() * (raw / 2)));

	return(Math.min(POLL_RETRY_MAX_TIMER_DELAY_MS, Math.max(0, delay)));
}

/**
 * Create the stateful failure handler one poll loop uses for its whole life.
 */
export function createAnchorChainingPollRetryHandler(config: AnchorChainingPollRetryHandlerConfig) {
	const policy = {
		maxConsecutiveFailures: config.options?.maxConsecutiveFailures ?? POLL_RETRY_DEFAULT_MAX_CONSECUTIVE_FAILURES,
		baseBackoffMs: config.options?.baseBackoffMs ?? POLL_RETRY_DEFAULT_BASE_BACKOFF_MS,
		maxBackoffMs: config.options?.maxBackoffMs ?? POLL_RETRY_DEFAULT_MAX_BACKOFF_MS
	};
	let consecutiveFailures = 0;

	return({
		success: function(): void {
			consecutiveFailures = 0;
		},
		failure: async function(error: unknown): Promise<void> {
			if (config.abortSignal?.aborted === true) {
				return;
			}

			consecutiveFailures++;

			if (consecutiveFailures > policy.maxConsecutiveFailures) {
				config.logger?.debug(config.scope, `Giving after ${consecutiveFailures} consecutive status failures`, error);
				throw(error);
			}

			const remainingMs = config.deadline - Date.now();
			if (remainingMs <= 0) {
				config.logger?.debug(config.scope, `Deadline reached while retrying after ${consecutiveFailures} consecutive status failures`, error);
				throw(new Error(config.timeoutMessage, { cause: error }));
			}

			const backoffMs = Math.min(computePollBackoffMs(consecutiveFailures, policy), remainingMs);
			config.logger?.debug(config.scope, `Status check failed (${consecutiveFailures} in a row), retrying in ${backoffMs}ms`, error);

			await KeetaNet.lib.Utils.Helper.asleep(backoffMs);
		}
	});
}
