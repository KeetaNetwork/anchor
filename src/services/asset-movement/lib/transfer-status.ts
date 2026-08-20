/**
 * The transfer state machine every asset-movement transaction follows.
 *
 * A transfer is a source deposit, a conversion, and a destination withdrawal,
 * with an optional finalize and a shared pre-flight and unwind path. The
 * statuses and transitions are drawn from ISO 20022 pacs.002.
 */

import { KeetaAssetMovementTransferError } from './transfer-error.js';

export const TransferStatuses = [
	/* Pre-flight */
	'CREATED',
	'AWAITING_ACTION',
	/* Source deposit (inbound) */
	'AWAITING_DEPOSIT',
	'DEPOSIT_SUBMITTED',
	'DEPOSIT_CONFIRMED',
	/* Conversion */
	'PROCESSING',
	/* Destination withdrawal (outbound) */
	'WITHDRAW_SUBMITTED',
	'WITHDRAW_CONFIRMING',
	/* Finalize (optional) */
	'FINALIZING',
	/* Terminal */
	'COMPLETE',
	'CANCELED',
	'FAILED',
	'REVERSING',
	'REVERSED',
	'RETURNED'
] as const;

export type TransferStatus = typeof TransferStatuses[number];

/**
 * Which part of the transfer a status belongs to.
 */
export type TransferCategory = 'none' | 'source' | 'conversion' | 'destination' | 'finalize' | 'unwind' | 'terminal';

/**
 * The processing phase: awaiting funds, submitted, confirming, settled, done.
 */
export type TransferPhase = 'setup' | 'awaiting_action' | 'awaiting_funds' | 'submitted' | 'confirming' | 'settled' | 'processing' | 'unwinding' | 'done';

/**
 * Static metadata describing a {@link TransferStatus}.
 */
export interface TransferStatusInfo {
	readonly category: TransferCategory;
	readonly phase: TransferPhase;

	/**
	 * Whether the transfer may still be cancelled with no value having moved.
	 */
	readonly cancelable: boolean;

	/**
	 * Whether the status is terminal (no further transitions advance it).
	 */
	readonly terminal: boolean;
}

export const TransferStatusInfos: Readonly<{ [status in TransferStatus]: TransferStatusInfo }> = {
	CREATED: { category: 'none', phase: 'setup', cancelable: true, terminal: false },
	AWAITING_ACTION: { category: 'source', phase: 'awaiting_action', cancelable: true, terminal: false },
	AWAITING_DEPOSIT: { category: 'source', phase: 'awaiting_funds', cancelable: true, terminal: false },
	DEPOSIT_SUBMITTED: { category: 'source', phase: 'submitted', cancelable: false, terminal: false },
	DEPOSIT_CONFIRMED: { category: 'source', phase: 'settled', cancelable: false, terminal: false },
	PROCESSING: { category: 'conversion', phase: 'processing', cancelable: false, terminal: false },
	WITHDRAW_SUBMITTED: { category: 'destination', phase: 'submitted', cancelable: false, terminal: false },
	WITHDRAW_CONFIRMING: { category: 'destination', phase: 'confirming', cancelable: false, terminal: false },
	FINALIZING: { category: 'finalize', phase: 'processing', cancelable: false, terminal: false },
	COMPLETE: { category: 'terminal', phase: 'done', cancelable: false, terminal: true },
	CANCELED: { category: 'terminal', phase: 'done', cancelable: false, terminal: true },
	FAILED: { category: 'terminal', phase: 'done', cancelable: false, terminal: true },
	REVERSING: { category: 'unwind', phase: 'unwinding', cancelable: false, terminal: false },
	REVERSED: { category: 'terminal', phase: 'done', cancelable: false, terminal: true },
	RETURNED: { category: 'terminal', phase: 'done', cancelable: false, terminal: true }
};

/**
 * The legal transitions of the machine. A status maps to the set of statuses
 * it may advance to.
 *
 * Terminal statuses map to an empty set.
 * Optional intermediate statuses may be skipped.
 */
export const TransferTransitions: Readonly<{ [status in TransferStatus]: readonly TransferStatus[] }> = {
	CREATED: [ 'AWAITING_ACTION', 'AWAITING_DEPOSIT', 'CANCELED', 'FAILED' ],
	AWAITING_ACTION: [ 'AWAITING_DEPOSIT', 'CANCELED', 'FAILED' ],
	AWAITING_DEPOSIT: [ 'DEPOSIT_SUBMITTED', 'DEPOSIT_CONFIRMED', 'CANCELED', 'FAILED' ],
	DEPOSIT_SUBMITTED: [ 'DEPOSIT_CONFIRMED', 'FAILED', 'REVERSING' ],
	DEPOSIT_CONFIRMED: [ 'PROCESSING', 'REVERSING' ],
	PROCESSING: [ 'WITHDRAW_SUBMITTED', 'REVERSING' ],
	WITHDRAW_SUBMITTED: [ 'WITHDRAW_CONFIRMING', 'FINALIZING', 'COMPLETE', 'FAILED', 'REVERSING' ],
	WITHDRAW_CONFIRMING: [ 'FINALIZING', 'COMPLETE', 'REVERSING' ],
	FINALIZING: [ 'COMPLETE', 'FAILED' ],
	COMPLETE: [ 'RETURNED' ],
	CANCELED: [],
	FAILED: [],
	REVERSING: [ 'REVERSED', 'FAILED' ],
	REVERSED: [],
	RETURNED: []
};

/**
 * Narrow an arbitrary string to a {@link TransferStatus}.
 */
export function isTransferStatus(value: string): value is TransferStatus {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(TransferStatuses.includes(value as TransferStatus));
}

/**
 * Is `true` once a transfer has reached a terminal status.
 */
export function isTerminalTransferStatus(status: TransferStatus): boolean {
	return(TransferStatusInfos[status].terminal);
}

/**
 * Whether `to` is a legal next status from `from`.
 */
export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
	const allowed = TransferTransitions[from];
	return(allowed.includes(to));
}

/**
 * Assert that `from -> to` is a legal transition, throwing a typed
 * {@link KeetaAssetMovementTransferError} otherwise.
 */
export function assertTransition(from: TransferStatus, to: TransferStatus): void {
	const allowed = TransferTransitions[from];
	if (allowed === undefined) {
		throw(new KeetaAssetMovementTransferError('UNKNOWN_STATUS', `Unknown transfer status "${from}"`));
	}
	if (!allowed.includes(to)) {
		throw(new KeetaAssetMovementTransferError('ILLEGAL_TRANSITION', `Illegal transfer transition "${from}" -> "${to}"`));
	}
}
