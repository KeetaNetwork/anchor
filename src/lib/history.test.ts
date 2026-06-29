// cspell:ignore airtel
import { test, expect } from 'vitest';

import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockJSONOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';

import type {
	AnchorOnChainReference,
	AnchorReference,
	AnchorStatusSource,
	AnchorTransferReader,
	StandardizedTransferStatus
} from './anchor-status.js';
import type {
	AssetLocationString,
	AssetOrPair,
	KeetaAssetMovementTransaction,
	MovableAsset
} from '../services/asset-movement/common.js';
import type {
	HistoryEntry,
	HistoryQuery,
	HistorySource,
	HistoryStaple,
	LogicalCounterparty,
	LogicalDirection,
	LogicalTransaction,
	LogicalTransactionStatus,
	LogicalTransactionType,
	UserHistoryConfig,
	UserHistoryListOptions
} from './history.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { FX, KeetaNet } from '../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from '../services/asset-movement/server.js';
import { KeetaNetFXAnchorHTTPServer } from '../services/fx/server.js';
import { AnchorExternal } from './anchor-external.js';
import { AnchorTransactionStatus, CompositeAnchorStatusSource } from './anchor-status.js';
import { UserHistory, foldChains } from './history.js';
import { KeetaAnchorQueueStorageDriverMemory } from './queue/index.js';
import { asleep } from './utils/asleep.js';
import { Buffer } from './utils/buffer.js';
import { createNodeAndClient } from './utils/tests/node.js';
import KeetaAssetMovementStatusSource from '../services/asset-movement/status-source.js';
import KeetaFXStatusSource from '../services/fx/status-source.js';
import Resolver from './resolver.js';

type TransactionStatus = KeetaAssetMovementTransaction['status'];

type Account = ReturnType<typeof KeetaNet.lib.Account.fromSeed>;
type Token = ReturnType<typeof newToken>;

const NETWORK_ID = KeetaNet.UserClient.Config.NetworkIDs.test;
const KEETA_LOCATION: AssetLocationString = `chain:keeta:${NETWORK_ID}`;
const MOBILE_LOCATION: AssetLocationString = 'mobile-wallet:airtel-money';
const EVM_LOCATION: AssetLocationString = 'chain:evm:1';
const TIMESTAMP = new Date('2026-01-01T00:00:00.000Z');

function newAccount(): Account {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

function newToken(owner: Account, index: number) {
	return(owner.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, index));
}

// #region Helpers

/**
 * One-page history source backed by sealed blocks; subsequent pages are empty
 * so paging terminates.
 */
function historyFrom(blocks: Block[]): HistorySource {
	let served = false;
	return({
		async getHistory(): Promise<HistoryEntry[]> {
			if (served) {
				return([]);
			}

			served = true;
			return([{
				voteStaple: {
					timestamp() {
						return(TIMESTAMP);
					},
					blocks,
					blocksHash: 'cursor-0'
				}
			}]);
		}
	});
}

/**
 * Construct a {@link UserHistory} over an in-memory page of blocks and fold it.
 * A status source is attached only when supplied.
 */
async function runHistory(blocks: Block[], source?: AnchorStatusSource<KeetaAssetMovementTransaction>, options?: UserHistoryListOptions, queriedAccount?: Account | string): Promise<LogicalTransaction[]> {
	const config: UserHistoryConfig = { history: historyFrom(blocks) };
	if (source !== undefined) {
		config.status = new AnchorTransactionStatus(source);
	}

	const history = new UserHistory(config);
	const account = queriedAccount ?? blocks[0]?.account ?? null;
	const transactions = await history.list(account, options);
	return(transactions);
}

/**
 * Build a crafted anchor transfer record.
 */
function makeTransfer(input: {
	id: string;
	status: TransactionStatus;
	asset: AssetOrPair;
	fromLocation: AssetLocationString;
	toLocation: AssetLocationString;
	fromValue: string;
	toValue: string;
	fee?: { asset: MovableAsset; value: string };
}): KeetaAssetMovementTransaction {
	const transfer: KeetaAssetMovementTransaction = {
		id: input.id,
		status: input.status,
		asset: input.asset,
		from: {
			location: input.fromLocation,
			value: input.fromValue,
			transactions: { persistentForwarding: null, deposit: { id: 'deposit-1', nonce: '0' }, finalization: null }
		},
		to: {
			location: input.toLocation,
			value: input.toValue,
			transactions: { withdraw: null }
		},
		fee: input.fee ?? null,
		createdAt: TIMESTAMP.toISOString(),
		updatedAt: TIMESTAMP.toISOString()
	};

	return(transfer);
}

/**
 * Account id of an anchor reference, regardless of its form.
 */
function referenceID(anchor: AnchorReference): string {
	if (typeof anchor === 'string') {
		return(anchor);
	}

	return(anchor.publicKeyString.get());
}

/**
 * In-memory status source resolving crafted transfers by transaction id and by
 * on-chain coordinates. Zero mocks: a real {@link AnchorTransactionStatus} drives it.
 */
class TestStatusSource implements AnchorStatusSource<KeetaAssetMovementTransaction> {
	readonly #anchors = new Set<string>();
	readonly #byTxID = new Map<string, KeetaAssetMovementTransaction>();
	readonly #byCoord = new Map<string, KeetaAssetMovementTransaction>();

	registerAnchor(anchor: Account): void {
		this.#anchors.add(anchor.publicKeyString.get());
	}

	registerByTxID(anchor: Account, transfer: KeetaAssetMovementTransaction): void {
		this.registerAnchor(anchor);
		this.#byTxID.set(transfer.id, transfer);
	}

	registerByCoord(anchor: Account, blockHash: string, operationIndex: number, transfer: KeetaAssetMovementTransaction): void {
		this.registerAnchor(anchor);
		this.#byCoord.set(`${blockHash}:${operationIndex}`, transfer);
	}

	async getReader(anchor: AnchorReference): Promise<AnchorTransferReader<KeetaAssetMovementTransaction> | null> {
		const id = referenceID(anchor);
		if (!this.#anchors.has(id)) {
			return(null);
		}

		const byTxID = this.#byTxID;
		const byCoord = this.#byCoord;
		const reader: AnchorTransferReader<KeetaAssetMovementTransaction> = {
			async getTransferStatus(transactionID: string): Promise<StandardizedTransferStatus<KeetaAssetMovementTransaction>> {
				const transfer = byTxID.get(transactionID);
				if (transfer === undefined) {
					throw(new Error('unknown transaction'));
				}

				return({ status: transfer.status, transactionID: transfer.id, transaction: transfer });
			},
			async findByOnChain(reference: AnchorOnChainReference): Promise<StandardizedTransferStatus<KeetaAssetMovementTransaction> | null> {
				const transfer = byCoord.get(`${reference.blockHash}:${reference.operationIndex}`);
				if (transfer === undefined) {
					return(null);
				}

				return({ status: transfer.status, transactionID: transfer.id, transaction: transfer });
			}
		};

		return(reader);
	}
}

function seal(signer: Account, operations: BlockJSONOperations[]): Promise<Block> {
	return(new KeetaNet.lib.Block.Builder({
		network: NETWORK_ID,
		previous: KeetaNet.lib.Block.NO_PREVIOUS,
		signer,
		operations
	}).seal());
}

function sendOp(to: Account, token: Token, amount: bigint, external?: string): BlockJSONOperations {
	if (external !== undefined) {
		return({ type: KeetaNet.lib.Block.OperationType.SEND, to, token, amount, external });
	}

	return({ type: KeetaNet.lib.Block.OperationType.SEND, to, token, amount });
}

function receiveOp(from: Account, token: Token, amount: bigint): BlockJSONOperations {
	return({ type: KeetaNet.lib.Block.OperationType.RECEIVE, from, token, amount });
}

// #endregion Helpers

// #region Block-shape classification

type BlockShapeActors = {
	alice: Account;
	bob: Account;
	primary: Token;
	secondary: Token;
	cost: Token;
};

type BlockShapeCase = {
	name: string;
	build(actors: BlockShapeActors): BlockJSONOperations[];
	type: LogicalTransactionType;
	direction: LogicalDirection;
	legs: number;
};

const blockShapeCases: BlockShapeCase[] = [
	{
		name: 'a plain send',
		build: ({ alice, primary }) => [ sendOp(alice, primary, 500n) ],
		type: 'send',
		direction: 'out',
		legs: 1
	},
	{
		name: 'a plain receive',
		build: ({ alice, primary }) => [ receiveOp(alice, primary, 250n) ],
		type: 'receive',
		direction: 'in',
		legs: 1
	},
	{
		name: 'an atomic swap',
		build: ({ alice, primary, secondary }) => [ sendOp(alice, primary, 1000n), receiveOp(alice, secondary, 990n) ],
		type: 'swap',
		direction: 'self',
		legs: 2
	},
	{
		name: 'an atomic swap with a cost send ordered before the principal',
		build: ({ alice, primary, secondary, cost }) => [ sendOp(alice, cost, 5n), sendOp(alice, primary, 1000n), receiveOp(alice, secondary, 990n) ],
		type: 'swap',
		direction: 'self',
		legs: 3
	},
	{
		name: 'mismatched send and receive counterparties',
		build: ({ alice, bob, primary }) => [ sendOp(alice, primary, 100n), receiveOp(bob, primary, 100n) ],
		type: 'other',
		direction: 'self',
		legs: 2
	}
];

test.each(blockShapeCases)('classifies $name from block shape alone', async function(testCase) {
	const user = newAccount();
	const alice = newAccount();
	const bob = newAccount();
	const actors: BlockShapeActors = {
		alice,
		bob,
		primary: newToken(user, 0),
		secondary: newToken(user, 1),
		cost: newToken(user, 2)
	};
	const block = await seal(user, testCase.build(actors));

	const [ transaction, ...rest ] = await runHistory([ block ]);
	expect(rest).toHaveLength(0);
	expect(transaction?.type).toBe(testCase.type);
	expect(transaction?.direction).toBe(testCase.direction);
	expect(transaction?.legs).toHaveLength(testCase.legs);
});

test('a plain send carries its amount and account counterparty', async function() {
	const user = newAccount();
	const recipient = newAccount();
	const token = newToken(user, 0);
	const block = await seal(user, [ sendOp(recipient, token, 500n) ]);

	const [ transaction ] = await runHistory([ block ]);
	expect(transaction?.send).toEqual({ token: token.publicKeyString.get(), amount: 500n });
	expect(transaction?.counterparty).toEqual({ kind: 'account', id: recipient.publicKeyString.get() });
	expect(transaction?.refs.blockHashes).toEqual([ block.hash.toString() ]);
});

test('an atomic swap records principal, receive and fee regardless of cost send order', async function() {
	const user = newAccount();
	const liquidity = newAccount();
	const tokenA = newToken(user, 0);
	const tokenB = newToken(user, 1);
	const tokenCost = newToken(user, 2);
	const block = await seal(user, [
		sendOp(liquidity, tokenCost, 5n),
		sendOp(liquidity, tokenA, 1000n),
		receiveOp(liquidity, tokenB, 990n)
	]);

	const [ transaction ] = await runHistory([ block ]);
	expect(transaction?.send).toEqual({ token: tokenA.publicKeyString.get(), amount: 1000n });
	expect(transaction?.receive).toEqual({ token: tokenB.publicKeyString.get(), amount: 990n });
	expect(transaction?.fee).toEqual({ token: tokenCost.publicKeyString.get(), amount: 5n });
	expect(transaction?.counterparty).toEqual({ kind: 'liquidity', id: liquidity.publicKeyString.get() });
});

test('an atomic swap omits the fee when the non-principal sends use more than one token', async function() {
	const user = newAccount();
	const liquidity = newAccount();
	const tokenA = newToken(user, 0);
	const tokenB = newToken(user, 1);
	const tokenCostA = newToken(user, 2);
	const tokenCostB = newToken(user, 3);
	const block = await seal(user, [
		sendOp(liquidity, tokenA, 1000n),
		sendOp(liquidity, tokenCostA, 5n),
		sendOp(liquidity, tokenCostB, 7n),
		receiveOp(liquidity, tokenB, 990n)
	]);

	const [ transaction ] = await runHistory([ block ]);
	expect(transaction?.type).toBe('swap');
	expect(transaction?.send).toEqual({ token: tokenA.publicKeyString.get(), amount: 1000n });
	expect(transaction?.receive).toEqual({ token: tokenB.publicKeyString.get(), amount: 990n });
	expect(transaction?.fee).toBeUndefined();
});

// #endregion Block-shape classification

// #region Anchor classification

type AnchorCase = {
	name: string;
	correlation: 'external' | 'coord';
	id: string;
	from: AssetLocationString;
	to: AssetLocationString;
	value: string;
	providerStatus: TransactionStatus;
	type: LogicalTransactionType;
	direction: LogicalDirection;
	status: LogicalTransactionStatus;
};

const anchorCases: AnchorCase[] = [
	{
		name: 'deposit correlated to a RECEIVE by reverse-lookup',
		correlation: 'coord',
		id: 'deposit-tx',
		from: MOBILE_LOCATION,
		to: KEETA_LOCATION,
		value: '750',
		providerStatus: 'PENDING',
		type: 'deposit',
		direction: 'in',
		status: 'pending'
	},
	{
		name: 'withdraw resolved from a SEND external envelope',
		correlation: 'external',
		id: 'withdraw-tx',
		from: KEETA_LOCATION,
		to: MOBILE_LOCATION,
		value: '400',
		providerStatus: 'COMPLETE',
		type: 'withdraw',
		direction: 'out',
		status: 'complete'
	},
	{
		name: 'conversion across keeta endpoints',
		correlation: 'external',
		id: 'convert-tx',
		from: KEETA_LOCATION,
		to: KEETA_LOCATION,
		value: '600',
		providerStatus: 'COMPLETE',
		type: 'swap',
		direction: 'self',
		status: 'complete'
	},
	{
		name: 'transfer to a non-keeta chain is a bridge',
		correlation: 'external',
		id: 'bridge-tx',
		from: KEETA_LOCATION,
		to: EVM_LOCATION,
		value: '300',
		providerStatus: 'PENDING',
		type: 'bridge',
		direction: 'out',
		status: 'pending'
	}
];

/**
 * Build the on-chain block and a status source primed to resolve the case's
 * transfer, by external envelope or by on-chain coordinates.
 */
async function buildAnchorScenario(testCase: AnchorCase, user: Account, anchor: Account, token: Token): Promise<{ block: Block; source: TestStatusSource }> {
	const transfer = makeTransfer({
		id: testCase.id,
		status: testCase.providerStatus,
		asset: token.publicKeyString.get(),
		fromLocation: testCase.from,
		toLocation: testCase.to,
		fromValue: testCase.value,
		toValue: testCase.value
	});
	const source = new TestStatusSource();

	if (testCase.correlation === 'external') {
		const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: testCase.id }).build();
		const block = await seal(user, [ sendOp(anchor, token, BigInt(testCase.value), external) ]);
		source.registerByTxID(anchor, transfer);
		return({ block, source });
	}

	const block = await seal(user, [ receiveOp(anchor, token, BigInt(testCase.value)) ]);
	source.registerByCoord(anchor, block.hash.toString(), 0, transfer);
	return({ block, source });
}

test.each(anchorCases)('classifies an anchor $name', async function(testCase) {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const { block, source } = await buildAnchorScenario(testCase, user, anchor, token);

	const [ transaction ] = await runHistory([ block ], source);
	expect(transaction?.type).toBe(testCase.type);
	expect(transaction?.direction).toBe(testCase.direction);
	expect(transaction?.status).toBe(testCase.status);
	expect(transaction?.providerStatus).toBe(testCase.providerStatus);
	expect(transaction?.refs.anchorTxIDs).toContain(testCase.id);
});

test('an anchor withdraw records the fee and an anchor counterparty', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'withdraw-tx' }).build();
	const block = await seal(user, [ sendOp(anchor, token, 400n, external) ]);

	const transfer = makeTransfer({
		id: 'withdraw-tx',
		status: 'COMPLETE',
		asset: token.publicKeyString.get(),
		fromLocation: KEETA_LOCATION,
		toLocation: MOBILE_LOCATION,
		fromValue: '400',
		toValue: '398',
		fee: { asset: token.publicKeyString.get(), value: '2' }
	});
	const source = new TestStatusSource();
	source.registerByTxID(anchor, transfer);

	const [ transaction ] = await runHistory([ block ], source);
	expect(transaction?.type).toBe('withdraw');
	expect(transaction?.fee).toEqual({ token: token.publicKeyString.get(), amount: 2n });
	expect(transaction?.counterparty).toEqual({ kind: 'anchor', id: anchor.publicKeyString.get() });
});

test('an anchor deposit ids the operation and links its sub-transactions', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const block = await seal(user, [ receiveOp(anchor, token, 750n) ]);

	const transfer = makeTransfer({
		id: 'deposit-tx',
		status: 'PENDING',
		asset: token.publicKeyString.get(),
		fromLocation: MOBILE_LOCATION,
		toLocation: KEETA_LOCATION,
		fromValue: '750',
		toValue: '750'
	});
	const source = new TestStatusSource();
	source.registerByCoord(anchor, block.hash.toString(), 0, transfer);

	const [ transaction ] = await runHistory([ block ], source);
	expect(transaction?.id).toBe(`${block.hash.toString()}:0`);

	const anchorLeg = transaction?.legs.find(leg => leg.kind === 'anchor');
	if (anchorLeg?.kind !== 'anchor') {
		throw(new Error('Expected an anchor leg'));
	}

	expect(anchorLeg.subTransactions).toContain('deposit-1');
});

test('includeSource attaches the staple and enriched block to a transaction', async function() {
	const user = newAccount();
	const recipient = newAccount();
	const token = newToken(user, 0);
	const block = await seal(user, [ sendOp(recipient, token, 500n) ]);

	const [ transaction ] = await runHistory([ block ], undefined, { includeSource: true });
	expect(transaction?.source?.enriched.blockHash).toBe(block.hash.toString());
	expect(transaction?.source?.staple.blocks).toContain(block);
	expect(transaction?.source?.enriched.operations).toHaveLength(1);
});

test('includeSource resolves a suffixed transaction id to its source block', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const block = await seal(user, [ receiveOp(anchor, token, 750n) ]);

	const transfer = makeTransfer({
		id: 'deposit-tx',
		status: 'PENDING',
		asset: token.publicKeyString.get(),
		fromLocation: MOBILE_LOCATION,
		toLocation: KEETA_LOCATION,
		fromValue: '750',
		toValue: '750'
	});
	const source = new TestStatusSource();
	source.registerByCoord(anchor, block.hash.toString(), 0, transfer);

	const [ transaction ] = await runHistory([ block ], source, { includeSource: true });
	expect(transaction?.id).toBe(`${block.hash.toString()}:0`);
	expect(transaction?.source?.enriched.blockHash).toBe(block.hash.toString());
});

test('source is absent unless includeSource is requested', async function() {
	const user = newAccount();
	const recipient = newAccount();
	const token = newToken(user, 0);
	const block = await seal(user, [ sendOp(recipient, token, 500n) ]);

	const [ transaction ] = await runHistory([ block ]);
	expect(transaction?.source).toBeUndefined();
});

test('an undecodable external degrades to a plain send and keeps the raw string', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const external = Buffer.from('not-an-anchor-envelope').toString('base64');
	const block = await seal(user, [ sendOp(anchor, token, 120n, external) ]);

	const source = new TestStatusSource();
	source.registerAnchor(anchor);

	const [ transaction ] = await runHistory([ block ], source);
	expect(transaction?.type).toBe('send');
	expect(transaction?.refs.external).toEqual([ external ]);
});

test('enrichment can be disabled to classify from block shape only', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'withdraw-tx' }).build();
	const block = await seal(user, [ sendOp(anchor, token, 400n, external) ]);

	const transfer = makeTransfer({
		id: 'withdraw-tx',
		status: 'COMPLETE',
		asset: token.publicKeyString.get(),
		fromLocation: KEETA_LOCATION,
		toLocation: MOBILE_LOCATION,
		fromValue: '400',
		toValue: '400'
	});
	const source = new TestStatusSource();
	source.registerByTxID(anchor, transfer);

	const [ transaction ] = await runHistory([ block ], source, { enrich: false });
	expect(transaction?.type).toBe('send');
	expect(transaction?.refs.external).toEqual([ external ]);
});

// #endregion Anchor classification

// #region Foreign-issuer blocks

test('an unenriched payout block issued by another party classifies as a receive', async function() {
	const issuer = newAccount();
	const user = newAccount();
	const token = newToken(issuer, 0);
	const block = await seal(issuer, [ sendOp(user, token, 750n) ]);

	const [ transaction, ...rest ] = await runHistory([ block ], undefined, undefined, user);
	expect(rest).toHaveLength(0);
	expect(transaction?.type).toBe('receive');
	expect(transaction?.direction).toBe('in');
	expect(transaction?.counterparty).toEqual({ kind: 'account', id: issuer.publicKeyString.get() });
	expect(transaction?.receive).toEqual({ token: token.publicKeyString.get(), amount: 750n });
});

test('a foreign block with operations not involving the user stays other', async function() {
	const issuer = newAccount();
	const user = newAccount();
	const stranger = newAccount();
	const token = newToken(issuer, 0);
	const block = await seal(issuer, [ sendOp(user, token, 750n), sendOp(stranger, token, 10n) ]);

	const [ transaction ] = await runHistory([ block ], undefined, undefined, user);
	expect(transaction?.type).toBe('other');
});

test('a foreign payout block reverse-looks-up the transfer at the issuing anchor', async function() {
	const anchor = newAccount();
	const user = newAccount();
	const token = newToken(anchor, 0);
	const block = await seal(anchor, [ sendOp(user, token, 750n) ]);

	const transfer = makeTransfer({
		id: 'deposit-tx',
		status: 'COMPLETE',
		asset: token.publicKeyString.get(),
		fromLocation: MOBILE_LOCATION,
		toLocation: KEETA_LOCATION,
		fromValue: '750',
		toValue: '750'
	});
	const source = new TestStatusSource();
	source.registerByCoord(anchor, block.hash.toString(), 0, transfer);

	const [ transaction ] = await runHistory([ block ], source, undefined, user);
	expect(transaction?.type).toBe('deposit');
	expect(transaction?.direction).toBe('in');
	expect(transaction?.counterparty).toEqual({ kind: 'anchor', id: anchor.publicKeyString.get() });
});

// #endregion Foreign-issuer blocks

// #region Paging and options

/**
 * Spin a live node and publish three real sends from the user, each settling
 * in its own vote staple, so paging walks multiple staples newest-first.
 */
async function startPagingFixture(): Promise<{ history: UserHistory; user: Account }> {
	const user = newAccount();
	const recipient = newAccount();
	const { userClient, fees } = await createNodeAndClient(user);
	fees.disable();

	for (const amount of [ 1n, 2n, 3n ]) {
		await userClient.send(recipient, amount, userClient.baseToken);
	}

	const history = new UserHistory({ history: userClient.client });
	return({ history, user });
}

test('pages with the previous staple hash until the limit is reached', async function() {
	const fixture = await startPagingFixture();

	const transactions = await fixture.history.list(fixture.user, { depth: 1, limit: 2 });
	expect(transactions).toHaveLength(2);
	expect(transactions.map(transaction => transaction.type)).toEqual([ 'send', 'send' ]);
	expect(transactions.map(transaction => transaction.send?.amount)).toEqual([ 3n, 2n ]);
});

test('walks every page when no limit is given', async function() {
	const fixture = await startPagingFixture();

	const transactions = await fixture.history.list(fixture.user, { depth: 1 });

	/*
	 * All three sends settle in their own staples; walking past the first page
	 * also surfaces the initial funding receive, proving paging is not
	 * truncated to a single page.
	 */
	const sends = transactions.filter(transaction => transaction.type === 'send').map(transaction => transaction.send?.amount);
	expect(sends).toEqual([ 3n, 2n, 1n ]);
	expect(transactions.length).toBeGreaterThan(sends.length);
});

test('iterate yields logical transactions without buffering the full result', async function() {
	const fixture = await startPagingFixture();

	const streamed: (bigint | undefined)[] = [];
	for await (const transaction of fixture.history.iterate(fixture.user, { depth: 1, limit: 2 })) {
		streamed.push(transaction.send?.amount);
	}

	expect(streamed).toEqual([ 3n, 2n ]);
});

test('resumes paging from a caller-supplied cursor', async function() {
	const fixture = await startPagingFixture();

	const [ first ] = await fixture.history.list(fixture.user, { depth: 1, limit: 1, includeSource: true });
	expect(first?.send?.amount).toBe(3n);

	const cursor = first?.source?.staple.blocksHash.toString();
	if (cursor === undefined) {
		throw(new Error('Expected the first page to carry a staple cursor'));
	}

	const resumed = await fixture.history.list(fixture.user, { depth: 1, limit: 1, cursor });
	expect(resumed.map(transaction => transaction.send?.amount)).toEqual([ 2n ]);
});

/**
 * A SEND whose external envelope is encrypted to the user, with the
 * transfer registered at the anchor.
 */
async function encryptedWithdrawScenario(): Promise<{ user: Account; block: Block; source: TestStatusSource }> {
	const user = newAccount();
	const anchor = newAccount();
	const token = newToken(user, 0);
	const external = await new AnchorExternal.Builder()
		.setAnchor(anchor, { transactionId: 'withdraw-tx' })
		.withPrincipals([ user ])
		.build();
	const block = await seal(user, [ sendOp(anchor, token, 400n, external) ]);

	const transfer = makeTransfer({
		id: 'withdraw-tx',
		status: 'COMPLETE',
		asset: token.publicKeyString.get(),
		fromLocation: KEETA_LOCATION,
		toLocation: MOBILE_LOCATION,
		fromValue: '400',
		toValue: '400'
	});
	const source = new TestStatusSource();
	source.registerByTxID(anchor, transfer);

	return({ user, block, source });
}

test('an encrypted external resolves when decryption keys are supplied', async function() {
	const scenario = await encryptedWithdrawScenario();

	const [ transaction ] = await runHistory([ scenario.block ], scenario.source, { decryptionKeys: [ scenario.user ] });
	expect(transaction?.type).toBe('withdraw');
	expect(transaction?.refs.anchorTxIDs).toContain('withdraw-tx');
});

test('an encrypted external without decryption keys degrades to a plain send', async function() {
	const scenario = await encryptedWithdrawScenario();

	const [ transaction ] = await runHistory([ scenario.block ], scenario.source);
	expect(transaction?.type).toBe('send');
	expect(transaction?.refs.anchorTxIDs).toEqual([]);
});

// #endregion Paging and options

// #region Integration

/**
 * Spin a live node, publish a real anchor's service metadata, and return the
 * pieces a {@link UserHistory} needs to resolve transfers over HTTP. The
 * funding send is real: user to anchor for withdrawals, anchor to user for
 * deposit payouts.
 */
async function startAnchorTransferFixture(input: {
	id: string;
	fromLocation: AssetLocationString;
	toLocation: AssetLocationString;
	sender: 'user' | 'anchor';
}): Promise<{
		server: KeetaNetAssetMovementAnchorHTTPServer;
		history: UserHistory;
		userAccount: Account;
		anchorAccount: Account;
	}> {
	const rootAccount = newAccount();
	const anchorAccount = newAccount();
	const userAccount = newAccount();

	const { userClient: rootClient, fees, give } = await createNodeAndClient(rootAccount);
	fees.disable();

	const baseToken = rootClient.baseToken;

	const transaction = makeTransfer({
		id: input.id,
		status: 'COMPLETE',
		asset: baseToken.publicKeyString.get(),
		fromLocation: input.fromLocation,
		toLocation: input.toLocation,
		fromValue: '5',
		toValue: '4',
		fee: { asset: baseToken.publicKeyString.get(), value: '1' }
	});

	const server = new KeetaNetAssetMovementAnchorHTTPServer({
		metadataSigner: anchorAccount,
		assetMovement: {
			supportedAssets: [
				{
					asset: baseToken.publicKeyString.get(),
					paths: [
						{
							pair: [
								{ location: 'chain:keeta:123', id: baseToken.publicKeyString.get(), rails: { common: [ { rail: 'KEETA_SEND' } ] }},
								{ location: 'chain:evm:100', id: 'evm:0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }}
							]
						}
					]
				}
			],
			getTransferStatus: async function() {
				return({ transaction });
			}
		}
	});

	await server.start();

	await rootClient.setInfo({
		name: '',
		description: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				assetMovement: {
					Test: await server.serviceMetadata()
				}
			}
		} satisfies ServiceMetadataExternalizable)
	});

	let senderAccount: Account;
	let recipientAccount: Account;
	if (input.sender === 'user') {
		senderAccount = userAccount;
		recipientAccount = anchorAccount;
	} else {
		senderAccount = anchorAccount;
		recipientAccount = userAccount;
	}

	await give(senderAccount, 50n);
	fees.enable();

	const senderClient = new KeetaNet.UserClient({
		client: rootClient.client,
		network: rootClient.network,
		networkAlias: 'test',
		signer: senderAccount,
		usePublishAid: false
	});

	const external = await new AnchorExternal.Builder().setAnchor(anchorAccount, { transactionId: input.id }).build();
	await senderClient.send(recipientAccount, 5n, baseToken, external);

	const resolver = new Resolver({ root: rootAccount, client: rootClient, trustedCAs: [] });
	const status = new AnchorTransactionStatus(new KeetaAssetMovementStatusSource({ client: rootClient, resolver }));
	const history = new UserHistory({ history: rootClient.client, status });

	return({ server, history, userAccount, anchorAccount });
}

test('resolves a real withdraw end-to-end through a live node and anchor server', async function() {
	const fixture = await startAnchorTransferFixture({
		id: 'withdraw-tx',
		fromLocation: KEETA_LOCATION,
		toLocation: MOBILE_LOCATION,
		sender: 'user'
	});
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const withdraw = transactions.find(transaction => transaction.type === 'withdraw');
	expect(withdraw).toBeDefined();
	expect(withdraw?.status).toBe('complete');
	expect(withdraw?.providerStatus).toBe('COMPLETE');
	expect(withdraw?.direction).toBe('out');
	expect(withdraw?.counterparty).toEqual({ kind: 'anchor', id: fixture.anchorAccount.publicKeyString.get() });
	expect(withdraw?.refs.anchorTxIDs).toContain('withdraw-tx');
});

test('resolves a real deposit payout end-to-end from an anchor-issued send', async function() {
	const fixture = await startAnchorTransferFixture({
		id: 'deposit-tx',
		fromLocation: MOBILE_LOCATION,
		toLocation: KEETA_LOCATION,
		sender: 'anchor'
	});
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const deposit = transactions.find(transaction => transaction.type === 'deposit');
	expect(deposit).toBeDefined();
	expect(deposit?.status).toBe('complete');
	expect(deposit?.providerStatus).toBe('COMPLETE');
	expect(deposit?.direction).toBe('in');
	expect(deposit?.counterparty).toEqual({ kind: 'anchor', id: fixture.anchorAccount.publicKeyString.get() });
	expect(deposit?.refs.anchorTxIDs).toContain('deposit-tx');
});

// #endregion Integration

// #region FX

/**
 * Drive an FX exchange to completion by running the anchor's queue pipeline.
 */
async function settleExchange(server: KeetaNetFXAnchorHTTPServer, exchange: { getExchangeStatus: () => Promise<{ status: string } | undefined> }): Promise<void> {
	const timeout = Date.now() + 20_000;
	await server.pipeline.run();
	await server.pipeline.maintain();

	let status = await exchange.getExchangeStatus();
	while (status?.status !== 'completed') {
		if (Date.now() > timeout) {
			throw(new Error(`Timeout waiting for FX exchange to complete, status is ${JSON.stringify(status)}`));
		}

		await server.pipeline.run();
		status = await exchange.getExchangeStatus();
		await asleep(50);
	}
}

type FXUserClient = NonNullable<Awaited<ReturnType<typeof createNodeAndClient>>['userClient']>;

/**
 * Wire a {@link UserHistory} backed by the FX status source for the user.
 */
function buildFXHistory(client: FXUserClient, userAccount: Account): UserHistory {
	const resolver = new Resolver({ root: userAccount, client, trustedCAs: [] });
	const fxStatus = new KeetaFXStatusSource({ client, resolver });
	const status = new AnchorTransactionStatus(new CompositeAnchorStatusSource([ fxStatus ]));
	return(new UserHistory({ history: client.client, status }));
}

/**
 * Options controlling {@link startFXExchangeFixture}.
 */
type FXExchangeFixtureOptions = {
	/**
	 * When `false`, the FX service publishes unsigned metadata so the status
	 * source cannot attribute the provider by account, modeling an unreachable
	 * or pre-extension anchor.
	 */
	signMetadata?: boolean;
};

/**
 * Stand up a USD to EUR FX anchor and the user client that trades against
 * it, without performing any exchange. Shared by the single-exchange and
 * chained-exchange fixtures.
 */
async function setupFXAnchor(options: FXExchangeFixtureOptions & { giveBase?: bigint } = {}) {
	const signMetadata = options.signMetadata ?? true;
	const giveBase = options.giveBase ?? 50n;

	const userAccount = newAccount();
	const liquidityProvider = newAccount();
	const quoteSigner = newAccount();

	const nodeAndClient = await createNodeAndClient(userAccount);
	const client = nodeAndClient.userClient;
	const baseToken = client.baseToken;

	const { account: usd } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!usd.isToken()) {
		throw(new Error('USD identifier is not a token'));
	}

	await client.modTokenSupplyAndBalance(500000n, usd);

	const { account: eur } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!eur.isToken()) {
		throw(new Error('EUR identifier is not a token'));
	}

	await nodeAndClient.give(userAccount, giveBase);
	await client.modTokenSupplyAndBalance(100000n, eur, { account: liquidityProvider });
	await client.updatePermissions(liquidityProvider, new KeetaNet.lib.Permissions([ 'ACCESS' ]), undefined, undefined, { account: eur });
	await client.updatePermissions(liquidityProvider, new KeetaNet.lib.Permissions([ 'ACCESS' ]), undefined, undefined, { account: usd });
	await client.send(liquidityProvider, 50n, baseToken);

	let metadataSigner: Account | undefined = liquidityProvider;
	if (!signMetadata) {
		metadataSigner = undefined;
	}

	const server = new KeetaNetFXAnchorHTTPServer({
		account: liquidityProvider,
		metadataSigner,
		quoteSigner,
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		storage: {
			queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'queue' }),
			autoRun: false
		},
		fx: {
			from: [
				{
					currencyCodes: [ usd.publicKeyString.get() ],
					to: [ eur.publicKeyString.get() ]
				}
			],
			getConversionRateAndFee: async function(request) {
				return({
					account: liquidityProvider,
					convertedAmount: BigInt(request.amount) * 88n / 100n,
					cost: { amount: 5n, token: baseToken }
				});
			}
		}
	});

	await server.start();

	await client.setInfo({
		description: 'FX Anchor History Test',
		name: 'TEST',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: usd.publicKeyString.get(),
				EUR: eur.publicKeyString.get()
			},
			services: {
				fx: { Test: await server.serviceMetadata() }
			}
		})
	});

	const fxClient = new FX.Client(client, { root: userAccount, signer: userAccount, account: userAccount });

	return({ server, client, fxClient, userAccount, liquidityProvider, usd, eur, baseToken });
}

/**
 * Request the lone USD to EUR quote the anchor offers for a 100-unit swap.
 */
async function requestUSDtoEURQuote(fxClient: InstanceType<typeof FX.Client>) {
	const quotes = await fxClient.getQuotes({ from: 'USD', to: 'EUR', amount: 100n, affinity: 'from' });
	const quote = quotes?.[0];
	if (quote === undefined) {
		throw(new Error('Expected a USD to EUR quote from the FX anchor'));
	}

	return(quote);
}

/**
 * Perform a USD to EUR exchange driven to completion through a single
 * liquidity provider, and return the pieces a {@link UserHistory} needs.
 */
async function startFXExchangeFixture(options: FXExchangeFixtureOptions = {}): Promise<{
	server: KeetaNetFXAnchorHTTPServer;
	history: UserHistory;
	userAccount: Account;
	liquidityProvider: Account;
	usdToken: string;
	eurToken: string;
	costToken: string;
}> {
	const setup = await setupFXAnchor(options);

	const quote = await requestUSDtoEURQuote(setup.fxClient);
	const exchange = await quote.createExchange();
	await settleExchange(setup.server, exchange);

	const history = buildFXHistory(setup.client, setup.userAccount);

	return({
		server: setup.server,
		history,
		userAccount: setup.userAccount,
		liquidityProvider: setup.liquidityProvider,
		usdToken: setup.usd.publicKeyString.get(),
		eurToken: setup.eur.publicKeyString.get(),
		costToken: setup.baseToken.publicKeyString.get()
	});
}

/**
 * Perform two USD to EUR exchanges where the second declares the first
 * exchange's settled swap block as an on-chain input, mirroring what the
 * chaining plan emits for a multi-hop conversion.
 */
async function startChainedFXExchangeFixture(): Promise<{
	server: KeetaNetFXAnchorHTTPServer;
	history: UserHistory;
	userAccount: Account;
	usdToken: string;
	eurToken: string;
	firstBlockHash: string;
}> {
	const setup = await setupFXAnchor({ giveBase: 100n });

	const firstQuote = await requestUSDtoEURQuote(setup.fxClient);
	const firstExchange = await firstQuote.createExchange();
	await settleExchange(setup.server, firstExchange);

	const firstStatus = await firstExchange.getExchangeStatus();
	if (firstStatus?.status !== 'completed') {
		throw(new Error('Expected the first FX exchange to complete'));
	}

	const firstBlockHash = firstStatus.blockhash;

	const secondQuote = await requestUSDtoEURQuote(setup.fxClient);
	const secondExchange = await secondQuote.createExchange(undefined, { inputs: [ { blockHash: firstBlockHash } ] });
	await settleExchange(setup.server, secondExchange);

	const history = buildFXHistory(setup.client, setup.userAccount);

	return({
		server: setup.server,
		history,
		userAccount: setup.userAccount,
		usdToken: setup.usd.publicKeyString.get(),
		eurToken: setup.eur.publicKeyString.get(),
		firstBlockHash
	});
}

/**
 * Drive a variable-rate exchange where the user over-sends the principal (a
 * `to`-affinity swap with slippage headroom) and the anchor refunds the
 * excess, returning the pieces a {@link UserHistory} needs plus the net and
 * gross principal amounts.
 */
async function startFXSlippageFixture(): Promise<{
	server: KeetaNetFXAnchorHTTPServer;
	history: UserHistory;
	userAccount: Account;
	usdToken: string;
	eurToken: string;
	netPrincipal: bigint;
	grossPrincipal: bigint;
	received: bigint;
}> {
	const netPrincipal = 100n;
	const grossPrincipal = 120n;
	const received = 88n;

	const userAccount = newAccount();
	const liquidityProvider = newAccount();
	const quoteSigner = newAccount();

	const nodeAndClient = await createNodeAndClient(userAccount);
	const client = nodeAndClient.userClient;
	const baseToken = client.baseToken;

	const { account: usd } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: eur } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!usd.isToken() || !eur.isToken()) {
		throw(new Error('Test currencies are not tokens'));
	}

	await client.modTokenSupplyAndBalance(500000n, usd);
	await nodeAndClient.give(userAccount, 50n);
	await client.modTokenSupplyAndBalance(100000n, eur, { account: liquidityProvider });
	await client.updatePermissions(liquidityProvider, new KeetaNet.lib.Permissions([ 'ACCESS' ]), undefined, undefined, { account: eur });
	await client.updatePermissions(liquidityProvider, new KeetaNet.lib.Permissions([ 'ACCESS' ]), undefined, undefined, { account: usd });
	await client.send(liquidityProvider, 50n, baseToken);

	/*
	 * Seed the LP with principal so the in-staple refund (sent before the
	 * user's funding block settles) does not dip the LP balance negative.
	 */
	await client.send(liquidityProvider, 1000n, usd);

	const server = new KeetaNetFXAnchorHTTPServer({
		accounts: new KeetaNet.lib.Account.Set([ liquidityProvider ]),
		signer: liquidityProvider,
		metadataSigner: liquidityProvider,
		quoteSigner,
		client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
		storage: {
			queue: new KeetaAnchorQueueStorageDriverMemory({ id: 'queue' }),
			autoRun: false
		},
		quoteConfiguration: {
			requiresQuote: false,
			validateQuoteBeforeExchange: false,
			issueQuotes: false
		},
		fx: {
			from: [
				{
					currencyCodes: [ usd.publicKeyString.get() ],
					to: [ eur.publicKeyString.get() ]
				}
			],
			/*
			 * The principal (USD) the anchor actually needs is `netPrincipal`,
			 * but the estimate's bound lets the user send up to `grossPrincipal`
			 * as slippage headroom; the anchor refunds the difference.
			 */
			getConversionRateAndFee: async function() {
				return({
					account: liquidityProvider,
					convertedAmount: netPrincipal,
					convertedAmountBound: grossPrincipal,
					cost: { amount: 0n, token: baseToken }
				});
			}
		}
	});

	await server.start();

	await client.setInfo({
		description: 'FX Anchor Slippage Test',
		name: 'TEST',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: usd.publicKeyString.get(),
				EUR: eur.publicKeyString.get()
			},
			services: {
				fx: { Test: await server.serviceMetadata() }
			}
		})
	});

	const fxClient = new FX.Client(client, { root: userAccount, signer: userAccount, account: userAccount });
	const estimates = await fxClient.getEstimates({ from: 'USD', to: 'EUR', amount: received, affinity: 'to' });
	const estimate = estimates?.[0];
	if (estimate === undefined) {
		throw(new Error('Expected a USD to EUR estimate from the FX anchor'));
	}

	const exchange = await estimate.createExchange();
	await settleExchange(server, exchange);

	const history = buildFXHistory(client, userAccount);

	return({
		server,
		history,
		userAccount,
		usdToken: usd.publicKeyString.get(),
		eurToken: eur.publicKeyString.get(),
		netPrincipal,
		grossPrincipal,
		received
	});
}

test('folds a real FX exchange into a single swap transaction', async function() {
	const fixture = await startFXExchangeFixture();
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount, { includeSource: true });
	const swaps = transactions.filter(transaction => transaction.type === 'swap');
	expect(swaps).toHaveLength(1);

	const swap = swaps[0];
	const swapStaple = swap?.source?.staple.blocksHash.toString();
	expect(swapStaple).toBeDefined();

	/*
	 * The swap's settling staple bundles the LP payout block
	 */
	const siblings = transactions.filter(transaction => transaction.source?.staple.blocksHash.toString() === swapStaple);
	expect(siblings).toHaveLength(1);
	expect(siblings[0]?.type).toBe('swap');
});

test('attributes FX swap principal, receive and fee correctly', async function() {
	const fixture = await startFXExchangeFixture();
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const swap = transactions.find(transaction => transaction.type === 'swap');
	expect(swap).toBeDefined();
	expect(swap?.direction).toBe('self');
	expect(swap?.send).toEqual({ token: fixture.usdToken, amount: 100n });
	expect(swap?.receive).toEqual({ token: fixture.eurToken, amount: 88n });
	expect(swap?.fee).toEqual({ token: fixture.costToken, amount: 5n });
});

test('links a real FX exchange to its anchor provider', async function() {
	const fixture = await startFXExchangeFixture();
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const swap = transactions.find(transaction => transaction.type === 'swap');
	expect(swap?.counterparty?.kind).toBe('anchor');
	expect(swap?.providerStatus).toBeDefined();
	expect(swap?.refs.anchorTxIDs.length).toBeGreaterThan(0);
});

test('degrades to a shape-only swap when the FX provider cannot be resolved', async function() {
	const fixture = await startFXExchangeFixture({ signMetadata: false });
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const swaps = transactions.filter(transaction => transaction.type === 'swap');
	expect(swaps).toHaveLength(1);

	/*
	 * Attribution and atomic-staple folding hold without any anchor enrichment.
	 */
	const swap = swaps[0];
	expect(swap?.send).toEqual({ token: fixture.usdToken, amount: 100n });
	expect(swap?.receive).toEqual({ token: fixture.eurToken, amount: 88n });
	expect(swap?.fee).toEqual({ token: fixture.costToken, amount: 5n });

	/*
	 * No reachable FX provider means no anchor linkage.
	 */
	expect(swap?.counterparty?.kind).not.toBe('anchor');
	expect(swap?.providerStatus).toBeUndefined();
	expect(swap?.refs.anchorTxIDs).toHaveLength(0);
});

test('reports the net principal for a variable-rate swap that refunds slippage', async function() {
	const fixture = await startFXSlippageFixture();
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const swap = transactions.find(transaction => transaction.type === 'swap');
	expect(swap).toBeDefined();
	expect(swap?.counterparty?.kind).toBe('anchor');

	/*
	 * The conversion summary reports what the user actually paid (net of the
	 * refund), not the gross amount the swap block sent.
	 */
	expect(swap?.send).toEqual({ token: fixture.usdToken, amount: fixture.netPrincipal });
	expect(swap?.receive).toEqual({ token: fixture.eurToken, amount: fixture.received });
	expect(fixture.netPrincipal).toBeLessThan(fixture.grossPrincipal);
});

test('surfaces the on-chain input a later FX swap declares and folds the chain into one conversion', async function() {
	const fixture = await startChainedFXExchangeFixture();
	await using server = fixture.server;
	void server;

	const transactions = await fixture.history.list(fixture.userAccount);
	const swaps = transactions.filter(transaction => transaction.type === 'swap');
	expect(swaps).toHaveLength(1);

	const swap = swaps[0];
	expect(swap?.refs.inputs?.some(input => input.blockHash === fixture.firstBlockHash)).toBe(true);
	expect(swap?.refs.blockHashes.includes(fixture.firstBlockHash)).toBe(true);
	expect(swap?.send).toEqual({ token: fixture.usdToken, amount: 100n });
	expect(swap?.receive).toEqual({ token: fixture.eurToken, amount: 88n });

	/*
	 * Re-folding an already-folded result is a no-op.
	 */
	const refolded = foldChains(transactions).filter(transaction => transaction.type === 'swap');
	expect(refolded).toHaveLength(1);
});

test('iterate folds a linked FX chain incrementally, matching list', async function() {
	const fixture = await startChainedFXExchangeFixture();
	await using server = fixture.server;
	void server;

	const streamed: LogicalTransaction[] = [];
	for await (const transaction of fixture.history.iterate(fixture.userAccount)) {
		streamed.push(transaction);
	}

	/*
	 * The stream itself now yields the folded conversion (not the two raw
	 * hops), so iterate() and list() agree.
	 */
	const swaps = streamed.filter(transaction => transaction.type === 'swap');
	expect(swaps).toHaveLength(1);

	const swap = swaps[0];
	expect(swap?.refs.blockHashes.includes(fixture.firstBlockHash)).toBe(true);
	expect(swap?.send).toEqual({ token: fixture.usdToken, amount: 100n });
	expect(swap?.receive).toEqual({ token: fixture.eurToken, amount: 88n });
});

// #endregion FX

// #region foldChains

/**
 * Spec for a synthetic swap {@link LogicalTransaction} used by the foldChains
 * unit tests.
 */
type SwapSpec = {
	id: string;
	blockHash: string;
	send: { token: string; amount: bigint };
	receive: { token: string; amount: bigint };
	inputBlockHashes?: string[];
	timestamp?: string;
	status?: LogicalTransactionStatus;
	fee?: { token: string; amount: bigint };
};

/**
 * Build a swap {@link LogicalTransaction} from a {@link SwapSpec}.
 */
function makeSwap(spec: SwapSpec): LogicalTransaction {
	const refs: LogicalTransaction['refs'] = { blockHashes: [ spec.blockHash ], anchorTxIDs: [] };
	if (spec.inputBlockHashes !== undefined) {
		refs.inputs = spec.inputBlockHashes.map(function(blockHash) {
			return({ blockHash });
		});
	}

	const transaction: LogicalTransaction = {
		id: spec.id,
		type: 'swap',
		status: spec.status ?? 'complete',
		direction: 'self',
		timestamp: spec.timestamp ?? '2026-01-01T00:00:00.000Z',
		send: spec.send,
		receive: spec.receive,
		legs: [],
		refs
	};

	if (spec.fee !== undefined) {
		transaction.fee = spec.fee;
	}

	return(transaction);
}

/**
 * Spec for a synthetic bridge {@link LogicalTransaction} used to exercise the
 * swap-funds-a-bridge fold.
 */
type BridgeSpec = {
	id: string;
	blockHash: string;
	send: { token: string; amount: bigint };
	receive: { token: string; amount: bigint };
	inputBlockHashes?: string[];
	counterparty?: LogicalCounterparty;
	timestamp?: string;
	status?: LogicalTransactionStatus;
};

/**
 * Build an outbound bridge {@link LogicalTransaction} from a {@link BridgeSpec}.
 */
function makeBridge(spec: BridgeSpec): LogicalTransaction {
	const refs: LogicalTransaction['refs'] = { blockHashes: [ spec.blockHash ], anchorTxIDs: [] };
	if (spec.inputBlockHashes !== undefined) {
		refs.inputs = spec.inputBlockHashes.map(function(blockHash) {
			return({ blockHash });
		});
	}

	const transaction: LogicalTransaction = {
		id: spec.id,
		type: 'bridge',
		status: spec.status ?? 'complete',
		direction: 'out',
		timestamp: spec.timestamp ?? '2026-01-01T00:00:00.000Z',
		send: spec.send,
		receive: spec.receive,
		legs: [],
		refs
	};

	if (spec.counterparty !== undefined) {
		transaction.counterparty = spec.counterparty;
	}

	return(transaction);
}

test('foldChains folds a swap funding a bridge into one outbound bridge', function() {
	const swap = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 1000n }, receive: { token: 'tokenN', amount: 500n }, timestamp: '2026-01-01T00:00:00.000Z' });
	const bridge = makeBridge({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenN', amount: 500n }, receive: { token: 'evm:0xabc', amount: 499n }, inputBlockHashes: [ 'b1' ], counterparty: { kind: 'anchor', id: 'anchorBridge' }, timestamp: '2026-01-01T00:05:00.000Z' });

	const folded = foldChains([ bridge, swap ]);
	expect(folded).toHaveLength(1);

	const merged = folded[0];
	expect(merged?.type).toBe('bridge');
	expect(merged?.direction).toBe('out');
	expect(merged?.send).toEqual({ token: 'tokenA', amount: 1000n });
	expect(merged?.receive).toEqual({ token: 'evm:0xabc', amount: 499n });
	expect(merged?.counterparty).toEqual({ kind: 'anchor', id: 'anchorBridge' });
	expect(merged?.refs.blockHashes).toEqual(expect.arrayContaining([ 'b1', 'b2' ]));
	expect(merged?.timestamp).toBe('2026-01-01T00:00:00.000Z');
});

test('foldChains leaves a lone bridge untouched', function() {
	const bridge = makeBridge({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenN', amount: 500n }, receive: { token: 'evm:0xabc', amount: 499n }, counterparty: { kind: 'anchor', id: 'anchorBridge' }});

	const folded = foldChains([ bridge ]);
	expect(folded).toEqual([ bridge ]);
});

/**
 * Wrap each block in its own single-block staple, served newest-first one page
 * at a time and resolvable by block hash. Drives the fold-capable
 * {@link UserHistory.iterate} cross-staple folding the live keeta client uses.
 */
function pagedFoldCapableSource(blocksNewestFirst: Block[]): HistorySource {
	const staples = blocksNewestFirst.map(function(block, index): HistoryStaple {
		return({ timestamp() { return(TIMESTAMP); }, blocks: [ block ], blocksHash: `staple-${index}` });
	});

	const byHash = new Map<string, HistoryStaple>();
	for (const staple of staples) {
		for (const block of staple.blocks) {
			byHash.set(block.hash.toString(), staple);
		}
	}

	return({
		async getHistory(_account, query?: HistoryQuery): Promise<HistoryEntry[]> {
			const cursor = query?.startBlocksHash;
			const previous = cursor === undefined ? -1 : staples.findIndex(staple => staple.blocksHash.toString() === cursor);
			const nextStaple = staples[previous + 1];
			if (nextStaple === undefined) {
				return([]);
			}

			return([{ voteStaple: nextStaple }]);
		},
		async getVoteStaple(blockHash: string): Promise<HistoryStaple | null> {
			return(byHash.get(blockHash) ?? null);
		}
	});
}

test('iterate suppresses a swap delivery that funds a chained bridge, leaving one conversion', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const source0 = newToken(user, 0);
	const mid = newToken(user, 1);

	const swap = makeTransfer({
		id: 'transfer-1',
		status: 'COMPLETE',
		asset: { from: source0.publicKeyString.get(), to: mid.publicKeyString.get() },
		fromLocation: KEETA_LOCATION,
		toLocation: KEETA_LOCATION,
		fromValue: '1000',
		toValue: '999'
	});
	const bridge = makeTransfer({
		id: 'transfer-3',
		status: 'COMPLETE',
		asset: { from: mid.publicKeyString.get(), to: 'evm:0xc063' },
		fromLocation: KEETA_LOCATION,
		toLocation: EVM_LOCATION,
		fromValue: '999',
		toValue: '998'
	});
	const status = new TestStatusSource();
	status.registerByTxID(anchor, swap);
	status.registerByTxID(anchor, bridge);

	/*
	 * The pay-in (user -> anchor) and the anchor's delivery of the mid token
	 * both settle the swap; the bridge re-sends that mid token and links back
	 * to the pay-in.
	 */
	const payInExternal = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'transfer-1' }).build();
	const payIn = await seal(user, [ sendOp(anchor, source0, 1000n, payInExternal) ]);

	const deliveryExternal = await new AnchorExternal.Builder()
		.setAnchor(anchor, { transactionId: 'transfer-1' })
		.withSigner(anchor)
		.withBinding(KeetaNet.lib.Block.NO_PREVIOUS, 0)
		.build();
	const delivery = await seal(anchor, [ sendOp(user, mid, 999n, deliveryExternal) ]);

	const bridgeExternal = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'transfer-3' }).addInput(payIn.hash.toString(), 0).build();
	const bridgeSend = await seal(user, [ sendOp(anchor, mid, 999n, bridgeExternal) ]);

	const history = new UserHistory({
		history: pagedFoldCapableSource([ bridgeSend, delivery, payIn ]),
		status: new AnchorTransactionStatus(status)
	});

	/*
	 * The swap (pay-in) folds into the bridge as one outbound conversion; the
	 * anchor's intermediate mid-token delivery is dropped as the other leg.
	 */
	const transactions = await history.list(user);
	expect(transactions).toHaveLength(1);

	const conversion = transactions[0];
	expect(conversion?.type).toBe('bridge');
	expect(conversion?.direction).toBe('out');
	expect(conversion?.send).toEqual({ token: source0.publicKeyString.get(), amount: 1000n });
	expect(conversion?.receive?.amount).toBe(998n);
	expect(conversion?.refs.anchorTxIDs).toEqual(expect.arrayContaining([ 'transfer-1', 'transfer-3' ]));
});

test('iterate absorbs an unresolved delivery leg linked to the funding block', async function() {
	const user = newAccount();
	const anchor = newAccount();
	const source0 = newToken(user, 0);
	const mid = newToken(user, 1);

	const swap = makeTransfer({
		id: 'transfer-1',
		status: 'COMPLETE',
		asset: { from: source0.publicKeyString.get(), to: mid.publicKeyString.get() },
		fromLocation: KEETA_LOCATION,
		toLocation: KEETA_LOCATION,
		fromValue: '1000',
		toValue: '999'
	});
	const bridge = makeTransfer({
		id: 'transfer-3',
		status: 'COMPLETE',
		asset: { from: mid.publicKeyString.get(), to: 'evm:0xc063' },
		fromLocation: KEETA_LOCATION,
		toLocation: EVM_LOCATION,
		fromValue: '999',
		toValue: '998'
	});

	const status = new TestStatusSource();
	status.registerByTxID(anchor, swap);
	status.registerByTxID(anchor, bridge);

	const payInExternal = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'transfer-1' }).build();
	const payIn = await seal(user, [ sendOp(anchor, source0, 1000n, payInExternal) ]);

	const deliveryExternal = await new AnchorExternal.Builder()
		.setAnchor(anchor, { transactionId: 'unresolved-delivery' })
		.withSigner(anchor)
		.withBinding(KeetaNet.lib.Block.NO_PREVIOUS, 0)
		.addInput(payIn.hash.toString(), 0)
		.build();

	const delivery = await seal(anchor, [ sendOp(user, mid, 999n, deliveryExternal) ]);
	const bridgeExternal = await new AnchorExternal.Builder().setAnchor(anchor, { transactionId: 'transfer-3' }).addInput(payIn.hash.toString(), 0).build();
	const bridgeSend = await seal(user, [ sendOp(anchor, mid, 999n, bridgeExternal) ]);

	const history = new UserHistory({
		history: pagedFoldCapableSource([ bridgeSend, delivery, payIn ]),
		status: new AnchorTransactionStatus(status)
	});

	const transactions = await history.list(user);
	expect(transactions).toHaveLength(1);
	expect(transactions[0]?.type).toBe('bridge');
	expect(transactions.some(transaction => transaction.refs.blockHashes.includes(delivery.hash.toString()))).toBe(false);
});

test('foldChains merges a two-hop linked chain into one conversion', function() {
	const hop1 = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 1000n }, receive: { token: 'tokenB', amount: 497n }, timestamp: '2026-01-01T00:00:00.000Z' });
	const hop2 = makeSwap({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenB', amount: 497n }, receive: { token: 'tokenC', amount: 1481n }, inputBlockHashes: [ 'b1' ], timestamp: '2026-01-01T00:05:00.000Z' });

	const folded = foldChains([ hop2, hop1 ]);
	expect(folded).toHaveLength(1);

	const merged = folded[0];
	expect(merged?.type).toBe('swap');
	expect(merged?.send).toEqual({ token: 'tokenA', amount: 1000n });
	expect(merged?.receive).toEqual({ token: 'tokenC', amount: 1481n });
	expect(merged?.refs.blockHashes).toEqual(expect.arrayContaining([ 'b1', 'b2' ]));
	expect(merged?.timestamp).toBe('2026-01-01T00:00:00.000Z');
});

test('foldChains merges a three-hop chain transitively', function() {
	const hop1 = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 100n }, receive: { token: 'tokenB', amount: 90n }});
	const hop2 = makeSwap({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenB', amount: 90n }, receive: { token: 'tokenC', amount: 80n }, inputBlockHashes: [ 'b1' ] });
	const hop3 = makeSwap({ id: 'b3:0', blockHash: 'b3', send: { token: 'tokenC', amount: 80n }, receive: { token: 'tokenD', amount: 70n }, inputBlockHashes: [ 'b2' ] });

	const folded = foldChains([ hop3, hop2, hop1 ]);
	expect(folded).toHaveLength(1);
	expect(folded[0]?.send).toEqual({ token: 'tokenA', amount: 100n });
	expect(folded[0]?.receive).toEqual({ token: 'tokenD', amount: 70n });
});

test('foldChains merges a five-hop chain regardless of input order', function() {
	const hop1 = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 1000n }, receive: { token: 'tokenB', amount: 900n }, fee: { token: 'feeToken', amount: 1n }, timestamp: '2026-01-01T00:00:00.000Z' });
	const hop2 = makeSwap({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenB', amount: 900n }, receive: { token: 'tokenC', amount: 800n }, inputBlockHashes: [ 'b1' ], fee: { token: 'feeToken', amount: 2n }, timestamp: '2026-01-01T00:05:00.000Z' });
	const hop3 = makeSwap({ id: 'b3:0', blockHash: 'b3', send: { token: 'tokenC', amount: 800n }, receive: { token: 'tokenD', amount: 700n }, inputBlockHashes: [ 'b2' ], fee: { token: 'feeToken', amount: 3n }, timestamp: '2026-01-01T00:10:00.000Z' });
	const hop4 = makeSwap({ id: 'b4:0', blockHash: 'b4', send: { token: 'tokenD', amount: 700n }, receive: { token: 'tokenE', amount: 600n }, inputBlockHashes: [ 'b3' ], fee: { token: 'feeToken', amount: 4n }, timestamp: '2026-01-01T00:15:00.000Z' });
	const hop5 = makeSwap({ id: 'b5:0', blockHash: 'b5', send: { token: 'tokenE', amount: 600n }, receive: { token: 'tokenF', amount: 500n }, inputBlockHashes: [ 'b4' ], fee: { token: 'feeToken', amount: 5n }, timestamp: '2026-01-01T00:20:00.000Z' });

	const folded = foldChains([ hop3, hop5, hop1, hop4, hop2 ]);
	expect(folded).toHaveLength(1);

	const merged = folded[0];
	expect(merged?.send).toEqual({ token: 'tokenA', amount: 1000n });
	expect(merged?.receive).toEqual({ token: 'tokenF', amount: 500n });
	expect(merged?.refs.blockHashes).toEqual(expect.arrayContaining([ 'b1', 'b2', 'b3', 'b4', 'b5' ]));
	expect(merged?.fee).toEqual({ token: 'feeToken', amount: 15n });
	expect(merged?.timestamp).toBe('2026-01-01T00:00:00.000Z');
});

test('foldChains leaves unlinked swaps separate', function() {
	const first = makeSwap({ id: 'a:0', blockHash: 'a', send: { token: 'tokenX', amount: 1n }, receive: { token: 'tokenY', amount: 1n }});
	const second = makeSwap({ id: 'b:0', blockHash: 'b', send: { token: 'tokenY', amount: 1n }, receive: { token: 'tokenZ', amount: 1n }});

	const folded = foldChains([ first, second ]);
	expect(folded).toHaveLength(2);
});

test('foldChains is a no-op without inputs and passes non-swaps through', function() {
	const swap = makeSwap({ id: 's:0', blockHash: 's', send: { token: 'tokenX', amount: 1n }, receive: { token: 'tokenY', amount: 1n }});
	const send: LogicalTransaction = { id: 'p:0', type: 'send', status: 'complete', direction: 'out', timestamp: '2026-01-01T00:00:00.000Z', legs: [], refs: { blockHashes: [ 'p' ], anchorTxIDs: [] }};
	const dangling = makeSwap({ id: 'd:0', blockHash: 'd', send: { token: 'tokenX', amount: 1n }, receive: { token: 'tokenY', amount: 1n }, inputBlockHashes: [ 'absent' ] });

	const input = [ swap, send, dangling ];
	const folded = foldChains(input);
	expect(folded).toEqual(input);
});

test('foldChains reports pending when any hop is pending and sums same-token fees', function() {
	const hop1 = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 100n }, receive: { token: 'tokenB', amount: 90n }, fee: { token: 'feeToken', amount: 2n }, status: 'complete' });
	const hop2 = makeSwap({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenB', amount: 90n }, receive: { token: 'tokenC', amount: 80n }, inputBlockHashes: [ 'b1' ], fee: { token: 'feeToken', amount: 3n }, status: 'pending' });

	const folded = foldChains([ hop2, hop1 ]);
	expect(folded).toHaveLength(1);
	expect(folded[0]?.status).toBe('pending');
	expect(folded[0]?.fee).toEqual({ token: 'feeToken', amount: 5n });
});

test('foldChains drops the headline fee when hops pay fees in different tokens', function() {
	const hop1 = makeSwap({ id: 'b1:0', blockHash: 'b1', send: { token: 'tokenA', amount: 100n }, receive: { token: 'tokenB', amount: 90n }, fee: { token: 'feeTokenOne', amount: 2n }});
	const hop2 = makeSwap({ id: 'b2:0', blockHash: 'b2', send: { token: 'tokenB', amount: 90n }, receive: { token: 'tokenC', amount: 80n }, inputBlockHashes: [ 'b1' ], fee: { token: 'feeTokenTwo', amount: 3n }});

	const folded = foldChains([ hop2, hop1 ]);
	expect(folded[0]?.fee).toBeUndefined();
});

// #endregion foldChains
