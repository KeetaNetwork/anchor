import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import type { Block } from '@keetanetwork/keetanet-client/lib/block/index.js';
import type { BlockOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import type { KeetaNetAccount } from './asset.js';
import type { Logger } from './log/index.js';
import type { KeetaAssetMovementTransaction } from '../services/asset-movement/common.js';
import type {
	AnchorExternalTransactionStatusOptions,
	AnchorGetTransactionStatusOptions,
	AnchorTransactionStatus,
	AnchorTransactionStatusResult,
	AnchorTransferReader
} from './anchor-status.js';
import { isCompletedTransferStatus } from './anchor-status.js';
import { convertAssetSearchInputToCanonical, isChainLocation, toAssetLocationFromString, toAssetPair } from '../services/asset-movement/common.js';

type Account = InstanceType<typeof KeetaNetLib.Account>;

const OperationType = KeetaNetLib.Block.OperationType;

/**
 * Wallet-facing logical category of a transaction.
 */
export type LogicalTransactionType = 'send' | 'receive' | 'swap' | 'deposit' | 'withdraw' | 'bridge' | 'other';

/**
 * Standardized lifecycle state. Only `complete` is asserted from a settled
 * block or a `COMPLETE` anchor status.
 */
export type LogicalTransactionStatus = 'pending' | 'complete' | 'failed';

/**
 * Flow of value relative to the queried account.
 */
export type LogicalDirection = 'in' | 'out' | 'self';

/**
 * A token (or anchor asset) and its quantity in smallest units.
 */
export type LogicalAmount = {
	/**
	 * Token public key for on-chain legs, or the anchor asset rendered as a
	 * string for anchor legs.
	 */
	token: string;
	/**
	 * Quantity in the asset's smallest unit.
	 */
	amount: bigint;
};

/**
 * The other party to a logical transaction.
 */
export type LogicalCounterparty = {
	/**
	 * What the counterparty represents.
	 */
	kind: 'account' | 'anchor' | 'liquidity';
	/**
	 * Account public key (or anchor id) of the counterparty.
	 */
	id: string;
	/**
	 * Optional display name resolved for the counterparty.
	 */
	name?: string;
};

/**
 * One constituent part of a logical transaction: either a single on-chain
 * operation or a transfer tracked at an anchor.
 */
export type LogicalLeg =
	| {
		/**
		 * On-chain operation leg.
		 */
		kind: 'onchain';
		/**
		 * Hash of the block carrying the operation.
		 */
		blockHash: string;
		/**
		 * Index of the operation within its block.
		 */
		operationIndex: number;
		/**
		 * Whether the operation sent or received value.
		 */
		opType: 'send' | 'receive';
		/**
		 * Account on the other side of the operation.
		 */
		counterparty: string;
		/**
		 * Value moved by the operation.
		 */
		amount: LogicalAmount;
	}
	| {
		/**
		 * Anchor-tracked transfer leg.
		 */
		kind: 'anchor';
		/**
		 * Anchor account the transfer was filed under.
		 */
		anchorID: string;
		/**
		 * Anchor-scoped transaction id.
		 */
		transactionID: string;
		/**
		 * Related chain transaction ids reported by the anchor.
		 */
		subTransactions: string[];
	};

/**
 * A single condensed, wallet-displayable transaction folded from one or more
 * on-chain operations and any anchor transfer that backs them.
 */
export type LogicalTransaction = {
	/**
	 * Stable id: the block hash, or `blockHash:operationIndex` when a block
	 * yields more than one logical transaction.
	 */
	id: string;
	/**
	 * Logical category.
	 */
	type: LogicalTransactionType;
	/**
	 * Standardized status.
	 */
	status: LogicalTransactionStatus;
	/**
	 * Raw provider status string, present when an anchor transfer backs the
	 * transaction. The wallet interprets non-standardized states.
	 */
	providerStatus?: string;
	/**
	 * Flow of value relative to the queried account.
	 */
	direction: LogicalDirection;
	/**
	 * ISO-8601 timestamp from the vote staple the block settled in.
	 */
	timestamp: string;
	/**
	 * Value the account sent, when applicable.
	 */
	send?: LogicalAmount;
	/**
	 * Value the account received, when applicable.
	 */
	receive?: LogicalAmount;
	/**
	 * Fee paid, when applicable.
	 */
	fee?: LogicalAmount;
	/**
	 * The other party, when one applies.
	 */
	counterparty?: LogicalCounterparty;
	/**
	 * Constituent legs.
	 */
	legs: LogicalLeg[];
	/**
	 * Source references for drill-down.
	 */
	refs: {
		/**
		 * Block hashes contributing to this logical transaction.
		 */
		blockHashes: string[];
		/**
		 * Anchor-scoped transaction ids contributing to this logical transaction.
		 */
		anchorTxIDs: string[];
		/**
		 * Raw `external` strings observed, when present.
		 */
		external?: string[];
	};
	/**
	 * Raw source the transaction was folded from. Present only when
	 * {@link UserHistoryListOptions.includeSource} is set.
	 */
	source?: LogicalTransactionSource;
};

/**
 * Raw source backing a {@link LogicalTransaction}, for callers that need to
 * drill down into the underlying on-chain data without re-fetching.
 */
export type LogicalTransactionSource = {
	/**
	 * Vote staple that settled the source block.
	 */
	staple: HistoryStaple;
	/**
	 * The enriched source block the transaction was classified from.
	 */
	enriched: EnrichedBlock;
};

/**
 * One on-chain operation enriched with the anchor transfer it resolved to,
 * if any. The classify input unit.
 */
export type EnrichedOperation = {
	/**
	 * The decoded on-chain operation.
	 */
	operation: BlockOperations;
	/**
	 * Index of the operation within its block.
	 */
	index: number;
	/**
	 * Anchor transfer the operation resolved to, if enrichment found one.
	 */
	transfer?: KeetaAssetMovementTransaction;
	/**
	 * Anchor account the transfer resolved under, when enrichment found one.
	 * Authoritative over operation counterparties: for anchor-issued payout
	 * blocks the operation counterparty is the user, not the anchor.
	 */
	anchorID?: string;
};

/**
 * A block with each of its operations enriched. The classifier operates on
 * this and has no I/O of its own.
 */
export type EnrichedBlock = {
	/**
	 * Hash of the block.
	 */
	blockHash: string;
	/**
	 * Issuing account of the block.
	 * Note: Do NOT narrow to `AccountPublicKeyString`.
	 */
	account: string;
	/**
	 * Account whose history is being folded.
	 * Note: Do NOT narrow to `AccountPublicKeyString`.
	 */
	perspective?: string;
	/**
	 * ISO-8601 timestamp from the block's vote staple.
	 */
	timestamp: string;
	/**
	 * The block's enriched operations.
	 */
	operations: EnrichedOperation[];
};

/**
 * A classifier that maps an enriched block to zero or more logical
 * transactions. Returns `null` when it does not apply.
 */
export interface LogicalClassifier {
	classify(block: EnrichedBlock): LogicalTransaction[] | null;
}

/**
 * A history page entry as produced by a node client's history call.
 */
export interface HistoryEntry {
	/**
	 * The vote staple settling one or more blocks.
	 */
	voteStaple: HistoryStaple;
}

/**
 * The minimal vote-staple surface consumed when folding history.
 */
export interface HistoryStaple {
	/**
	 * Settlement time of the staple.
	 */
	timestamp(): Date;
	/**
	 * Blocks settled by the staple.
	 */
	blocks: readonly Block[];
	/**
	 * Cursor for the next page.
	 */
	blocksHash: { toString(): string };
}

/**
 * Per-page query passed to a {@link HistorySource}.
 */
export type HistoryQuery = {
	/**
	 * Number of vote staples to walk back per page.
	 */
	depth?: number;
	/**
	 * Cursor returned by a previous page.
	 */
	startBlocksHash?: string;
	/**
	 * Page size hint.
	 */
	pageSize?: number;
};

/**
 * Inverted source of on-chain history pages, newest-first.
 */
export interface HistorySource {
	getHistory(account: GenericAccount | string | null, query?: HistoryQuery): Promise<HistoryEntry[]>;
}

/**
 * Construction inputs for {@link UserHistory}.
 */
export type UserHistoryConfig = {
	/**
	 * Source of on-chain history pages. Any object exposing
	 * {@link HistorySource.getHistory} is accepted, including a node client.
	 */
	history: HistorySource;
	/**
	 * Anchor status reader used to enrich operations.
	 */
	status?: AnchorTransactionStatus<KeetaAssetMovementTransaction>;
	/**
	 * Ordered classifiers, specific-first.
	 * Defaults to {@link defaultClassifiers}.
	 */
	classifiers?: readonly LogicalClassifier[];
	/**
	 * Logger for diagnostics.
	 */
	logger?: Logger;
};

/**
 * Per-call options for {@link UserHistory.list}.
 */
export type UserHistoryListOptions = {
	/**
	 * Vote staples to walk back per page.
	 */
	depth?: number;
	/**
	 * Page size hint.
	 */
	pageSize?: number;
	/**
	 * Maximum number of logical transactions to return.
	 */
	limit?: number;
	/**
	 * Cursor to resume paging from.
	 */
	cursor?: string;
	/**
	 * Enable anchor enrichment.
	 * Defaults to `true` when a status source is set.
	 */
	enrich?: boolean;
	/**
	 * Keys tried against encrypted external slices.
	 */
	decryptionKeys?: Account[];
	/**
	 * Account used to authenticate anchor status reads.
	 */
	requesterAccount?: KeetaNetAccount;
	/**
	 * Attach {@link LogicalTransaction.source} to each returned transaction.
	 * Defaults to `false` to keep results lean.
	 */
	includeSource?: boolean;
};

/**
 * Parse a value string into smallest-unit units, defaulting to zero on a
 * value that is not a whole-number string.
 */
function toUnits(value: string): bigint {
	try {
		return(BigInt(value));
	} catch {
		return(0n);
	}
}

/**
 * Whether a location string denotes a chain (optionally a specific one).
 */
function locationIsChain(location: string, chainType?: 'keeta'): boolean {
	let parsed;
	try {
		parsed = toAssetLocationFromString(location);
	} catch {
		return(false);
	}

	return(isChainLocation(parsed, chainType));
}

/**
 * Derive the logical type of an anchor transfer from its endpoints.
 */
export function logicalTypeFromTransfer(transfer: KeetaAssetMovementTransaction): LogicalTransactionType {
	const fromKeeta = locationIsChain(transfer.from.location, 'keeta');
	const toKeeta = locationIsChain(transfer.to.location, 'keeta');
	if (fromKeeta && toKeeta) {
		return('swap');
	}

	const fromChain = locationIsChain(transfer.from.location);
	const toChain = locationIsChain(transfer.to.location);
	if ((fromKeeta && toChain) || (toKeeta && fromChain)) {
		return('bridge');
	}

	if (fromKeeta) {
		return('withdraw');
	}

	if (toKeeta) {
		return('deposit');
	}

	return('other');
}

/**
 * Map an anchor transfer's raw status onto the standardized status, carrying
 * the raw provider string for the wallet to interpret.
 */
export function statusFromTransfer(transfer: KeetaAssetMovementTransaction): { status: LogicalTransactionStatus; providerStatus: string } {
	if (isCompletedTransferStatus(transfer.status)) {
		return({ status: 'complete', providerStatus: transfer.status });
	}

	return({ status: 'pending', providerStatus: transfer.status });
}

/**
 * Derive value flow for an anchor transfer type.
 */
function directionFromTransfer(type: LogicalTransactionType, fromKeeta: boolean): LogicalDirection {
	if (type === 'deposit') {
		return('in');
	}

	if (type === 'withdraw') {
		return('out');
	}

	if (type === 'bridge') {
		if (fromKeeta) {
			return('out');
		}

		return('in');
	}

	return('self');
}

/**
 * Collect the chain transaction ids an anchor transfer references.
 */
function collectAnchorSubTransactions(transfer: KeetaAssetMovementTransaction): string[] {
	const ids: string[] = [];
	const groups = [ transfer.from.transactions, transfer.to.transactions ];
	for (const group of groups) {
		for (const value of Object.values(group)) {
			if (value !== null && value !== undefined) {
				ids.push(value.id);
			}
		}
	}

	return(ids);
}

/**
 * A SEND/RECEIVE operation reduced to its logical shape.
 */
type OperationView = {
	opType: 'send' | 'receive';
	counterparty: string;
	amount: LogicalAmount;
};

/**
 * Reduce a block operation to its logical view, or `null` for non-transfer
 * operations.
 */
function operationView(operation: BlockOperations): OperationView | null {
	if (operation.type === OperationType.SEND) {
		return({
			opType: 'send',
			counterparty: operation.to.publicKeyString.get(),
			amount: { token: operation.token.publicKeyString.get(), amount: operation.amount }
		});
	}
	if (operation.type === OperationType.RECEIVE) {
		return({
			opType: 'receive',
			counterparty: operation.from.publicKeyString.get(),
			amount: { token: operation.token.publicKeyString.get(), amount: operation.amount }
		});
	}

	return(null);
}

/**
 * Reduce an operation to its logical view relative to the block's
 * perspective account.
 */
function viewOf(block: EnrichedBlock, operation: BlockOperations): OperationView | null {
	const native = operationView(operation);
	if (native === null) {
		return(null);
	}

	if (block.perspective === undefined || block.perspective === block.account) {
		return(native);
	}

	if (native.opType === 'send' && native.counterparty === block.perspective) {
		return({ opType: 'receive', counterparty: block.account, amount: native.amount });
	}

	return(null);
}

/**
 * The account on the other side of a transfer operation, if any.
 */
function counterpartyID(operation: BlockOperations): string | undefined {
	if (operation.type === OperationType.SEND) {
		return(operation.to.publicKeyString.get());
	}
	if (operation.type === OperationType.RECEIVE) {
		return(operation.from.publicKeyString.get());
	}

	return(undefined);
}

/**
 * An operation view paired with its block-relative index.
 */
type IndexedView = OperationView & { index: number };

/**
 * Partition a block's operations into send/receive views.
 */
function viewsOf(block: EnrichedBlock): { sends: IndexedView[]; receives: IndexedView[]; otherCount: number } {
	const sends: IndexedView[] = [];
	const receives: IndexedView[] = [];
	let otherCount = 0;
	for (const enriched of block.operations) {
		const view = viewOf(block, enriched.operation);
		if (view === null) {
			otherCount++;
			continue;
		}

		const indexed: IndexedView = { ...view, index: enriched.index };
		if (indexed.opType === 'send') {
			sends.push(indexed);
		} else {
			receives.push(indexed);
		}
	}

	return({ sends, receives, otherCount });
}

/**
 * The shared counterparty across views, or `undefined` when they differ.
 */
function uniformCounterparty(views: readonly IndexedView[]): string | undefined {
	const first = views[0];
	if (first === undefined) {
		return(undefined);
	}

	for (const view of views) {
		if (view.counterparty !== first.counterparty) {
			return(undefined);
		}
	}

	return(first.counterparty);
}

/**
 * Build on-chain legs for every transfer operation in a block.
 */
function onchainLegs(block: EnrichedBlock): LogicalLeg[] {
	const legs: LogicalLeg[] = [];
	for (const enriched of block.operations) {
		const view = viewOf(block, enriched.operation);
		if (view === null) {
			continue;
		}

		legs.push({
			kind: 'onchain',
			blockHash: block.blockHash,
			operationIndex: enriched.index,
			opType: view.opType,
			counterparty: view.counterparty,
			amount: view.amount
		});
	}

	return(legs);
}

/**
 * Collect raw `external` strings carried by a block's SEND operations.
 */
function blockExternals(block: EnrichedBlock): string[] {
	const externals: string[] = [];
	for (const enriched of block.operations) {
		const operation = enriched.operation;
		if (operation.type === OperationType.SEND && operation.external !== undefined) {
			externals.push(operation.external);
		}
	}

	return(externals);
}

/**
 * Build the refs block for a logical transaction.
 */
function buildRefs(block: EnrichedBlock, anchorTxIDs: string[]): LogicalTransaction['refs'] {
	const refs: LogicalTransaction['refs'] = { blockHashes: [ block.blockHash ], anchorTxIDs };
	const externals = blockExternals(block);
	if (externals.length > 0) {
		refs.external = externals;
	}

	return(refs);
}

// #endregion Operation views

// #region Classifiers

/**
 * Build the logical transaction backing one enriched anchor operation.
 */
function buildAnchorTransaction(block: EnrichedBlock, enriched: EnrichedOperation, transfer: KeetaAssetMovementTransaction): LogicalTransaction {
	const type = logicalTypeFromTransfer(transfer);
	const fromKeeta = locationIsChain(transfer.from.location, 'keeta');
	const direction = directionFromTransfer(type, fromKeeta);
	const settled = statusFromTransfer(transfer);
	const assets = toAssetPair(transfer.asset);
	const view = viewOf(block, enriched.operation);

	const legs: LogicalLeg[] = [];
	if (view !== null) {
		legs.push({
			kind: 'onchain',
			blockHash: block.blockHash,
			operationIndex: enriched.index,
			opType: view.opType,
			counterparty: view.counterparty,
			amount: view.amount
		});
	}

	const anchorID = enriched.anchorID ?? view?.counterparty ?? transfer.id;
	legs.push({
		kind: 'anchor',
		anchorID,
		transactionID: transfer.id,
		subTransactions: collectAnchorSubTransactions(transfer)
	});

	const refs: LogicalTransaction['refs'] = { blockHashes: [ block.blockHash ], anchorTxIDs: [ transfer.id ] };
	const externals = blockExternals(block);
	if (externals.length > 0) {
		refs.external = externals;
	}

	const transaction: LogicalTransaction = {
		id: `${block.blockHash}:${enriched.index}`,
		type,
		status: settled.status,
		providerStatus: settled.providerStatus,
		direction,
		timestamp: block.timestamp,
		send: { token: convertAssetSearchInputToCanonical(assets.from), amount: toUnits(transfer.from.value) },
		receive: { token: convertAssetSearchInputToCanonical(assets.to), amount: toUnits(transfer.to.value) },
		legs,
		refs
	};

	transaction.counterparty = { kind: 'anchor', id: anchorID };

	if (transfer.fee !== null) {
		transaction.fee = { token: convertAssetSearchInputToCanonical(transfer.fee.asset), amount: toUnits(transfer.fee.value) };
	}

	return(transaction);
}

/**
 * Emits one logical transaction per operation that resolved to an anchor
 * transfer; the logical type comes from the transfer, not block shape.
 */
const anchorTransferClassifier: LogicalClassifier = {
	classify(block) {
		const transactions: LogicalTransaction[] = [];
		for (const enriched of block.operations) {
			const transfer = enriched.transfer;
			if (transfer === undefined) {
				continue;
			}

			transactions.push(buildAnchorTransaction(block, enriched, transfer));
		}

		if (transactions.length === 0) {
			return(null);
		}

		return(transactions);
	}
};

/**
 * Pick the swap principal: the largest send whose token differs from the
 * received token.
 */
function principalSend(sends: readonly IndexedView[], receivedToken: string): IndexedView | undefined {
	let principal: IndexedView | undefined;
	for (const send of sends) {
		if (send.amount.token === receivedToken) {
			continue;
		}

		if (principal === undefined || send.amount.amount > principal.amount.amount) {
			principal = send;
		}
	}

	return(principal);
}

/**
 * Aggregate the non-principal sends into a single fee amount.
 */
function aggregateFee(feeSends: readonly IndexedView[]): LogicalAmount | undefined {
	const first = feeSends[0];
	if (first === undefined) {
		return(undefined);
	}

	let amount = 0n;
	for (const send of feeSends) {
		if (send.amount.token === first.amount.token) {
			amount += send.amount.amount;
		}
	}

	return({ token: first.amount.token, amount });
}

/**
 * Classifies an on-chain atomic swap: SEND(s) and RECEIVE(s) against a single
 * counterparty with differing send/receive tokens.
 */
const atomicSwapClassifier: LogicalClassifier = {
	classify(block) {
		const { sends, receives, otherCount } = viewsOf(block);
		if (otherCount !== 0 || sends.length === 0 || receives.length === 0) {
			return(null);
		}

		const counterparty = uniformCounterparty([ ...sends, ...receives ]);
		if (counterparty === undefined) {
			return(null);
		}

		const received = receives[0];
		if (received === undefined) {
			return(null);
		}

		const principal = principalSend(sends, received.amount.token);
		if (principal === undefined) {
			return(null);
		}

		const fee = aggregateFee(sends.filter(send => send.index !== principal.index));

		const transaction: LogicalTransaction = {
			id: block.blockHash,
			type: 'swap',
			status: 'complete',
			direction: 'self',
			timestamp: block.timestamp,
			send: principal.amount,
			receive: received.amount,
			counterparty: { kind: 'liquidity', id: counterparty },
			legs: onchainLegs(block),
			refs: buildRefs(block, [])
		};

		if (fee !== undefined) {
			transaction.fee = fee;
		}

		return([ transaction ]);
	}
};

/**
 * Classifies a SEND-only block as a plain send.
 */
const sendClassifier: LogicalClassifier = {
	classify(block) {
		const { sends, receives, otherCount } = viewsOf(block);
		if (otherCount !== 0 || receives.length !== 0 || sends.length === 0) {
			return(null);
		}

		const primary = sends[0];
		if (primary === undefined) {
			return(null);
		}

		const transaction: LogicalTransaction = {
			id: block.blockHash,
			type: 'send',
			status: 'complete',
			direction: 'out',
			timestamp: block.timestamp,
			send: primary.amount,
			legs: onchainLegs(block),
			refs: buildRefs(block, [])
		};

		const counterparty = uniformCounterparty(sends);
		if (counterparty !== undefined) {
			transaction.counterparty = { kind: 'account', id: counterparty };
		}

		return([ transaction ]);
	}
};

/**
 * Classifies a RECEIVE-only block as a plain receive.
 */
const receiveClassifier: LogicalClassifier = {
	classify(block) {
		const { sends, receives, otherCount } = viewsOf(block);
		if (otherCount !== 0 || sends.length !== 0 || receives.length === 0) {
			return(null);
		}

		const primary = receives[0];
		if (primary === undefined) {
			return(null);
		}

		const transaction: LogicalTransaction = {
			id: block.blockHash,
			type: 'receive',
			status: 'complete',
			direction: 'in',
			timestamp: block.timestamp,
			receive: primary.amount,
			legs: onchainLegs(block),
			refs: buildRefs(block, [])
		};

		const counterparty = uniformCounterparty(receives);
		if (counterparty !== undefined) {
			transaction.counterparty = { kind: 'account', id: counterparty };
		}

		return([ transaction ]);
	}
};

/**
 * Fallback that emits a single `other` transaction for any unmatched block.
 */
const otherClassifier: LogicalClassifier = {
	classify(block) {
		const transaction: LogicalTransaction = {
			id: block.blockHash,
			type: 'other',
			status: 'complete',
			direction: 'self',
			timestamp: block.timestamp,
			legs: onchainLegs(block),
			refs: buildRefs(block, [])
		};

		return([ transaction ]);
	}
};

/**
 * Default ordered classifier list, specific-first.
 */
export const defaultClassifiers: readonly LogicalClassifier[] = [
	anchorTransferClassifier,
	atomicSwapClassifier,
	sendClassifier,
	receiveClassifier,
	otherClassifier
];

/**
 * Within a settled staple, drop foreign counterpart blocks whose settlement is
 * already represented by a perspective-owned block.
 */
function suppressCoveredForeignBlocks(blocks: readonly EnrichedBlock[]): readonly EnrichedBlock[] {
	const perspective = blocks.find(block => block.perspective !== undefined)?.perspective;
	if (perspective === undefined) {
		return(blocks);
	}

	const owned = blocks.filter(block => block.account === perspective);
	if (owned.length === 0) {
		return(blocks);
	}

	const covered = new Set<string>();
	for (const block of owned) {
		for (const enriched of block.operations) {
			const counterparty = counterpartyID(enriched.operation);
			if (counterparty !== undefined) {
				covered.add(counterparty);
			}
		}
	}

	const result = blocks.filter(block => block.account === perspective || !covered.has(block.account));
	return(result);
}

/**
 * Fold enriched blocks into logical transactions by running the ordered
 * classifiers; the first classifier that applies to a block wins.
 */
export function foldHistory(blocks: readonly EnrichedBlock[], classifiers: readonly LogicalClassifier[]): LogicalTransaction[] {
	const results: LogicalTransaction[] = [];
	for (const block of suppressCoveredForeignBlocks(blocks)) {
		for (const classifier of classifiers) {
			const classified = classifier.classify(block);
			if (classified !== null) {
				results.push(...classified);
				break;
			}
		}
	}

	return(results);
}

/**
 * A transfer paired with the anchor account it resolved under.
 */
type ResolvedTransfer = {
	anchorID: string;
	transfer: KeetaAssetMovementTransaction;
};

/**
 * The first transfer reported as a status across an external's anchors.
 */
function firstResolvedTransfer(results: { [anchorID: string]: AnchorTransactionStatusResult<KeetaAssetMovementTransaction> }): ResolvedTransfer | undefined {
	for (const [ anchorID, result ] of Object.entries(results)) {
		if (result.kind === 'status') {
			return({ anchorID, transfer: result.status.transaction });
		}
	}

	return(undefined);
}

/**
 * Build decode + status options for an external resolution.
 */
function buildExternalOptions(options?: UserHistoryListOptions): AnchorExternalTransactionStatusOptions {
	const built: AnchorExternalTransactionStatusOptions = {};
	if (options?.decryptionKeys !== undefined) {
		built.decryptionKeys = options.decryptionKeys;
	}

	if (options?.requesterAccount !== undefined) {
		built.requesterAccount = options.requesterAccount;
	}

	return(built);
}

/**
 * Attach raw sources to folded transactions by their source block hash.
 *
 * A transaction id is its block hash, or `blockHash:operationIndex` when a
 * block yields more than one logical transaction.
 */
function attachSources(transactions: readonly LogicalTransaction[], sources: ReadonlyMap<string, LogicalTransactionSource>): void {
	for (const transaction of transactions) {
		const [ blockHash ] = transaction.id.split(':');
		if (blockHash === undefined) {
			continue;
		}

		const source = sources.get(blockHash);
		if (source !== undefined) {
			transaction.source = source;
		}
	}
}

/**
 * Normalize the queried account to its public key string.
 */
function perspectiveOf(account: GenericAccount | string | null): string | undefined {
	if (account === null) {
		return(undefined);
	}

	if (typeof account === 'string') {
		return(account);
	}

	return(account.publicKeyString.get());
}

/**
 * Build status options for a reverse-lookup.
 */
function buildStatusOptions(options?: UserHistoryListOptions): AnchorGetTransactionStatusOptions {
	const built: AnchorGetTransactionStatusOptions = {};
	if (options?.requesterAccount !== undefined) {
		built.requesterAccount = options.requesterAccount;
	}

	return(built);
}

/**
 * Folds a user's on-chain history and anchor transfer data into a condensed
 * list of {@link LogicalTransaction}.
 */
export class UserHistory {
	readonly #history: HistorySource;
	readonly #status?: AnchorTransactionStatus<KeetaAssetMovementTransaction>;
	readonly #classifiers: readonly LogicalClassifier[];
	readonly #logger?: Logger;

	constructor(config: UserHistoryConfig) {
		this.#history = config.history;
		if (config.status !== undefined) {
			this.#status = config.status;
		}

		if (config.logger !== undefined) {
			this.#logger = config.logger;
		}

		this.#classifiers = config.classifiers ?? defaultClassifiers;
	}

	/**
	 * Fetch, enrich and fold a user's history into logical transactions.
	 */
	async list(account: GenericAccount | string | null, options?: UserHistoryListOptions): Promise<LogicalTransaction[]> {
		const transactions: LogicalTransaction[] = [];
		for await (const transaction of this.iterate(account, options)) {
			transactions.push(transaction);
		}

		return(transactions);
	}

	/**
	 * Stream logical transactions page by page instead of buffering the full
	 * result set in memory.
	 */
	async *iterate(account: GenericAccount | string | null, options?: UserHistoryListOptions): AsyncGenerator<LogicalTransaction> {
		const externalCache = new Map<string, ResolvedTransfer | undefined>();
		const readerCache = new Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>();
		const perspective = perspectiveOf(account);

		let cursor = options?.cursor;
		let yielded = 0;
		while (true) {
			const page = await this.#fetchPage(account, cursor, options);
			if (page.length === 0) {
				return;
			}

			for (const entry of page) {
				const timestamp = entry.voteStaple.timestamp().toISOString();
				const blocks: EnrichedBlock[] = [];
				const sources = new Map<string, LogicalTransactionSource>();
				for (const block of entry.voteStaple.blocks) {
					const enriched = await this.#enrichBlock(block, timestamp, perspective, options, externalCache, readerCache);
					blocks.push(enriched);

					if (options?.includeSource === true) {
						sources.set(enriched.blockHash, { staple: entry.voteStaple, enriched });
					}
				}

				const logical = foldHistory(blocks, this.#classifiers);
				attachSources(logical, sources);

				for (const transaction of logical) {
					yield transaction;
					yielded += 1;

					if (options?.limit !== undefined && yielded >= options.limit) {
						return;
					}
				}
			}

			const last = page[page.length - 1];
			if (last === undefined) {
				return;
			}

			cursor = last.voteStaple.blocksHash.toString();
			if (options?.limit === undefined) {
				return;
			}
		}
	}

	/**
	 * Fetch one page of on-chain history.
	 */
	async #fetchPage(account: GenericAccount | string | null, cursor: string | undefined, options?: UserHistoryListOptions): Promise<HistoryEntry[]> {
		const query: HistoryQuery = {};
		if (options?.depth !== undefined) {
			query.depth = options.depth;
		}
		if (options?.pageSize !== undefined) {
			query.pageSize = options.pageSize;
		}
		if (cursor !== undefined) {
			query.startBlocksHash = cursor;
		}

		const result = await this.#history.getHistory(account, query);
		return(result);
	}

	/**
	 * Enrich each operation of a block with its anchor transfer, if resolvable.
	 */
	async #enrichBlock(block: Block, timestamp: string, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<EnrichedBlock> {
		const blockHash = block.hash.toString();
		const account = block.account.publicKeyString.get();
		const enrichEnabled = options?.enrich !== false && this.#status !== undefined;

		/*
		 * A single anchor transfer (an FX swap, say) can be settled by several
		 * operations in one block.
		 */
		const attachedTransferIDs = new Set<string>();
		const operations: EnrichedOperation[] = [];
		for (let index = 0; index < block.operations.length; index++) {
			const operation = block.operations[index];
			if (operation === undefined) {
				continue;
			}

			const enriched: EnrichedOperation = { operation, index };
			if (enrichEnabled) {
				const resolved = await this.#resolveTransfer(block, operation, index, perspective, options, externalCache, readerCache);
				if (resolved !== undefined && !attachedTransferIDs.has(resolved.transfer.id)) {
					attachedTransferIDs.add(resolved.transfer.id);
					enriched.transfer = resolved.transfer;
					enriched.anchorID = resolved.anchorID;
				}
			}

			operations.push(enriched);
		}

		const result: EnrichedBlock = { blockHash, account, timestamp, operations };
		if (perspective !== undefined) {
			result.perspective = perspective;
		}

		return(result);
	}

	/**
	 * Resolve one operation to its anchor transfer, preferring the SEND's own
	 * `external` and falling back to a reverse-lookup by on-chain coordinates.
	 */
	async #resolveTransfer(block: Block, operation: BlockOperations, index: number, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<ResolvedTransfer | undefined> {
		const status = this.#status;
		if (status === undefined) {
			return(undefined);
		}

		if (operation.type === OperationType.SEND && operation.external !== undefined) {
			const fromExternal = await this.#resolveFromExternal(status, operation.external, options, externalCache);
			if (fromExternal !== undefined) {
				return(fromExternal);
			}
		}

		const issuer = block.account.publicKeyString.get();
		let candidateAnchor: string | undefined;
		if (perspective !== undefined && issuer !== perspective) {
			candidateAnchor = issuer;
		} else {
			candidateAnchor = counterpartyID(operation);
		}

		if (candidateAnchor === undefined) {
			return(undefined);
		}

		const fromOnChain = await this.#resolveByOnChain(status, candidateAnchor, block.network, block.hash.toString(), index, options, readerCache);
		return(fromOnChain);
	}

	/**
	 * Resolve a transfer from a SEND's `external` envelope, deduped per blob.
	 */
	async #resolveFromExternal(status: AnchorTransactionStatus<KeetaAssetMovementTransaction>, external: string, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>): Promise<ResolvedTransfer | undefined> {
		const cached = externalCache.get(external);
		if (cached !== undefined || externalCache.has(external)) {
			return(cached);
		}

		let resolved: ResolvedTransfer | undefined;
		try {
			const results = await status.getStatusesFromExternal(external, buildExternalOptions(options));
			resolved = firstResolvedTransfer(results);
		} catch (error) {
			this.#logger?.debug('UserHistory::resolveFromExternal', `External did not resolve to a transfer, degrading to block-shape classification: ${String(error)}`);
			resolved = undefined;
		}

		externalCache.set(external, resolved);
		return(resolved);
	}

	/**
	 * Reverse-lookup a transfer by on-chain coordinates through the anchor the
	 * counterparty resolves to.
	 */
	async #resolveByOnChain(status: AnchorTransactionStatus<KeetaAssetMovementTransaction>, counterparty: string, networkID: bigint, blockHash: string, operationIndex: number, options: UserHistoryListOptions | undefined, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<ResolvedTransfer | undefined> {
		const reader = await this.#getReader(status, counterparty, readerCache);
		if (reader?.findByOnChain === undefined) {
			return(undefined);
		}

		try {
			const result = await reader.findByOnChain({ keetaNetworkID: networkID, blockHash, operationIndex }, buildStatusOptions(options));
			if (result === null) {
				return(undefined);
			}

			return({ anchorID: counterparty, transfer: result.transaction });
		} catch (error) {
			this.#logger?.debug('UserHistory::resolveByOnChain', `Reverse-lookup at ${counterparty} for ${blockHash}:${operationIndex} failed: ${String(error)}`);
			return(undefined);
		}
	}

	/**
	 * Resolve and cache the reader for an anchor counterparty.
	 */
	async #getReader(status: AnchorTransactionStatus<KeetaAssetMovementTransaction>, counterparty: string, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<AnchorTransferReader<KeetaAssetMovementTransaction> | null> {
		const cached = readerCache.get(counterparty);
		if (cached !== undefined || readerCache.has(counterparty)) {
			return(cached ?? null);
		}

		let reader: AnchorTransferReader<KeetaAssetMovementTransaction> | null;
		try {
			const anchor = KeetaNetLib.Account.fromPublicKeyString(counterparty);
			reader = await status.getReader(anchor);
		} catch (error) {
			this.#logger?.debug('UserHistory::getReader', `No reader resolved for ${counterparty}: ${String(error)}`);
			reader = null;
		}

		readerCache.set(counterparty, reader);
		return(reader);
	}
}

export default UserHistory;
