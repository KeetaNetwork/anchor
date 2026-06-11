import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { AccountPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

import { AnchorExternal } from './anchor-external.js';
import type { AnchorExternalEntry } from './anchor-external.js';
import type { KeetaNetAccount } from './asset.js';
import type { VerifiableAccount } from './utils/signing.js';

/**
 * An anchor reference accepted when resolving a provider.
 */
export type AnchorReference = AccountPublicKeyString | VerifiableAccount;

/**
 * Provider-independent, standardized view of an anchor transfer's status.
 */
export type StandardizedTransferStatus<Transaction = unknown> = {
	/**
	 * Provider wire lifecycle state. Only `COMPLETE` is standardized.
	 */
	status: string;
	/**
	 * Anchor-scoped transaction id the status was read for.
	 */
	transactionID: string;
	/**
	 * Full source transaction record backing the status.
	 */
	transaction: Transaction;
};

/**
 * Per-call options for {@link AnchorTransactionStatus.getStatus}.
 */
export type AnchorGetTransactionStatusOptions = {
	/**
	 * Account to authenticate the status request with, for anchors that
	 * require (or scope) authentication on status reads.
	 */
	requesterAccount?: KeetaNetAccount;
};

/**
 * Per-call options for {@link AnchorTransactionStatus.getStatusesFromExternal}.
 */
export type AnchorExternalTransactionStatusOptions = AnchorGetTransactionStatusOptions & {
	/**
	 * Accounts whose keys may decrypt an encrypted envelope.
	 */
	decryptionKeys?: VerifiableAccount[];
};

/**
 * Per-anchor outcome from {@link AnchorTransactionStatus.getStatusesFromExternal}.
 */
export type AnchorTransactionStatusResult<Transaction = unknown> =
	| {
		/**
		 * A status was read for the anchor.
		 */
		kind: 'status';
		status: StandardizedTransferStatus<Transaction>;
	}
	| {
		/**
		 * Entry carries no transaction id (opaque, persistent-forwarding,
		 * or destination), so no transfer status applies.
		 */
		kind: 'unavailable';
	}
	| {
		/**
		 * The anchor's provider could not be resolved.
		 */
		kind: 'unresolved';
	}
	| {
		/**
		 * Reading the status failed; the captured error is provided.
		 */
		kind: 'error';
		error: unknown;
	};

/**
 * On-chain coordinates of a Keeta operation, used to reverse-lookup the
 * anchor transfer it belongs to when the operation carries no decodable
 * transaction id (e.g. a deposit mint observed as a RECEIVE).
 */
export type AnchorOnChainReference = {
	/**
	 * Network id of the Keeta chain the operation was observed on.
	 */
	keetaNetworkID: bigint;
	/**
	 * Hash of the block carrying the operation.
	 */
	blockHash: string;
	/**
	 * Index of the operation within its block.
	 */
	operationIndex: number;
};

/**
 * Reads the status of a single transaction at one resolved anchor.
 */
export interface AnchorTransferReader<Transaction = unknown> {
	/**
	 * Read the standardized status of one transaction at this anchor.
	 */
	getTransferStatus(transactionID: string, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<Transaction>>;
	/**
	 * Reverse-lookup the transfer an on-chain operation belongs to, for
	 * operations that carry no transaction id of their own.
	 */
	findByOnChain?(reference: AnchorOnChainReference, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<Transaction> | null>;
}

/**
 * Resolves an anchor account to a transfer-status reader.
 */
export interface AnchorStatusSource<Transaction = unknown> {
	/**
	 * Resolve the reader for an anchor account, or `null` if no provider
	 * serves it.
	 */
	getReader(anchor: AnchorReference): Promise<AnchorTransferReader<Transaction> | null>;
}

/**
 * Is `true` once a transfer has settled.
 *
 * Other states are provider-specific and cannot be classified here.
 */
export function isCompletedTransferStatus(status: string): boolean {
	return(status === 'COMPLETE');
}

/**
 * Reads anchor transfer status through a single, provider-independent
 * surface backed by an injected {@link AnchorStatusSource}.
 */
export class AnchorTransactionStatus<Transaction = unknown> {
	readonly #source: AnchorStatusSource<Transaction>;

	constructor(source: AnchorStatusSource<Transaction>) {
		this.#source = source;
	}

	/**
	 * Resolve the transfer-status reader an anchor account is filed under.
	 *
	 * @returns The reader, or `null` if none resolves for the anchor.
	 */
	async getReader(anchor: AnchorReference): Promise<AnchorTransferReader<Transaction> | null> {
		const reader = await this.#source.getReader(anchor);
		return(reader);
	}

	/**
	 * Read the standardized status of a single anchor transaction.
	 *
	 * @returns The standardized status, or `null` if the anchor's provider
	 *          could not be resolved.
	 */
	async getStatus(anchor: AnchorReference, transactionID: string, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<Transaction> | null> {
		const reader = await this.getReader(anchor);
		if (reader === null) {
			return(null);
		}

		const status = await reader.getTransferStatus(transactionID, options);
		return(status);
	}

	/**
	 * Read the standardized status of every anchor referenced by an encoded
	 * external field.
	 */
	async getStatusesFromExternal(external: string, options?: AnchorExternalTransactionStatusOptions): Promise<{ [anchorID: string]: AnchorTransactionStatusResult<Transaction> }> {
		const statusOptions: AnchorGetTransactionStatusOptions = {};
		if (options?.requesterAccount !== undefined) {
			statusOptions.requesterAccount = options.requesterAccount;
		}

		const peeked = await AnchorExternal.peek(external);

		let decoded: AnchorExternal;
		if (peeked.encrypted) {
			decoded = await AnchorExternal.fromEncryptedExternal(external, options?.decryptionKeys ?? []);
		} else {
			decoded = await AnchorExternal.fromPlainExternal(external);
		}

		const entries = Object.entries(decoded.envelope.anchors);

		const settled = await Promise.all(entries.map(async ([anchorID, entry]): Promise<[string, AnchorTransactionStatusResult<Transaction>]> => {
			const result = await this.#readEntryStatus(anchorID, entry, statusOptions);
			return([anchorID, result]);
		}));

		const results = Object.fromEntries(settled);
		return(results);
	}

	/**
	 * Resolve a single decoded per-anchor entry to its outcome.
	 */
	async #readEntryStatus(anchorID: string, entry: AnchorExternalEntry, options: AnchorGetTransactionStatusOptions): Promise<AnchorTransactionStatusResult<Transaction>> {
		if (!('transactionID' in entry)) {
			return({ kind: 'unavailable' });
		}

		let status: StandardizedTransferStatus<Transaction> | null;
		try {
			const anchor = KeetaNetLib.Account.fromPublicKeyString(anchorID);
			status = await this.getStatus(anchor, entry.transactionID, options);
		} catch (error) {
			return({ kind: 'error', error: error });
		}

		if (status === null) {
			return({ kind: 'unresolved' });
		}

		return({ kind: 'status', status: status });
	}
}

export default AnchorTransactionStatus;
