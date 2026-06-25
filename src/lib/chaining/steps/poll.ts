import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { AssetMovementTransfer, FXExchange } from '../types.js';
import type { PollSettings } from './run.js';
import { AnchorChainingError } from '../errors.js';

const MAX_BACKOFF_MS = 8_000;

/**
 * Compute the next poll delay: a mild exponential ramp from the base interval,
 * capped, so fast-settling work is observed promptly while slow work does not
 * hammer the provider.
 */
function nextDelay(baseMs: number, attempt: number): number {
	const grown = baseMs * (1.5 ** attempt);
	return(Math.min(MAX_BACKOFF_MS, Math.round(grown)));
}

function assertNotAborted(poll: PollSettings, what: string): void {
	if (poll.abortSignal?.aborted) {
		throw(new AnchorChainingError('ABORTED', `Aborted while waiting for ${what}`));
	}
}

/**
 * Poll an FX exchange to completion, failing fast on a terminal `failed`
 * status and on deadline.
 */
export async function pollExchangeStatus(
	exchange: FXExchange,
	poll: PollSettings
): Promise<Extract<Awaited<ReturnType<FXExchange['getExchangeStatus']>>, { status: 'completed' }>> {
	const deadline = Date.now() + poll.timeoutMs;
	const exchangeID = exchange.exchange.exchangeID;
	for (let attempt = 0; ; attempt++) {
		assertNotAborted(poll, `FX exchange ${exchangeID} to complete`);

		const status = await exchange.getExchangeStatus();
		if (status.status === 'completed') {
			return(status);
		}
		if (status.status === 'failed') {
			throw(new AnchorChainingError('EXCHANGE_FAILED', `FX exchange ${exchangeID} failed`));
		}
		if (Date.now() >= deadline) {
			throw(new AnchorChainingError('POLL_TIMEOUT', `Timed out waiting for FX exchange ${exchangeID} to complete`));
		}

		await KeetaNet.lib.Utils.Helper.asleep(nextDelay(poll.intervalMs, attempt));
	}
}

/**
 * Poll a managed asset-movement transfer to a `COMPLETE` status, failing on
 * deadline.
 */
export async function pollTransferStatus(
	transfer: AssetMovementTransfer,
	poll: PollSettings
): Promise<Awaited<ReturnType<AssetMovementTransfer['getTransferStatus']>>> {
	const deadline = Date.now() + poll.timeoutMs;
	for (let attempt = 0; ; attempt++) {
		assertNotAborted(poll, `transfer ${transfer.transferID} to complete`);

		const status = await transfer.getTransferStatus();
		if (status.transaction.status === 'COMPLETE') {
			return(status);
		}
		if (Date.now() >= deadline) {
			throw(new AnchorChainingError('POLL_TIMEOUT', `Timed out waiting for transfer ${transfer.transferID} to complete`));
		}

		await KeetaNet.lib.Utils.Helper.asleep(nextDelay(poll.intervalMs, attempt));
	}
}
