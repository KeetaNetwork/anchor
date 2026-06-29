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
import type { AnchorExternalInput } from './anchor-external.js';
import type { VerifiableAccount } from './utils/signing.js';
import { isCompletedTransferStatus } from './anchor-status.js';
import { AnchorExternal } from './anchor-external.js';
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
		/**
		 * On-chain operations this transaction declared as its inputs, decoded
		 * from the `external` envelope.
		 */
		inputs?: AnchorExternalInput[];
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
	/**
	 * On-chain inputs decoded from the block's SEND `external` envelopes, in
	 * the order observed. Captured locally during enrichment, independent of
	 * anchor status resolution. Present only when non-empty.
	 */
	inputs?: AnchorExternalInput[];
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
 * Account a history is read for: an account instance, its public-key
 * string, or `null` for the network-wide perspective.
 */
export type HistoryAccount = GenericAccount | string | null;

/**
 * Inverted source of on-chain history pages, newest-first.
 */
export interface HistorySource {
	getHistory(account: HistoryAccount, query?: HistoryQuery): Promise<HistoryEntry[]>;
	/**
	 * Fetch the vote staple settling `blockHash`, or `null`/`undefined` when it
	 * cannot be resolved. Optional: when present, {@link UserHistory.iterate}
	 * folds linked multi-hop swap chains incrementally (resolving each
	 * referenced predecessor by hash) instead of buffering the whole account.
	 */
	getVoteStaple?(blockHash: string): Promise<HistoryStaple | null | undefined>;
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
	 * Maximum number of logical transactions to return. When unset, every page
	 * of history is walked until exhausted.
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
function logicalTypeFromTransfer(transfer: KeetaAssetMovementTransaction): LogicalTransactionType {
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
function statusFromTransfer(transfer: KeetaAssetMovementTransaction): { status: LogicalTransactionStatus; providerStatus: string } {
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
 * Decode the on-chain `inputs` declared by a block's SEND `external` envelopes.
 */
async function decodeExternalInputs(externals: readonly string[], decryptionKeys: VerifiableAccount[] | undefined): Promise<AnchorExternalInput[]> {
	const inputs: AnchorExternalInput[] = [];
	for (const external of externals) {
		let decoded: AnchorExternal;
		try {
			const decodeOptions: { decryptionKeys?: VerifiableAccount[] } = {};
			if (decryptionKeys !== undefined) {
				decodeOptions.decryptionKeys = decryptionKeys;
			}

			decoded = await AnchorExternal.fromExternal(external, decodeOptions);
		} catch {
			continue;
		}

		const envelopeInputs = decoded.envelope.inputs;
		if (envelopeInputs !== undefined) {
			for (const inputReference of envelopeInputs) {
				inputs.push(inputReference);
			}
		}
	}

	return(inputs);
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

	if (block.inputs !== undefined && block.inputs.length > 0) {
		refs.inputs = block.inputs;
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

	const refs = buildRefs(block, [ transfer.id ]);
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
 * Aggregate the non-principal sends into a single fee amount, or `undefined`
 * when there are none or they use more than one token.
 */
function aggregateFee(feeSends: readonly IndexedView[]): LogicalAmount | undefined {
	const first = feeSends[0];
	if (first === undefined) {
		return(undefined);
	}

	let amount = 0n;
	for (const send of feeSends) {
		if (send.amount.token !== first.amount.token) {
			return(undefined);
		}

		amount += send.amount.amount;
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
function foldHistory(blocks: readonly EnrichedBlock[], classifiers: readonly LogicalClassifier[]): LogicalTransaction[] {
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
 * Append `value` to `target` only when it is not already present.
 */
function pushUnique<T>(target: T[], value: T): void {
	if (!target.includes(value)) {
		target.push(value);
	}
}

/**
 * Whether `transaction` declares an on-chain input that points at one of the
 * blocks contributing to `candidate`.
 */
function inputsReference(transaction: LogicalTransaction, candidate: LogicalTransaction): boolean {
	const inputs = transaction.refs.inputs;
	if (inputs === undefined) {
		return(false);
	}

	const blockHashes = new Set(candidate.refs.blockHashes);
	for (const input of inputs) {
		if (blockHashes.has(input.blockHash)) {
			return(true);
		}
	}

	return(false);
}

/**
 * Sum the hops' fees when they all share one token.
 */
function combineFees(fees: readonly LogicalAmount[]): LogicalAmount | undefined {
	const first = fees.at(0);
	if (first === undefined) {
		return(undefined);
	}

	let total = 0n;
	for (const fee of fees) {
		if (fee.token !== first.token) {
			return(undefined);
		}

		total += fee.amount;
	}

	return({ token: first.token, amount: total });
}

/**
 * The counterparty shared by every hop, or `undefined` when the hops disagree.
 */
function sharedCounterparty(hops: readonly LogicalTransaction[]): LogicalCounterparty | undefined {
	let shared: LogicalCounterparty | undefined;
	for (const hop of hops) {
		if (hop.counterparty === undefined) {
			return(undefined);
		}

		if (shared === undefined) {
			shared = hop.counterparty;
			continue;
		}

		if (shared.kind !== hop.counterparty.kind || shared.id !== hop.counterparty.id) {
			return(undefined);
		}
	}

	return(shared);
}

/**
 * Reduce a linked chain of swap hops (head -> ... -> tail) into one logical
 * conversion: the head's send into the tail's receive, with intermediate
 * hops' legs suppressed and every hop's `refs` merged for drill-down.
 */
type MergedHopRefs = {
	blockHashes: string[];
	anchorTxIDs: string[];
	externals: string[];
	inputs: AnchorExternalInput[];
};

/**
 * Merge every hop's `refs`, de-duplicating block hashes, anchor transfer ids
 * and externals while preserving the ordered on-chain inputs.
 */
function accumulateHopRefs(hops: readonly LogicalTransaction[]): MergedHopRefs {
	const merged: MergedHopRefs = { blockHashes: [], anchorTxIDs: [], externals: [], inputs: [] };
	for (const hop of hops) {
		for (const blockHash of hop.refs.blockHashes) {
			pushUnique(merged.blockHashes, blockHash);
		}
		for (const anchorTxID of hop.refs.anchorTxIDs) {
			pushUnique(merged.anchorTxIDs, anchorTxID);
		}
		for (const external of hop.refs.external ?? []) {
			pushUnique(merged.externals, external);
		}
		for (const input of hop.refs.inputs ?? []) {
			merged.inputs.push(input);
		}
	}

	return(merged);
}

/**
 * Combine hop statuses with failed taking precedence over pending over
 * complete.
 */
function aggregateHopStatus(hops: readonly LogicalTransaction[]): LogicalTransactionStatus {
	let pending = false;
	for (const hop of hops) {
		if (hop.status === 'failed') {
			return('failed');
		}

		if (hop.status === 'pending') {
			pending = true;
		}
	}

	return(pending ? 'pending' : 'complete');
}

/**
 * The earliest timestamp across the hops, never later than `fallback`.
 */
function earliestHopTimestamp(hops: readonly LogicalTransaction[], fallback: string): string {
	let earliest = fallback;
	for (const hop of hops) {
		if (Date.parse(hop.timestamp) < Date.parse(earliest)) {
			earliest = hop.timestamp;
		}
	}

	return(earliest);
}

/**
 * The fees declared by the hops, in chain order.
 */
function collectHopFees(hops: readonly LogicalTransaction[]): LogicalAmount[] {
	const fees: LogicalAmount[] = [];
	for (const hop of hops) {
		if (hop.fee !== undefined) {
			fees.push(hop.fee);
		}
	}

	return(fees);
}

/**
 * The head's legs followed by the tail's, suppressing intermediate hops and
 * avoiding a duplicate when head and tail are the same transaction.
 */
function mergeHopLegs(head: LogicalTransaction, tail: LogicalTransaction): LogicalLeg[] {
	const legs: LogicalLeg[] = [ ...head.legs ];
	if (tail.id !== head.id) {
		legs.push(...tail.legs);
	}

	return(legs);
}

function mergeChainHops(head: LogicalTransaction, tail: LogicalTransaction, hops: readonly LogicalTransaction[]): LogicalTransaction {
	const { blockHashes, anchorTxIDs, externals, inputs } = accumulateHopRefs(hops);

	const refs: LogicalTransaction['refs'] = { blockHashes, anchorTxIDs };
	if (externals.length > 0) {
		refs.external = externals;
	}

	if (inputs.length > 0) {
		refs.inputs = inputs;
	}

	const merged: LogicalTransaction = {
		id: head.id,
		type: tail.type,
		status: aggregateHopStatus(hops),
		direction: tail.direction,
		timestamp: earliestHopTimestamp(hops, head.timestamp),
		legs: mergeHopLegs(head, tail),
		refs
	};

	if (head.send !== undefined) {
		merged.send = head.send;
	}

	if (tail.receive !== undefined) {
		merged.receive = tail.receive;
	}

	const fee = combineFees(collectHopFees(hops));
	if (fee !== undefined) {
		merged.fee = fee;
	}

	/*
	 * An all-swap chain reports its shared anchor; a chain that ends in a
	 * bridge takes the bridge's counterparty, since the swap hops only fund it.
	 */
	const counterparty = tail.type === 'swap' ? sharedCounterparty(hops) : tail.counterparty;
	if (counterparty !== undefined) {
		merged.counterparty = counterparty;
	}

	return(merged);
}

/**
 * An ordered chain of two or more linked swap hops.
 */
type SwapChain = {
	id: string;
	head: LogicalTransaction;
	tail: LogicalTransaction;
	hops: LogicalTransaction[];
};

/**
 * Group swap transactions into the chains they form through their
 * `refs.inputs` <-> `refs.blockHashes` links. Only chains of two or more hops
 * are returned, keyed by every member's id.
 *
 * Heads and intermediate hops are always swaps; the tail may also be a bridge,
 * which is how a swap that funds an outbound bridge folds into one conversion.
 */
/**
 * The forward/backward links between swaps and the swap or bridge each one
 * funds, established through their `refs.inputs` <-> `refs.blockHashes` edges.
 * Each swap keeps at most one successor (its first match).
 */
type SwapLinks = {
	successorOf: Map<string, LogicalTransaction>;
	predecessorOf: Map<string, LogicalTransaction>;
};

function linkSwapSuccessors(swaps: readonly LogicalTransaction[], successors: readonly LogicalTransaction[]): SwapLinks {
	const successorOf = new Map<string, LogicalTransaction>();
	const predecessorOf = new Map<string, LogicalTransaction>();
	for (const swap of swaps) {
		for (const other of successors) {
			if (other.id === swap.id || successorOf.has(swap.id)) {
				continue;
			}

			if (inputsReference(other, swap)) {
				successorOf.set(swap.id, other);
				predecessorOf.set(other.id, swap);
			}
		}
	}

	return({ successorOf, predecessorOf });
}

/**
 * Walk the successor links from `head` to its tail, returning the hops in
 * order and stopping on a cycle.
 */
function walkChainFrom(head: LogicalTransaction, successorOf: ReadonlyMap<string, LogicalTransaction>): LogicalTransaction[] {
	const hops: LogicalTransaction[] = [ head ];
	const visited = new Set<string>([ head.id ]);
	let current = head;
	while (true) {
		const next = successorOf.get(current.id);
		if (next === undefined || visited.has(next.id)) {
			break;
		}

		hops.push(next);
		visited.add(next.id);
		current = next;
	}

	return(hops);
}

function buildSwapChains(transactions: readonly LogicalTransaction[]): Map<string, SwapChain> {
	const swaps = transactions.filter(transaction => transaction.type === 'swap');
	const successors = transactions.filter(transaction => transaction.type === 'swap' || transaction.type === 'bridge');
	const { successorOf, predecessorOf } = linkSwapSuccessors(swaps, successors);

	const chainByMemberId = new Map<string, SwapChain>();
	for (const swap of swaps) {
		if (predecessorOf.has(swap.id)) {
			continue;
		}

		const hops = walkChainFrom(swap, successorOf);
		const tail = hops.at(-1);
		if (hops.length < 2 || tail === undefined) {
			continue;
		}

		const chain: SwapChain = { id: swap.id, head: swap, tail, hops };
		for (const hop of hops) {
			chainByMemberId.set(hop.id, chain);
		}
	}

	return(chainByMemberId);
}

/**
 * Fold chained swaps into single conversions for display.
 */
export function foldChains(transactions: readonly LogicalTransaction[]): LogicalTransaction[] {
	const chainByMemberId = buildSwapChains(transactions);
	if (chainByMemberId.size === 0) {
		return([ ...transactions ]);
	}

	const emittedChains = new Set<string>();
	const result: LogicalTransaction[] = [];
	for (const transaction of transactions) {
		const chain = chainByMemberId.get(transaction.id);
		if (chain === undefined) {
			result.push(transaction);
			continue;
		}
		if (emittedChains.has(chain.id)) {
			continue;
		}

		emittedChains.add(chain.id);
		result.push(mergeChainHops(chain.head, chain.tail, chain.hops));
	}

	return(result);
}

/**
 * Whether every anchor transfer a logical transaction settles has already been
 * emitted, marking it a duplicate settlement leg.
 */
function isSettledDuplicate(transaction: LogicalTransaction, emitted: ReadonlySet<string>): boolean {
	const ids = transaction.refs.anchorTxIDs;
	if (ids.length === 0) {
		return(false);
	}

	return(ids.every(id => emitted.has(id)));
}

/**
 * Record the anchor transfers a logical transaction settles.
 */
function markEmittedTransfers(transaction: LogicalTransaction, emitted: Set<string>): void {
	for (const id of transaction.refs.anchorTxIDs) {
		emitted.add(id);
	}
}

/**
 * Whether a transaction is a settlement leg already accounted for by an
 * earlier (newest-first) conversion.
 */
function isSettledLeg(transaction: LogicalTransaction, emittedBlocks: ReadonlySet<string>): boolean {
	if (transaction.type !== 'receive') {
		return(false);
	}

	const inputs = transaction.refs.inputs;
	if (inputs === undefined || inputs.length === 0) {
		return(false);
	}

	return(inputs.every(input => emittedBlocks.has(input.blockHash)));
}

/**
 * Record the on-chain blocks a logical transaction (or folded conversion)
 * already accounts for.
 */
function markEmittedBlocks(transaction: LogicalTransaction, emitted: Set<string>): void {
	for (const blockHash of transaction.refs.blockHashes) {
		emitted.add(blockHash);
	}
}

/**
 * Drop logical transactions whose every settled transfer was already emitted by
 * an earlier (newest-first) entry, collapsing a transfer's multiple on-chain
 * legs into the single conversion that represents it.
 */
function suppressSettledDuplicates(transactions: readonly LogicalTransaction[]): LogicalTransaction[] {
	const emitted = new Set<string>();
	const emittedBlocks = new Set<string>();
	const result: LogicalTransaction[] = [];
	for (const transaction of transactions) {
		if (isSettledDuplicate(transaction, emitted) || isSettledLeg(transaction, emittedBlocks)) {
			continue;
		}

		markEmittedTransfers(transaction, emitted);
		markEmittedBlocks(transaction, emittedBlocks);
		result.push(transaction);
	}

	return(result);
}

/**
 * A transfer paired with the anchor account it resolved under.
 */
type ResolvedTransfer = {
	anchorID: string;
	transfer: KeetaAssetMovementTransaction;
};

/**
 * The per-stream state threaded through {@link UserHistory.iterate}: the
 * resolved query, whether the source can fold chains, and the dedupe sets and
 * caches shared across pages.
 */
type IterationContext = {
	perspective: string | undefined;
	options: UserHistoryListOptions | undefined;
	/**
	 * Fold-capable sources resolve each linked predecessor by block hash, so a
	 * chain whose tail is seen first (newest-first paging) is folded on the
	 * spot and its older hops are skipped when they later page in.
	 */
	foldCapable: boolean;
	/**
	 * Hop ids already folded into an emitted conversion.
	 */
	consumed: Set<string>;
	/**
	 * Anchor transfer ids already emitted.
	 */
	emittedTransfers: Set<string>;
	/**
	 * On-chain blocks already represented by an emitted conversion.
	 */
	emittedBlocks: Set<string>;
	externalCache: Map<string, ResolvedTransfer | undefined>;
	readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>;
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
function perspectiveOf(account: HistoryAccount): string | undefined {
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
	 * Fetch, enrich and fold a user's history into logical transactions,
	 * grouping linked multi-hop chains into single conversions.
	 */
	async list(account: HistoryAccount, options?: UserHistoryListOptions): Promise<LogicalTransaction[]> {
		const transactions: LogicalTransaction[] = [];

		/*
		 * When the source can resolve staples by block hash, iterate() already
		 * folds linked chains incrementally and honors `limit` by short-circuit,
		 * so a bounded `limit` no longer walks the whole account.
		 */
		if (typeof this.#history.getVoteStaple === 'function') {
			for await (const transaction of this.iterate(account, options)) {
				transactions.push(transaction);
			}

			return(transactions);
		}

		/*
		 * Fallback for sources without by-hash resolution: drain fully and fold
		 * across the whole set so cross-page chains still group.
		 */
		const { limit, ...collectOptions } = options ?? {};
		for await (const transaction of this.iterate(account, collectOptions)) {
			transactions.push(transaction);
		}

		const folded = suppressSettledDuplicates(foldChains(transactions));
		if (limit !== undefined) {
			return(folded.slice(0, limit));
		}

		return(folded);
	}

	/**
	 * Stream logical transactions newest-first, paging through history one page
	 * at a time instead of buffering the full result set. Walks every page until
	 * history is exhausted, or until {@link UserHistoryListOptions.limit} logical
	 * transactions have been yielded.
	 */
	async *iterate(account: HistoryAccount, options?: UserHistoryListOptions): AsyncGenerator<LogicalTransaction> {
		const resolved = this.#withDefaultDecryptionKeys(account, options);
		const context: IterationContext = {
			perspective: perspectiveOf(account),
			options: resolved,
			foldCapable: typeof this.#history.getVoteStaple === 'function',
			consumed: new Set<string>(),
			emittedTransfers: new Set<string>(),
			emittedBlocks: new Set<string>(),
			externalCache: new Map<string, ResolvedTransfer | undefined>(),
			readerCache: new Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>()
		};

		let cursor = resolved?.cursor;
		let yielded = 0;
		while (true) {
			const page = await this.#fetchPage(account, cursor, resolved);
			if (page.length === 0) {
				return;
			}

			for (const entry of page) {
				for (const transaction of await this.#stapleEmissions(entry.voteStaple, context)) {
					const out = await this.#nextEmission(transaction, context);
					if (out === undefined) {
						continue;
					}

					yield out;
					yielded += 1;

					if (resolved?.limit !== undefined && yielded >= resolved.limit) {
						return;
					}
				}
			}

			const last = page.at(-1);
			if (last === undefined) {
				return;
			}

			cursor = last.voteStaple.blocksHash.toString();
		}
	}

	/**
	 * Classify a staple into the logical transactions to consider, folding
	 * chains up front when the source supports it.
	 */
	async #stapleEmissions(staple: HistoryStaple, context: IterationContext): Promise<LogicalTransaction[]> {
		const logical = await this.#foldStaple(staple, context.perspective, context.options, context.externalCache, context.readerCache);
		return(context.foldCapable ? foldChains(logical) : logical);
	}

	/**
	 * Resolve a candidate to the transaction that should be emitted, or
	 * `undefined` when it is an already-consumed hop or a duplicate settlement
	 * leg. Folds the candidate forward and records what it settles.
	 */
	async #nextEmission(transaction: LogicalTransaction, context: IterationContext): Promise<LogicalTransaction | undefined> {
		if (context.consumed.has(transaction.id)) {
			return(undefined);
		}

		let out = transaction;
		if (context.foldCapable) {
			out = await this.#foldForward(transaction, context.consumed, context.perspective, context.options, context.externalCache, context.readerCache);
		}

		if (isSettledDuplicate(out, context.emittedTransfers) || isSettledLeg(out, context.emittedBlocks)) {
			return(undefined);
		}

		markEmittedTransfers(out, context.emittedTransfers);
		markEmittedBlocks(out, context.emittedBlocks);
		return(out);
	}

	/**
	 * Default {@link UserHistoryListOptions.decryptionKeys} to the queried
	 * account, the recipient of any anchor-delivered slice and so the natural
	 * key for the externals encrypted to it. An explicit `decryptionKeys` (or a
	 * string/null perspective that cannot decrypt) is left untouched.
	 */
	#withDefaultDecryptionKeys(account: HistoryAccount, options?: UserHistoryListOptions): UserHistoryListOptions | undefined {
		if (options?.decryptionKeys !== undefined || account === null || typeof account === 'string') {
			return(options);
		}

		return({ ...options, decryptionKeys: [ account ] });
	}

	/**
	 * Enrich and classify a single vote staple's blocks into logical
	 * transactions, attaching raw sources when requested. Shared by the paging
	 * loop and the by-hash predecessor resolution used to fold chains.
	 */
	async #foldStaple(staple: HistoryStaple, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<LogicalTransaction[]> {
		const timestamp = staple.timestamp().toISOString();
		const blocks: EnrichedBlock[] = [];
		const sources = new Map<string, LogicalTransactionSource>();
		for (const block of staple.blocks) {
			const enriched = await this.#enrichBlock(block, timestamp, perspective, options, externalCache, readerCache);
			blocks.push(enriched);

			if (options?.includeSource === true) {
				sources.set(enriched.blockHash, { staple, enriched });
			}
		}

		const logical = foldHistory(blocks, this.#classifiers);
		attachSources(logical, sources);
		return(logical);
	}

	/**
	 * Fold a swap or bridge that declares on-chain inputs into the full
	 * conversion it caps, resolving every linked predecessor swap by hash and
	 * marking each hop `consumed` so it is skipped when it later pages in.
	 * Returns the input transaction unchanged when it is not the tail of a
	 * linked chain.
	 */
	async #foldForward(transaction: LogicalTransaction, consumed: Set<string>, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<LogicalTransaction> {
		if ((transaction.type !== 'swap' && transaction.type !== 'bridge') || transaction.refs.inputs === undefined || transaction.refs.inputs.length === 0) {
			return(transaction);
		}

		const hops = await this.#resolveSwapChainBackward(transaction, perspective, options, externalCache, readerCache);
		const head = hops.at(0);
		const tail = hops.at(-1);
		if (hops.length < 2 || head === undefined || tail === undefined) {
			return(transaction);
		}

		for (const hop of hops) {
			consumed.add(hop.id);
		}

		const merged = mergeChainHops(head, tail, hops);
		if (options?.includeSource === true && transaction.source !== undefined) {
			merged.source = transaction.source;
		}

		return(merged);
	}

	/**
	 * Walk a swap chain backward from its tail, following each hop's on-chain
	 * input to the predecessor swap it references, until the head (a swap with
	 * no resolvable input) is reached. Returns the hops oldest-first.
	 */
	async #resolveSwapChainBackward(tail: LogicalTransaction, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<LogicalTransaction[]> {
		const hops: LogicalTransaction[] = [ tail ];
		const seenIds = new Set<string>([ tail.id ]);
		const triedHashes = new Set<string>();
		let current = tail;
		while (true) {
			const predecessor = await this.#walkToPredecessor(current, triedHashes, seenIds, perspective, options, externalCache, readerCache);
			if (predecessor === undefined) {
				break;
			}

			hops.unshift(predecessor);
			seenIds.add(predecessor.id);
			current = predecessor;
		}

		return(hops);
	}

	/**
	 * Resolve the first not-yet-tried input of `current` to the predecessor
	 * swap it references, or `undefined` when none resolve to a new swap.
	 */
	async #walkToPredecessor(current: LogicalTransaction, triedHashes: Set<string>, seenIds: Set<string>, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<LogicalTransaction | undefined> {
		for (const input of current.refs.inputs ?? []) {
			if (triedHashes.has(input.blockHash)) {
				continue;
			}

			triedHashes.add(input.blockHash);

			const predecessor = await this.#resolvePredecessorSwap(input.blockHash, perspective, options, externalCache, readerCache);
			if (predecessor !== undefined && !seenIds.has(predecessor.id)) {
				return(predecessor);
			}
		}

		return(undefined);
	}

	/**
	 * Fetch the staple settling `blockHash` and return the swap logical
	 * transaction it contributes to, or `undefined` when it cannot be resolved.
	 */
	async #resolvePredecessorSwap(blockHash: string, perspective: string | undefined, options: UserHistoryListOptions | undefined, externalCache: Map<string, ResolvedTransfer | undefined>, readerCache: Map<string, AnchorTransferReader<KeetaAssetMovementTransaction> | null>): Promise<LogicalTransaction | undefined> {
		const source = this.#history;
		if (typeof source.getVoteStaple !== 'function') {
			return(undefined);
		}

		const staple = await source.getVoteStaple(blockHash);
		if (staple === null || staple === undefined) {
			return(undefined);
		}

		const logical = foldChains(await this.#foldStaple(staple, perspective, options, externalCache, readerCache));
		return(logical.find(transaction => transaction.type === 'swap' && transaction.refs.blockHashes.includes(blockHash)));
	}

	/**
	 * Fetch one page of on-chain history.
	 */
	async #fetchPage(account: HistoryAccount, cursor: string | undefined, options?: UserHistoryListOptions): Promise<HistoryEntry[]> {
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

		const inputs = await decodeExternalInputs(blockExternals(result), options?.decryptionKeys);
		if (inputs.length > 0) {
			result.inputs = inputs;
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
