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
	HistorySource,
	LogicalDirection,
	LogicalTransaction,
	LogicalTransactionStatus,
	LogicalTransactionType,
	UserHistoryConfig,
	UserHistoryListOptions
} from './history.js';
import type { ServiceMetadataExternalizable } from './resolver.js';
import { KeetaNet } from '../client/index.js';
import { KeetaNetAssetMovementAnchorHTTPServer } from '../services/asset-movement/server.js';
import { AnchorExternal } from './anchor-external.js';
import { AnchorTransactionStatus } from './anchor-status.js';
import { UserHistory } from './history.js';
import { createNodeAndClient } from './utils/tests/node.js';
import KeetaAssetMovementStatusSource from '../services/asset-movement/status-source.js';
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
		name: 'an atomic swap with a cost send',
		build: ({ alice, primary, secondary, cost }) => [ sendOp(alice, primary, 1000n), sendOp(alice, cost, 5n), receiveOp(alice, secondary, 990n) ],
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

test('an atomic swap with a cost send records principal, receive and fee', async function() {
	const user = newAccount();
	const liquidity = newAccount();
	const tokenA = newToken(user, 0);
	const tokenB = newToken(user, 1);
	const tokenCost = newToken(user, 2);
	const block = await seal(user, [
		sendOp(liquidity, tokenA, 1000n),
		sendOp(liquidity, tokenCost, 5n),
		receiveOp(liquidity, tokenB, 990n)
	]);

	const [ transaction ] = await runHistory([ block ]);
	expect(transaction?.send).toEqual({ token: tokenA.publicKeyString.get(), amount: 1000n });
	expect(transaction?.receive).toEqual({ token: tokenB.publicKeyString.get(), amount: 990n });
	expect(transaction?.fee).toEqual({ token: tokenCost.publicKeyString.get(), amount: 5n });
	expect(transaction?.counterparty).toEqual({ kind: 'liquidity', id: liquidity.publicKeyString.get() });
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
		const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionID: testCase.id }).build();
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
	const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionID: 'withdraw-tx' }).build();
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
	const external = await new AnchorExternal.Builder().setAnchor(anchor, { transactionID: 'withdraw-tx' }).build();
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
		.setAnchor(anchor, { transactionID: 'withdraw-tx' })
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

	const external = await new AnchorExternal.Builder().setAnchor(anchorAccount, { transactionID: input.id }).build();
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
