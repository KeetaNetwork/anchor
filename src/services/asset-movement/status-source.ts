import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';

import type Resolver from '../../lib/resolver.js';
import type { Logger } from '../../lib/log/index.js';
import type { KeetaAssetMovementAnchorProvider } from './client.js';
import type {
	KeetaAssetMovementAnchorGetTransferStatusClientRequest,
	KeetaAssetMovementTransaction
} from './common.js';
import type {
	AnchorReference,
	AnchorStatusSource,
	AnchorTransferReader,
	AnchorGetTransactionStatusOptions,
	StandardizedTransferStatus
} from '../../lib/anchor-status.js';
import KeetaAssetMovementAnchorClient from './client.js';

/**
 * Construction inputs for {@link KeetaAssetMovementStatusSource}.
 */
export type KeetaAssetMovementStatusSourceConfig = {
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
 * Reads transfer status from a single resolved asset-movement provider and
 * maps it onto the provider-independent {@link StandardizedTransferStatus}.
 */
class KeetaAssetMovementTransferReader implements AnchorTransferReader<KeetaAssetMovementTransaction> {
	readonly #provider: KeetaAssetMovementAnchorProvider;

	constructor(provider: KeetaAssetMovementAnchorProvider) {
		this.#provider = provider;
	}

	async getTransferStatus(transactionId: string, options?: AnchorGetTransactionStatusOptions): Promise<StandardizedTransferStatus<KeetaAssetMovementTransaction>> {
		const request: KeetaAssetMovementAnchorGetTransferStatusClientRequest = { id: transactionId };
		if (options?.requesterAccount !== undefined) {
			request.account = options.requesterAccount;
		}

		const response = await this.#provider.getTransferStatus(request);
		const result: StandardizedTransferStatus<KeetaAssetMovementTransaction> = {
			status: response.transaction.status,
			transactionId: response.transaction.id,
			transaction: response.transaction
		};
		return(result);
	}
}

/**
 * Asset-movement implementation of the lib-owned {@link AnchorStatusSource} port.
 */
export class KeetaAssetMovementStatusSource implements AnchorStatusSource<KeetaAssetMovementTransaction> {
	readonly #client: KeetaAssetMovementAnchorClient;

	constructor(config: KeetaAssetMovementStatusSourceConfig) {
		const clientConfig: { resolver: Resolver; logger?: Logger } = { resolver: config.resolver };
		if (config.logger !== undefined) {
			clientConfig.logger = config.logger;
		}

		this.#client = new KeetaAssetMovementAnchorClient(config.client, clientConfig);
	}

	async getReader(anchor: AnchorReference): Promise<AnchorTransferReader<KeetaAssetMovementTransaction> | null> {
		const provider = await this.#client.getProviderByAccount(anchor);
		if (provider === null) {
			return(null);
		}

		const reader = new KeetaAssetMovementTransferReader(provider);
		return(reader);
	}
}

export default KeetaAssetMovementStatusSource;
