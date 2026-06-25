import * as KeetaNet from '@keetanetwork/keetanet-client';

import type { AnchorExternalInput } from '../../anchor-external.js';
import type { PublishedInputRecord } from '../store.js';
import type { AssetMovementProvider } from '../types.js';
import { AnchorExternalBuilder } from '../../anchor-external.js';

/**
 * Project persisted published-input records into the anchor-external input
 * shape, preserving the optional operation index.
 */
export function toExternalInputs(records: readonly PublishedInputRecord[]): AnchorExternalInput[] {
	return(records.map(function(record) {
		if (record.operationIndex !== undefined) {
			return({ blockHash: record.blockHash, operationIndex: record.operationIndex });
		}

		return({ blockHash: record.blockHash });
	}));
}

/**
 * Construct the unsigned anchor-correlation external envelope for a
 * user-funded KEETA_SEND, linking the prior steps' published operations to the
 * anchor's transfer. Returns `undefined` when the provider exposes no anchor
 * account to correlate against.
 */
export async function buildKeetaSendExternal(
	provider: AssetMovementProvider,
	transactionID: string,
	inputs: readonly PublishedInputRecord[]
): Promise<string | undefined> {
	const anchorKey = provider.serviceInfo.account;
	if (anchorKey === undefined) {
		return(undefined);
	}

	const anchor = KeetaNet.lib.Account.fromPublicKeyString(anchorKey);
	const builder = new AnchorExternalBuilder().setAnchor(anchor, { transactionId: transactionID });

	for (const input of inputs) {
		builder.addInput(input.blockHash, input.operationIndex);
	}

	return(await builder.build());
}
