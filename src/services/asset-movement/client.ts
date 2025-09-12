import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createIs } from 'typia';

import { getDefaultResolver } from '../../config.js';

import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementAnchorInitiateTransferRequest,
	KeetaAssetMovementAnchorInitiateTransferResponse,
	KeetaAssetMovementAnchorGetTransferStatusRequest,
	KeetaAssetMovementAnchorGetTransferStatusResponse,
	AssetPath,
	AssetWithRails,
	Rail,
	AssetLocationString,
	MovableAsset,
	AssetTransferInstructions
} from './common.js';
import { assertMovableAsset,
	convertAssetLocationToString,
	convertAssetSearchInputToCanonical
} from './common.js';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import crypto from '../../lib/utils/crypto.js';
import type { BrandedString } from '../../lib/utils/brand.js';

// const PARANOID = true;

/**
 * The configuration options for the Asset Movement (Inbound/Outbound) Anchor client.
 */
export type KeetaAssetMovementClientConfig = {
	/**
	 * The ID of the client. This is used to identify the client in logs.
	 * If not provided, a random ID will be generated.
	 */
	id?: string;
	/**
	 * The logger to use for logging messages. If not provided, no logging
	 * will be done.
	 */
	logger?: Logger;
	/**
	 * The resolver to use for resolving Asset Movement Anchor services. If not
	 * provided, a default resolver will be created using the provided
	 * client and network (if the network is also not provided and the
	 * client is not a UserClient, an error occurs).
	 */
	resolver?: Resolver;
	/**
	 * The account to use for signing requests. If not provided, the
	 * account associated with the provided client will be used. If there
	 * is no account associated with the client, an error occurs.
	 */
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	/**
	 * Account to perform changes on. If not provided, the account
	 * associated with the provided client will be used. If there is no
	 * account associated with the client, an error occurs.
	 */
	account?: InstanceType<typeof KeetaNetLib.Account>;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = BrandedString<'AssetMovementProviderID'>;

/**
 * An opaque type that represents an Asset Movement Anchor request ID
 */
// type RequestID = BrandedString<'AssetMovementRequestID'>;

const KeetaAssetMovementAnchorClientAccessToken = Symbol('KeetaAssetMovementAnchorClientAccessToken');

function typedAssetMovementServiceEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}

/**
 * A list of operations that can be performed by the Asset Movement Anchor service.
 */
type KeetaAssetMovementAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations']]?: (params?: { [key: string]: string; }) => URL;
};

/**
 * The service information for a KYC Anchor service.
 */
type KeetaAssetMovementServiceInfo = {
	operations: {
		[operation in keyof KeetaAssetMovementAnchorOperations]: Promise<KeetaAssetMovementAnchorOperations[operation]>;
	};

	supportedAssets: {
		asset: MovableAsset;
		paths: AssetPath[];
	}[];

};

/**
 * For each matching KYC Anchor service, this type describes the
 * operations available and the country codes that the service supports.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaAssetMovementServiceInfo;
};

const isKeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
const isKeetaAssetMovementAnchorGetExchangeStatusResponse = createIs<KeetaAssetMovementAnchorGetTransferStatusResponse>();
// const isKeetaAssetPath = createIs<AssetPath>();
const isKeetaAssetWithRails = createIs<AssetWithRails>();
const isKeetaAssetRail = createIs<Rail>();
const isKeetaLocationString = createIs<AssetLocationString>();

function validateURL(url: string | undefined): URL {
	if (url === undefined || url === null) {
		throw(new Error('Invalid URL: null or undefined'));
	}

	const parsedURL = new URL(url);

	return(parsedURL);
}

async function getEndpoints(resolver: Resolver, request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<GetEndpointsResult | null> {
	if (request.allowedRails) {
		throw(new Error('rail not currently supported'));
	}
	const response = await resolver.lookup('assetMovement', {
		asset: convertAssetSearchInputToCanonical(request.asset),
		from: convertAssetLocationToString(request.from.location),
		to: convertAssetLocationToString(request.to.location)
		// rail: request.allowedRails
	});

	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaAssetMovementServiceInfo]> {
		const supportedAssetPromises = (await serviceInfo.supportedAssets?.('array'))?.map(async function(supportedAssetObject): Promise<KeetaAssetMovementServiceInfo['supportedAssets'][number]> {

			const resolvedAssetObject = await supportedAssetObject('object');

			if (!resolvedAssetObject) {
				throw(new Error('Asset object resolved to undefined'));
			}

			const asset = await resolvedAssetObject.asset('string');

			assertMovableAsset(asset);

			const paths: AssetPath[] = await Promise.all((await resolvedAssetObject.paths('array')).map(async function(pathObject) {
				const resolvedPathObject = await pathObject('object');

				if (!resolvedPathObject) {
					throw(new Error('Path object resolved to undefined'));
				}

				const pair = await resolvedPathObject.pair('array');
				if (pair.length !== 2) {
					throw(new Error(`Asset Movement pair should have 2 entries, found: ${pair.length}`));
				}

				const assetPair: Partial<AssetWithRails>[] = await Promise.all(pair.map(async function(assetPath) {
					const path = await assetPath('object');
					const location = await path.location('string');
					if (!isKeetaLocationString(location)) {
						throw(new Error('Location is not a valid location format'));
					}

					const id = await path.id('string');
					const railsValuizable = await path.rails('object');

					const { inbound: inboundFn, outbound: outboundFn, common: commonFn } = railsValuizable;

					if ((inboundFn && outboundFn)) {
						throw(new Error('Cannot define inbound and outbound simultaneously in asset with rails'));
					}
					if ((commonFn && (inboundFn || outboundFn))) {
						throw(new Error('Cannot use inbound or outbound with common in asset with rails'));
					}

					// let rails: { inbound?: Rail[]; outbound?: Rail[], common?: Rail[] } = {};
					// eslint-disable-next-line @typescript-eslint/no-empty-object-type
					let inbound: { rails: { inbound: Rail[] }} | {} = {};
					// eslint-disable-next-line @typescript-eslint/no-empty-object-type
					let outbound: { rails: { inbound: Rail[] }} | {} = {};
					// eslint-disable-next-line @typescript-eslint/no-empty-object-type
					let common: { rails: { inbound: Rail[] }} | {} = {};
					if (inboundFn) {
						const rails = [];
						const inboundList = await inboundFn('array');
						for (const inboundEntry of inboundList) {
							const rail = await inboundEntry('string');
							if (isKeetaAssetRail(rail)) {
								rails.push(rail);
							}
						}
						inbound = { rails: { inbound: rails }};
					} else if (outboundFn) {
						const rails = [];
						const outboundList = await outboundFn('array');
						for (const outboundEntry of outboundList) {
							const rail = await outboundEntry('string');
							if (isKeetaAssetRail(rail)) {
								rails.push(rail);
							}
						}
						outbound = { rails: { outbound: rails }};
					} else if (commonFn) {
						const rails = [];
						const commonList = await commonFn('array');
						for (const commonEntry of commonList) {
							const rail = await commonEntry('string');
							if (isKeetaAssetRail(rail)) {
								rails.push(rail);
							}
						}
						common = { rails: { common: rails }};
					}

					return({
						location,
						id,
						...inbound,
						...outbound,
						...common
					})
				}));

				if (assetPair.length !== 2) {
					throw(new Error(`Asset Movement pair should have 2 entries, found: ${pair.length}`));
				}

				const [ pair0, pair1 ] = assetPair;


				if (!pair0 || !pair1) {
					throw(new Error('Asset pair is undefined'));
				}

				if (!isKeetaAssetWithRails(pair0)) {
					throw(new Error('pair is not a valid asset with rails'));
				}
				if (!isKeetaAssetWithRails(pair1)) {
					throw(new Error('pair is not a valid asset with rails'));
				}

				return({
					pair: [pair0, pair1]
				});
			}));

			return({
				asset,
				paths
			})
		});

		const supportedAssets: KeetaAssetMovementServiceInfo['supportedAssets'] = await Promise.all(supportedAssetPromises);

		const operations = await serviceInfo.operations('object');
		const operationsFunctions: KeetaAssetMovementServiceInfo['operations'] = {};
		for (const [key, operation] of Object.entries(operations)) {
			if (operation === undefined) {
				continue;
			}

			Object.defineProperty(operationsFunctions, key, {
				get: async function() {
					const url = await operation('string');
					return(function(params?: { [key: string]: string; }): URL {
						let substitutedURL = url;
						for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
							substitutedURL = substitutedURL.replace(`{${paramKey}}`, encodeURIComponent(paramValue));
						}

						return(validateURL(substitutedURL));
					});
				},
				enumerable: true,
				configurable: true
			});
		}

		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as unknown as ProviderID,
			{
				operations: operationsFunctions,
				supportedAssets: supportedAssets
			}
		]);
	});

	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises));

	return(retval);
}

interface KeetaAssetMovementAnchorBaseConfig {
	client: KeetaNetUserClient;
	logger?: Logger | undefined;
}

class KeetaAssetMovementAnchorBase {
	protected readonly logger?: Logger | undefined;
	protected readonly client: KeetaNetUserClient;

	constructor(config: KeetaAssetMovementAnchorBaseConfig) {
		this.client = config.client;
		this.logger = config.logger;
	}
}

class KeetaAssetMovementAnchorProvider extends KeetaAssetMovementAnchorBase {
	readonly serviceInfo: KeetaAssetMovementServiceInfo;
	readonly providerID: ProviderID;
	readonly transfer: KeetaAssetMovementAnchorInitiateTransferRequest;
	private readonly parent: KeetaAssetMovementAnchorClient;

	constructor(serviceInfo: KeetaAssetMovementServiceInfo, providerID: ProviderID, transfer: KeetaAssetMovementAnchorInitiateTransferRequest, parent: KeetaAssetMovementAnchorClient) {
		const parentPrivate = parent._internals(KeetaAssetMovementAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.transfer = transfer;
		this.parent = parent;
	}

	async initiateTransfer(): Promise<KeetaAssetMovementAnchorInitiateTransferResponse> {
		this.logger?.debug(`Starting Asset Movement Transfer for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(this.transfer)}`);

		const endpoints = this.serviceInfo.operations;
		const initiateTransfer = await endpoints.initiateTransfer;
		if (initiateTransfer === undefined) {
			throw(new Error('Asset Movement service does not support initiateTransfer operation'));
		}
		const initiateTransferURL = initiateTransfer();
		const requestInformation = await fetch(initiateTransferURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: this.transfer
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaAssetMovementAnchorInitiateTransferResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from asset movement service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`asset movement request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`asset movement request successful, request ID ${requestInformationJSON.id}`);

		return(requestInformationJSON);

	}

	async getTransferStatus(args: KeetaAssetMovementAnchorGetTransferStatusRequest): Promise<KeetaAssetMovementAnchorGetTransferStatusResponse> {
		const endpoints = this.serviceInfo.operations;
		const getTransferStatus = await endpoints.getTransfer;
		if (getTransferStatus === undefined) {
			throw(new Error('Asset Movement service does not support initiateTransfer operation'));
		}
		const getTransferURL = getTransferStatus({ id: args.id });
		const requestInformation = await fetch(getTransferURL, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaAssetMovementAnchorGetExchangeStatusResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from asset movement service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`asset movement request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`asset movement request successful, request ID ${args.id}`);

		return(requestInformationJSON);
	}

}

/**
 * Represents an in-progress Asset Movement request.
 */
class KeetaAssetMovementTransfer {
	private readonly provider: KeetaAssetMovementAnchorProvider;
	private transferID: string | undefined;
	private transferInstructions: AssetTransferInstructions[] | undefined;

	constructor(provider: KeetaAssetMovementAnchorProvider) {
		this.provider = provider;
	}

	async startTransfer(): Promise<KeetaAssetMovementAnchorInitiateTransferResponse> {
		const transfer = await this.provider.initiateTransfer();
		if (transfer.ok) {
			this.transferID = transfer.id;
			this.transferInstructions = transfer.instructions;
		}
		return(transfer);
	}

	async getTransferStatus(): Promise<KeetaAssetMovementAnchorGetTransferStatusResponse> {
		if (this.transferID === undefined) {
			throw(new Error('Transfer not started'));
		}

		return(await this.provider.getTransferStatus({ id: this.transferID }));
	}

	get transferId(): typeof this.transferID {
		return(this.transferID);
	}

	get instructions(): typeof this.transferInstructions {
		return(this.transferInstructions);
	}
}

class KeetaAssetMovementAnchorClient extends KeetaAssetMovementAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;

	constructor(client: KeetaNetUserClient, config: KeetaAssetMovementClientConfig = {}) {
		super({ client, logger: config.logger });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
	}

	async getProvidersForTransfer(request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<KeetaAssetMovementAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			return(null);
		}

		this.logger?.debug('got endpoints', endpoints);

		const providers = typedAssetMovementServiceEntries(endpoints).map(([id, serviceInfo]) => {
			return(new KeetaAssetMovementAnchorProvider(serviceInfo, id, request, this));
		});

		return(providers);
	}

	async startTransfer(provider: KeetaAssetMovementAnchorProvider): Promise<KeetaAssetMovementAnchorInitiateTransferResponse> {
		const assetTransfer = new KeetaAssetMovementTransfer(provider);
		const initTransfer = await assetTransfer.startTransfer();
		return(initTransfer);
	}

	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaAssetMovementAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			resolver: this.resolver,
			logger: this.logger,
			client: this.client
		});
	}
}

export default KeetaAssetMovementAnchorClient;
