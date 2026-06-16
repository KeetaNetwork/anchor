import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';

import type {
	AnchorOnChainReference,
	AnchorReference,
	AnchorStatusSource,
	AnchorTransferReader,
	StandardizedTransferStatus
} from '../../lib/anchor-status.js';
import type { Logger } from '../../lib/log/index.js';
import type { AssetLocationString, KeetaAssetMovementTransaction } from '../asset-movement/common.js';
import type { KeetaFXAnchorConversionSummary, KeetaFXAnchorExchange } from './common.js';
import type { KeetaFXAnchorProviderBase } from './client.js';
import type Resolver from '../../lib/resolver.js';
import KeetaFXAnchorClient from './client.js';

/**
 * Construction inputs for {@link KeetaFXStatusSource}.
 */
export type KeetaFXStatusSourceConfig = {
	/**
	 * Client used to issue the underlying anchor requests.
	 */
	client: KeetaNetUserClient;
	/**
	 * Resolver used to materialize anchor service metadata.
	 */
	resolver: Resolver;
	/**
	 * Optional logger forwarded to the underlying client.
	 */
	logger?: Logger;
};

/**
 * Status reported by the FX anchor for a completed swap, mapped onto the
 * standardized `COMPLETE` so {@link isCompletedTransferStatus} treats it as
 * settled.
 */
const FX_COMPLETE_STATUS = 'COMPLETE';

/**
 * Adapt a completed FX exchange's conversion summary into the
 * provider-independent {@link KeetaAssetMovementTransaction} shape, expressed
 * as a keeta -> keeta movement so history classifies it as a swap.
 */
function exchangeToTransaction(exchangeID: string, conversion: KeetaFXAnchorConversionSummary, keetaNetworkID: bigint): KeetaAssetMovementTransaction {
	const location: AssetLocationString = `chain:keeta:${keetaNetworkID}`;

	const transaction: KeetaAssetMovementTransaction = {
		id: exchangeID,
		status: FX_COMPLETE_STATUS,
		asset: { from: conversion.from.token, to: conversion.to.token },
		from: {
			location,
			value: conversion.from.amount,
			transactions: { persistentForwarding: null, deposit: null, finalization: null }
		},
		to: {
			location,
			value: conversion.to.amount,
			transactions: { withdraw: null }
		},
		fee: null,
		createdAt: '',
		updatedAt: ''
	};

	if (conversion.cost !== undefined) {
		transaction.fee = { asset: conversion.cost.token, value: conversion.cost.amount };
	}

	return(transaction);
}

/**
 * Map an FX exchange to the standardized status, or `null` when it carries no
 * conversion summary to adapt (an older anchor), so callers degrade to
 * block-shape classification.
 */
function exchangeToStandardized(exchange: KeetaFXAnchorExchange, keetaNetworkID: bigint): StandardizedTransferStatus<KeetaAssetMovementTransaction> | null {
	if (exchange.status !== 'completed') {
		return(null);
	}

	if (exchange.conversion === undefined) {
		return(null);
	}

	const transaction = exchangeToTransaction(exchange.exchangeID, exchange.conversion, keetaNetworkID);

	return({
		status: transaction.status,
		transactionID: transaction.id,
		transaction
	});
}

/**
 * Reads FX exchange status from a single resolved FX provider and adapts it to
 * the provider-independent {@link StandardizedTransferStatus}.
 */
class KeetaFXTransferReader implements AnchorTransferReader<KeetaAssetMovementTransaction> {
	readonly #provider: KeetaFXAnchorProviderBase;

	constructor(provider: KeetaFXAnchorProviderBase) {
		this.#provider = provider;
	}

	async getTransferStatus(transactionID: string): Promise<StandardizedTransferStatus<KeetaAssetMovementTransaction>> {
		const exchange = await this.#provider.getExchangeStatus(transactionID);
		const standardized = exchangeToStandardized(exchange, 0n);
		if (standardized === null) {
			throw(new Error(`FX exchange ${transactionID} has no adaptable conversion summary`));
		}

		return(standardized);
	}

	async findByOnChain(reference: AnchorOnChainReference): Promise<StandardizedTransferStatus<KeetaAssetMovementTransaction> | null> {
		const exchange = await this.#provider.getExchangeByBlockhash(reference.blockHash);
		const standardized = exchangeToStandardized(exchange, reference.keetaNetworkID);
		return(standardized);
	}
}

/**
 * FX implementation of the lib-owned {@link AnchorStatusSource} port. Resolves
 * a swap's FX provider by the liquidity provider account on its block and
 * adapts the exchange into a keeta -> keeta transaction.
 */
export class KeetaFXStatusSource implements AnchorStatusSource<KeetaAssetMovementTransaction> {
	readonly #client: KeetaFXAnchorClient;

	constructor(config: KeetaFXStatusSourceConfig) {
		const clientConfig: { resolver: Resolver; logger?: Logger } = { resolver: config.resolver };
		if (config.logger !== undefined) {
			clientConfig.logger = config.logger;
		}

		this.#client = new KeetaFXAnchorClient(config.client, clientConfig);
	}

	async getReader(anchor: AnchorReference): Promise<AnchorTransferReader<KeetaAssetMovementTransaction> | null> {
		const provider = await this.#client.getProviderByAccount(anchor, [ 'getExchangeByBlockhash' ]);
		if (provider === null) {
			return(null);
		}

		const reader = new KeetaFXTransferReader(provider);
		return(reader);
	}
}

export default KeetaFXStatusSource;
