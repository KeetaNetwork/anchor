import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createIs } from 'typia';

import { getDefaultResolver } from '../../config.js';

import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementAnchorInitiateTransferRequest,
	KeetaAssetMovementAnchorInitiateTransferResponse,
	KeetaAssetMovementAnchorGetStatusRequest,
	KeetaAssetMovementAnchorGetStatusResponse,
	AssetPath,
	AssetWithRails,
	Rail
	,
	AssetLocationString, MovableAsset } from './common.js';
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
type RequestID = BrandedString<'AssetMovementRequestID'>;

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
const isKeetaAssetMovementAnchorGetStatusResponse = createIs<KeetaAssetMovementAnchorGetStatusResponse>();
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

type KeetaAssetMovementAnchorCommonConfig = {
	id: ProviderID;
	serviceInfo: KeetaAssetMovementServiceInfo;
	request: KeetaAssetMovementAnchorInitiateTransferRequest;
	client: KeetaAssetMovementAnchorClient;
	logger?: Logger | undefined;
};

/**
 * Represents an in-progress Asset Movement request.
 */
class KeetaAssetMovementTransfer {
	readonly providerID: KeetaAssetMovementAnchorCommonConfig['id'];
	readonly id: RequestID;
	private readonly serviceInfo: KeetaAssetMovementAnchorCommonConfig['serviceInfo'];
	private readonly request: KeetaAssetMovementAnchorCommonConfig['request'];
	private readonly logger?: KeetaAssetMovementAnchorCommonConfig['logger'] | undefined;
	private readonly client: KeetaAssetMovementAnchorCommonConfig['client'];
	private readonly response: Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>;

	private constructor(args: KeetaAssetMovementAnchorCommonConfig, response: Extract<KeetaAssetMovementAnchorInitiateTransferResponse, { ok: true }>) {
		this.providerID = args.id;
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		this.id = response.id as unknown as RequestID;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.logger = args.logger;
		this.response = response;

		this.logger?.debug(`Created KYC verification for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(args.request)}, response: ${JSON.stringify(response)}`);
	}

	static async start(args: KeetaAssetMovementAnchorCommonConfig): Promise<KeetaAssetMovementTransfer> {
		args.logger?.debug(`Starting KYC verification for provider ID: ${String(args.id)}, request: ${JSON.stringify(args.request)}`);

		const endpoints = args.serviceInfo.operations;
		const createVerification = await endpoints.initiateTransfer;
		if (createVerification === undefined) {
			throw(new Error('KYC verification service does not support createVerification operation'));
		}
		const createVerificationURL = createVerification();
		const requestInformation = await fetch(createVerificationURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				request: args.request
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaAssetMovementAnchorInitiateTransferResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from asset movement service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`asset movement request failed: ${requestInformationJSON.error}`));
		}

		args.logger?.debug(`asset movement request successful, request ID ${requestInformationJSON.id}`);

		return(new this(args, requestInformationJSON));

	}

	get transferId(): typeof this.response.id {
		return(this.response.id);
	}

	get instructions(): typeof this.response.instructions {
		return(this.response.instructions);
	}
}

/**
 * Represents the KYC operations for a specific provider
 */
class KeetaAssetMovementProvider {
	readonly id: ProviderID;
	private readonly serviceInfo: KeetaAssetMovementServiceInfo;
	private readonly request: KeetaAssetMovementAnchorInitiateTransferRequest;
	private readonly logger?: Logger | undefined;
	private readonly client: KeetaAssetMovementAnchorClient;

	constructor(args: KeetaAssetMovementAnchorCommonConfig) {
		this.id = args.id;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.logger = args.logger;

		this.logger?.debug(`Created KYC verification for provider ID: ${String(args.id)}`);
		// XXX:TODO handle bigints here
		// this.logger?.debug(`Created KYC verification for provider ID: ${args.id}, request: ${JSON.stringify(args.request)}`);
	}

	get supportedAssets(): KeetaAssetMovementServiceInfo['supportedAssets'] {
		return(this.serviceInfo.supportedAssets);
	}

	async startVerification(): Promise<KeetaAssetMovementTransfer> {
		return(await KeetaAssetMovementTransfer.start({
			id: this.id,
			serviceInfo: this.serviceInfo,
			request: this.request,
			client: this.client,
			logger: this.logger
		}));
	}
}

class KeetaAssetMovementAnchorClient {
	readonly resolver: Resolver;
	readonly id: string;
	private readonly logger?: Logger | undefined;

	constructor(client: KeetaNetClient | KeetaNetUserClient, config: KeetaAssetMovementClientConfig = {}) {
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
		this.logger = config.logger;
	}

	async initiateTransfer(request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<KeetaAssetMovementProvider[]> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			throw(new Error('No Asset movement endpoints found for the given criteria'));
		}

		console.log('got endpoints', endpoints);

		const validEndpoints = typedAssetMovementServiceEntries(endpoints).map(([id, serviceInfo]) => {
			return(new KeetaAssetMovementProvider({
				id,
				serviceInfo: serviceInfo,
				request: request,
				client: this,
				logger: this.logger
			}));
		});

		return(validEndpoints);
	}

	async getTransferStatus(providerID: ProviderID, request: KeetaAssetMovementAnchorGetStatusRequest & { id: RequestID; }): Promise<KeetaAssetMovementAnchorGetStatusResponse> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			throw(new Error('No KYC endpoints found for the given criteria'));
		}
		const providerEndpoints = endpoints[providerID];
		if (providerEndpoints === undefined) {
			throw(new Error(`No KYC endpoints found for provider ID: ${String(providerID)}`));
		}

		const requestID = request.id;
		const operations = providerEndpoints.operations;
		const getCertificate = (await operations.getTransfer)?.({ id: requestID });
		if (getCertificate === undefined) {
			throw(new Error('internal error: KYC verification service does not support getCertificate operation'));
		}

		const response = await fetch(getCertificate, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		/*
		 * Handle retryable errors by passing them up to the caller to
		 * retry.
		 */
		if (response.status === 404) {
			return({
				ok: false,
				error: 'Transfer not found'
			});
		}

		/*
		 * Handle other errors as fatal errors that should not be retried.
		 */
		if (!response.ok) {
			throw(new Error(`Failed to get certificate: ${response.statusText}`));
		}

		const responseJSON: unknown = await response.json();
		if (!isKeetaAssetMovementAnchorGetStatusResponse(responseJSON)) {
			throw(new Error(`Invalid response from KYC certificate service: ${JSON.stringify(responseJSON)}`));
		}

		if (!responseJSON.ok) {
			throw(new Error(`KYC certificate request failed: ${responseJSON.error}`));
		}

		return(responseJSON);
	}
}

export default KeetaAssetMovementAnchorClient;
