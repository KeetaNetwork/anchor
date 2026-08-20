import { test, expect } from 'vitest';

import type { TransferStatus } from './transfer-status.js';
import { KeetaAssetMovementTransferError } from './transfer-error.js';
import {
	TransferStatuses,
	TransferStatusInfos,
	TransferTransitions,
	assertTransition,
	canTransition,
	isTransferStatus,
	isTerminalTransferStatus
} from './transfer-status.js';

const legalPairs: [TransferStatus, TransferStatus][] = [];
const illegalPairs: [TransferStatus, TransferStatus][] = [];

for (const from of TransferStatuses) {
	for (const to of TransferStatuses) {
		if (TransferTransitions[from].includes(to)) {
			legalPairs.push([ from, to ]);
		} else {
			illegalPairs.push([ from, to ]);
		}
	}
}

const terminalCases: [TransferStatus, boolean][] = [
	[ 'CREATED', false ],
	[ 'AWAITING_ACTION', false ],
	[ 'AWAITING_DEPOSIT', false ],
	[ 'DEPOSIT_SUBMITTED', false ],
	[ 'DEPOSIT_CONFIRMED', false ],
	[ 'PROCESSING', false ],
	[ 'WITHDRAW_SUBMITTED', false ],
	[ 'WITHDRAW_CONFIRMING', false ],
	[ 'FINALIZING', false ],
	[ 'REVERSING', false ],
	[ 'COMPLETE', true ],
	[ 'CANCELED', true ],
	[ 'FAILED', true ],
	[ 'REVERSED', true ],
	[ 'RETURNED', true ]
];

function transitionErrorCode(from: TransferStatus, to: TransferStatus): string {
	try {
		assertTransition(from, to);
		return('NONE');
	} catch (error) {
		if (KeetaAssetMovementTransferError.isInstance(error)) {
			return(error.code);
		}

		return('OTHER');
	}
}

function compareTransferStatusKeys(a: string, b: string): number {
	return(a.localeCompare(b));
}

test('every status has transition and metadata entries', function() {
	const statuses = [ ...TransferStatuses ].sort(compareTransferStatusKeys);
	expect(Object.keys(TransferTransitions).sort(compareTransferStatusKeys)).toEqual(statuses);
	expect(Object.keys(TransferStatusInfos).sort(compareTransferStatusKeys)).toEqual(statuses);
});

test.each(legalPairs)('legal transition %s -> %s', function(from, to) {
	expect(canTransition(from, to)).toBe(true);
	expect(transitionErrorCode(from, to)).toBe('NONE');
});

test.each(illegalPairs)('illegal transition %s -> %s', function(from, to) {
	expect(canTransition(from, to)).toBe(false);
	expect(transitionErrorCode(from, to)).toBe('ILLEGAL_TRANSITION');
});

test.each(terminalCases)('terminal flag for %s', function(status, expected) {
	expect(isTerminalTransferStatus(status)).toBe(expected);
});

test('isTransferStatus narrows known and rejects unknown values', function() {
	expect(isTransferStatus('COMPLETE')).toBe(true);
	expect(isTransferStatus('NOT_A_STATUS')).toBe(false);
});
