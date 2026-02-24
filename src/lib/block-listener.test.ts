import { test, expect } from 'vitest';
import { BlockListener, BlockQueueRunner, OperationQueueRunner } from './block-listener.js';
import { createNodeAndClient } from './utils/tests/node.js';
import { KeetaNet } from '../client/index.js';
import { asleep } from './utils/asleep.js';
import { KeetaAnchorQueueStorageDriverMemory } from './queue/index.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import type { KeetaAnchorQueueEntry } from './queue/index.js';
import type { Logger } from './log/index.js';

const DEBUG = false;
let logger: Logger | undefined = undefined;
if (DEBUG) {
	logger = console;
}

test('BlockListener - registration, removal, scanning, and work status', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	const listener = new BlockListener({
		client: client.client,
		...(logger ? { logger } : {})
	});

	// Track blocks we've seen from this account using a Set
	const seenBlockHashes = new KeetaNet.lib.Block.Hash.Set();
	const callback = async function(data: { block: Block }) {
		// Only track blocks from our account
		if (data.block.account.comparePublicKey(client.account)) {
			seenBlockHashes.add(data.block.hash);
		}
		return({ requiresWork: false });
	};

	const registration = listener.on('block', { callback: callback });

	// Scan to get baseline of existing blocks from our account
	await listener.scan({ searchTo: { extended: true }});
	const initialBlockCount = seenBlockHashes.size;
	// User account starts with no blocks (give() creates block in REP account)
	expect(initialBlockCount).toBe(0);

	// Create a block and scan - track how many new blocks are created
	await client.setInfo({
		name: 'TEST_ACCOUNT',
		description: 'Test Description',
		metadata: ''
	});
	const blockHashAfterFirst = await client.head();

	if (!blockHashAfterFirst) {
		throw(new Error('Failed to retrieve head block hash after creating block'));
	}

	await listener.scan({ searchTo: { extended: true }});
	// Verify the new block was found
	expect(seenBlockHashes.has(blockHashAfterFirst)).toBe(true);
	const countAfterFirst = seenBlockHashes.size;
	const blocksCreatedByFirst = countAfterFirst - initialBlockCount;
	expect(blocksCreatedByFirst).toBeGreaterThan(0);

	// Create another block and scan - should create same number of blocks
	await client.setInfo({
		name: 'TEST_ACCOUNT_TWO',
		description: 'Test Description 2',
		metadata: ''
	});

	await listener.scan({ searchTo: { extended: true }});
	const countAfterSecond = seenBlockHashes.size;
	const blocksCreatedBySecond = countAfterSecond - countAfterFirst;
	// Second operation should create fewer blocks (account already open)
	expect(blocksCreatedBySecond).toBeGreaterThan(0);
	expect(blocksCreatedBySecond).toBeLessThanOrEqual(blocksCreatedByFirst);

	// Test timestamp scan - should find same blocks (no new blocks created)
	const countBeforeTimestampScan = seenBlockHashes.size;
	const oneHourAgo = Date.now() - (60 * 60 * 1000);
	await listener.scan({ searchTo: oneHourAgo });
	expect(seenBlockHashes.size).toBe(countBeforeTimestampScan);

	// Test listener removal - should not receive new blocks
	registration.remove();
	const countBeforeRemoval = seenBlockHashes.size;

	await client.setInfo({
		name: 'AFTER_REMOVAL',
		description: 'Should not be tracked',
		metadata: ''
	});

	await listener.scan({ searchTo: { extended: true }});
	expect(seenBlockHashes.size).toBe(countBeforeRemoval);

	// Test multiple listeners and work status aggregation
	let callback1Called = false;
	let callback2Called = false;

	listener.on('block', {
		callback: async function() {
			callback1Called = true;
			return({ requiresWork: false });
		}
	});

	listener.on('block', {
		callback: async function() {
			callback2Called = true;
			return({ requiresWork: true });
		}
	});

	await client.setInfo({
		name: 'MULTI_LISTENER_TEST',
		description: 'Testing multiple listeners',
		metadata: ''
	});

	const resultWithWork = await listener.scan();
	expect(callback1Called).toBe(true);
	expect(callback2Called).toBe(true);
	expect(resultWithWork.listenersHaveWork).toBe(true);

	// Test error handling - errors in callbacks should not prevent other callbacks
	const listener2 = new BlockListener({
		client: client.client,
		...(logger ? { logger } : {})
	});

	let errorCallbackRan = false;
	let successCallbackRan = false;

	listener2.on('block', {
		callback: async function() {
			errorCallbackRan = true;
			throw(new Error('Callback error'));
		}
	});

	listener2.on('block', {
		callback: async function() {
			successCallbackRan = true;
			return({ requiresWork: false });
		}
	});

	await client.setInfo({
		name: 'ERROR_TEST',
		description: 'Testing error handling',
		metadata: ''
	});

	const errorResult = await listener2.scan();
	expect(errorCallbackRan).toBe(true);
	expect(successCallbackRan).toBe(true);
	expect(errorResult.listenersHaveWork).toBe(false);
});

test('BlockQueueRunner - scan control and async filtering', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	await using noScanRunner = new (class extends BlockQueueRunner<null, null> {
		filterBlock(): boolean {
			return(true);
		}

		protected async processor(): Promise<{ status: 'completed'; output: null }> {
			return({ status: 'completed', output: null });
		}
	})({
		listener: { client: client.client },
		queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'test-no-scan' }),
		scanOptions: { scanWhenRunning: false }
	});

	await client.setInfo({
		name: 'NO_SCAN_TEST',
		description: 'Testing with scanning disabled',
		metadata: ''
	});

	const result = await noScanRunner.run();
	expect(result).toBe(false);

	// Test async filtering with automatic scanning
	const asyncProcessedBlocks = new KeetaNet.lib.Block.Hash.Set();

	await using asyncFilterRunner = new (class extends BlockQueueRunner<null, null> {
		async filterBlock(block: Block): Promise<boolean> {
			await asleep(10);
			return(block.operations.length > 0 && block.account.comparePublicKey(client.account));
		}

		protected async processor(entry: KeetaAnchorQueueEntry<{ blockHash: InstanceType<typeof KeetaNet.lib.Block.Hash> }, null>): Promise<{ status: 'completed'; output: null }> {
			asyncProcessedBlocks.add(entry.request.blockHash);
			return({ status: 'completed', output: null });
		}
	})({
		listener: { client: client.client },
		queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'test-async-filter' }),
		scanOptions: {
			scanWhenRunning: true,
			extendedScanIntervalMs: 1000,
			regularScanIntervalMs: 100
		}
	});

	// Create a block and run - first run does extended scan
	await client.setInfo({
		name: 'ASYNC_BLOCK_FILTER_TEST',
		description: 'Testing async block filtering',
		metadata: ''
	});
	const firstBlockHash = await client.head();
	if (!firstBlockHash) {
		throw(new Error('Failed to retrieve head block hash after creating block'));
	}

	await asleep(100);
	await asyncFilterRunner.run();

	// Should have processed the first block
	expect(asyncProcessedBlocks.has(firstBlockHash)).toBe(true);
	const countAfterFirst = asyncProcessedBlocks.size;

	// Wait for regular scan interval to elapse
	await asleep(150);

	// Create another block
	await client.setInfo({
		name: 'ASYNC_BLOCK_FILTER_TEST_TWO',
		description: 'Testing incremental scanning',
		metadata: ''
	});
	const secondBlockHash = await client.head();

	if (!secondBlockHash) {
		throw(new Error('Failed to retrieve head block hash after creating second block'));
	}

	// Run again - should do regular scan from last scan time
	await asyncFilterRunner.run();

	// Should have processed the second block
	expect(asyncProcessedBlocks.has(secondBlockHash)).toBe(true);
	expect(asyncProcessedBlocks.size).toBeGreaterThan(countAfterFirst);
});

test('Block Operation Runner shared Listener', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const anotherAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client, give } = await createNodeAndClient(account);

	await give(anotherAccount, 100n);

	// Create a shared listener
	const listener = new BlockListener({
		client: client.client,
		...(logger ? { logger } : {})
	});

	// Create some blocks to process
	await client.setInfo({
		name: 'BLOCK_HASH_TEST',
		description: 'Testing block hash tracking',
		metadata: ''
	});

	await client.send(anotherAccount, 5n, client.baseToken);
	await asleep(100);

	// Get the head block hash (the send block we just created)
	const headBlockHash = await client.head();

	if (!headBlockHash) {
		throw(new Error('Failed to retrieve head block hash'));
	}

	const blockHashes = new KeetaNet.lib.Block.Hash.Set();
	const operationHashes = new Set<string>();

	const blockRunner = new (class extends BlockQueueRunner<null, null> {
		filterBlock(block: Block): boolean {
			// Only process the head block (send block)
			return(block.hash.compareHexString(headBlockHash));
		}

		protected async processor(entry: KeetaAnchorQueueEntry<{ blockHash: InstanceType<typeof KeetaNet.lib.Block.Hash> }, null>): Promise<{ status: 'completed'; output: null }> {
			blockHashes.add(entry.request.blockHash);
			return({ status: 'completed', output: null });
		}
	})({
		listener: listener,
		queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'test-block-request-id' }),
		scanOptions: { scanWhenRunning: false }
	});

	const operationRunner = new (class extends OperationQueueRunner<null, null> {
		filterOperation(operation: BlockOperations, context: { block: Block; operationIndex: number; }): boolean {
			// Only process operations from the head block
			return(context.block.hash.compareHexString(headBlockHash));
		}

		protected async processor(entry: KeetaAnchorQueueEntry<{ blockHash: InstanceType<typeof KeetaNet.lib.Block.Hash>; operationIndex: number }, null>): Promise<{ status: 'completed'; output: null }> {
			operationHashes.add(`${entry.request.blockHash.toString()}:${entry.request.operationIndex}`);
			return({ status: 'completed', output: null });
		}
	})({
		listener: listener,
		queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'test-op-request-id' }),
		scanOptions: { scanWhenRunning: false }
	});

	// Trigger scanning via the shared listener
	await listener.scan({ searchTo: { extended: true }});
	await blockRunner.run();
	await operationRunner.run();

	// Should process exactly 1 block (the send block)
	expect(blockHashes.size).toBe(1);
	// The send block has 1 SEND operation
	expect(operationHashes.size).toBe(1);

	// Verify the head block was processed using BlockHash.compareHexString()
	expect(blockHashes.has(headBlockHash)).toBe(true);

	try {
		await blockRunner.add({ blockHash: headBlockHash }, { id: 'wrong-id' });
		expect.fail('Should have thrown an error for mismatched ID');
	} catch (error) {
		if (!error || !(error instanceof Error)) {
			throw(new Error('Expected an error to be thrown'));
		}
		expect(error.message).toContain('must match the blockHash');
	}

	try {
		await operationRunner.add({ blockHash: headBlockHash, operationIndex: 0 }, { id: 'wrong-id' });
		expect.fail('Should have thrown an error for mismatched ID');
	} catch (error) {
		if (!error || !(error instanceof Error)) {
			throw(new Error('Expected an error to be thrown'));
		}
		expect(error.message).toContain('must match the blockHash');
	}
});
