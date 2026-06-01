import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { AccountPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

import { AnchorExternal } from './anchor-external.js';
import type { AnchorExternalDecodeOptions, AnchorExternalEntry } from './anchor-external.js';
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
	transactionId: string;
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
export type AnchorExternalTransactionStatusOptions = AnchorExternalDecodeOptions & AnchorGetTransactionStatusOptions;

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
		 * Slice carries no transaction id (opaque, persistent-forwarding,
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
 * Reads the status of a single transaction at one resolved anchor.
 */
export interface AnchorTransferReader<Transaction = unknown> {
	/**
	 * Read the standardized status of one transaction at this anchor.
	 */
	getTransferStatus(transactionId: string, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<Transaction>>;
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
 * `true` once a transfer has settled.
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
	async getStatus(anchor: AnchorReference, transactionId: string, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<Transaction> | null> {
		const reader = await this.#source.getReader(anchor);
		if (reader === null) {
			return(null);
		}

		const status = await reader.getTransferStatus(transactionId, options);
		return(status);
	}

	/**
	 * Read the standardized status of every anchor referenced by an encoded
	 * external field.
	 */
	async getStatusesFromExternal(external: string, options?: AnchorExternalTransactionStatusOptions): Promise<{ [anchorId: string]: AnchorTransactionStatusResult<Transaction> }> {
		const decodeOptions: AnchorExternalDecodeOptions = {};
		if (options?.decryptionKeys !== undefined) {
			decodeOptions.decryptionKeys = options.decryptionKeys;
		}

		const statusOptions: AnchorGetTransactionStatusOptions = {};
		if (options?.requesterAccount !== undefined) {
			statusOptions.requesterAccount = options.requesterAccount;
		}

		const decoded = await AnchorExternal.fromExternal(external, decodeOptions);
		const entries = Object.entries(decoded.envelope.anchors);

		const settled = await Promise.all(entries.map(async ([anchorId, slice]): Promise<[string, AnchorTransactionStatusResult<Transaction>]> => {
			const result = await this.#readSliceStatus(anchorId, slice.entry, statusOptions);
			return([anchorId, result]);
		}));

		const results: { [anchorId: string]: AnchorTransactionStatusResult<Transaction> } = {};
		for (const [anchorId, result] of settled) {
			results[anchorId] = result;
		}

		return(results);
	}

	/**
	 * Resolve a single decoded slice to its per-anchor outcome.
	 */
	async #readSliceStatus(anchorId: string, entry: AnchorExternalEntry | undefined, options: AnchorGetTransactionStatusOptions): Promise<AnchorTransactionStatusResult<Transaction>> {
		if (entry === undefined || !('transactionId' in entry)) {
			return({ kind: 'unavailable' });
		}

		const anchor = KeetaNetLib.Account.fromPublicKeyString(anchorId);

		let status: StandardizedTransferStatus<Transaction> | null;
		try {
			status = await this.getStatus(anchor, entry.transactionId, options);
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
