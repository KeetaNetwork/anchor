import { test, expect } from 'vitest';

import type {
	AnchorReference,
	AnchorStatusSource,
	AnchorTransferReader,
	StandardizedTransferStatus
} from './anchor-status.js';
import { AnchorStatusCacheMemory, AnchorTransactionStatus } from './anchor-status.js';
import { KeetaNet } from '../client/index.js';

type StatusPayload = { kind: string };

/**
 * A behavioral {@link AnchorStatusSource} that returns a fixed status and
 * records how often it resolves a reader and reads a status, so a test can
 * observe whether the cache short-circuited the provider.
 */
class CountingStatusSource implements AnchorStatusSource<StatusPayload> {
	readerCalls = 0;
	statusCalls = 0;
	readonly #status: StandardizedTransferStatus<StatusPayload>;

	constructor(status: StandardizedTransferStatus<StatusPayload>) {
		this.#status = status;
	}

	getReader(): Promise<AnchorTransferReader<StatusPayload> | null> {
		this.readerCalls += 1;
		const status = this.#status;
		const recordStatusCall = () => {
			this.statusCalls += 1;
		};

		const reader: AnchorTransferReader<StatusPayload> = {
			getTransferStatus(): Promise<StandardizedTransferStatus<StatusPayload>> {
				recordStatusCall();
				return(Promise.resolve(status));
			}
		};

		return(Promise.resolve(reader));
	}
}

function anchorKey(): AnchorReference {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	return(account.publicKeyString.get());
}

test.each([
	{ name: 'fx terminal', kind: 'fx', transactionID: 'fx-1', status: 'COMPLETE', expectedCalls: 1 },
	{ name: 'fx pending', kind: 'fx', transactionID: 'fx-2', status: 'PENDING', expectedCalls: 2 },
	{ name: 'asset-movement terminal', kind: 'assetMovement', transactionID: 'am-1', status: 'COMPLETE', expectedCalls: 1 },
	{ name: 'asset-movement pending', kind: 'assetMovement', transactionID: 'am-2', status: 'PENDING', expectedCalls: 2 }
])('caches only terminal statuses and skips the provider on a hit ($name)', async function({ kind, transactionID, status, expectedCalls }) {
	const source = new CountingStatusSource({ status, transactionID, transaction: { kind }});
	const subject = new AnchorTransactionStatus(source, new AnchorStatusCacheMemory<StatusPayload>());
	const anchor = anchorKey();

	const first = await subject.getStatus(anchor, transactionID);
	const second = await subject.getStatus(anchor, transactionID);

	expect(first).toEqual(second);

	/*
	 * A terminal status caches, so the second read resolves no reader and
	 * issues no status call; a non-terminal status is refetched every time.
	 */
	expect(source.readerCalls).toBe(expectedCalls);
	expect(source.statusCalls).toBe(expectedCalls);
});

test('reads every call when no cache is configured', async function() {
	const source = new CountingStatusSource({ status: 'COMPLETE', transactionID: 't', transaction: { kind: 'fx' }});
	const subject = new AnchorTransactionStatus(source);
	const anchor = anchorKey();

	await subject.getStatus(anchor, 't');
	await subject.getStatus(anchor, 't');

	expect(source.statusCalls).toBe(2);
});

test('keys terminal cache entries by an anchor account instance', async function() {
	const source = new CountingStatusSource({ status: 'COMPLETE', transactionID: 't', transaction: { kind: 'fx' }});
	const subject = new AnchorTransactionStatus(source, new AnchorStatusCacheMemory<StatusPayload>());
	const anchor = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	await subject.getStatus(anchor, 't');
	await subject.getStatus(anchor, 't');

	expect(source.statusCalls).toBe(1);
});

test('keeps distinct cache entries per anchor and transaction id', async function() {
	const source = new CountingStatusSource({ status: 'COMPLETE', transactionID: 'shared', transaction: { kind: 'fx' }});
	const subject = new AnchorTransactionStatus(source, new AnchorStatusCacheMemory<StatusPayload>());
	const anchorOne = anchorKey();
	const anchorTwo = anchorKey();

	await subject.getStatus(anchorOne, 'tx-a');
	await subject.getStatus(anchorTwo, 'tx-a');
	await subject.getStatus(anchorOne, 'tx-b');

	/*
	 * Three distinct keys, so each is a miss that reaches the provider.
	 */
	expect(source.statusCalls).toBe(3);
});
