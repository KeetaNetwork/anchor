import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import { createIs } from 'typia';

import { getDefaultResolver } from '../../config.js';
import { Certificate as KYCCertificate } from '../../lib/certificates.js';

import type {
	Client as KeetaNetClient,
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementAnchorInitiateTransferRequest,
    KeetaAssetMovementAnchorInitiateTransferResponse,
    KeetaAssetMovementAnchorGetStatusRequest,
    KeetaAssetMovementAnchorGetStatusResponse
} from './common.js';
import {
    AssetLocationString, MovableAsset, MovableAssetSearchCanonical, AssetLocation, AssetMovementRail, toAssetLocationFromString, assertMovableAsset,
    convertAssetLocationToString,
    convertAssetSearchInputToCanonical
} from './common.js';
import type { Logger } from '../../lib/log/index.ts';
import type Resolver from '../../lib/resolver.ts';
import type { ServiceMetadata } from '../../lib/resolver.ts';
import { Buffer } from '../../lib/utils/buffer.js';
import crypto from '../../lib/utils/crypto.js';

const PARANOID = true;

/**
 * The configuration options for the KYC Anchor client.
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
	 * The resolver to use for resolving KYC Anchor services. If not
	 * provided, a default resolver will be created using the provided
	 * client and network (if the network is also not provided and the
	 * client is not a UserClient, an error occurs).
	 */
	resolver?: Resolver;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/**
 * Any kind of X.509v3 Certificate.  This may or may not be a KYC certificate.
 */
type BaseCertificate = InstanceType<typeof KeetaNetLib.Utils.Certificate.Certificate>;

/**
 * The response type for the {@link KeetaKYCAnchorClient['getCertificates']()} method of the KYC Anchor client.
 * It contains the certificate and optionally a set of intermediate certificates.
 */
type KeetaKYCAnchorClientGetCertificateResponse = ({
	ok: true;
	results: {
		certificate: KYCCertificate;
		intermediates?: Set<BaseCertificate> | undefined;
	}[]
} | {
	ok: false;
	retryAfter: number;
	reason: string;
});

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = string & {
	readonly __providerID: unique symbol;
};

/**
 * An opaque type that represents a KYC Anchor request ID
 */
type RequestID = string & {
	readonly __requestID: unique symbol;
};

/**
 * A list of operations that can be performed by the KYC Anchor service.
 */
type KeetaAssetMovementAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations']]?: (params?: { [key: string]: string; }) => URL;
};

/**
 * The service information for a KYC Anchor service.
 */
type KeetaKYCVerificationServiceInfo = {
	operations: {
		[operation in keyof KeetaAssetMovementAnchorOperations]: Promise<KeetaAssetMovementAnchorOperations[operation]>;
	};

    supportedAssets: {
    	asset: MovableAsset;

    	paths: {
    		from: AssetLocation;
    		to: AssetLocation;
    		rails?: AssetMovementRail[];
    	}[]
    }[];
};

/**
 * For each matching KYC Anchor service, this type describes the
 * operations available and the country codes that the service supports.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaKYCVerificationServiceInfo;
};

const isKeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
const isKeetaAssetMovementAnchorGetStatusResponse = createIs<KeetaAssetMovementAnchorGetStatusResponse>();

function validateURL(url: string | undefined): URL {
	if (url === undefined || url === null) {
		throw(new Error('Invalid URL: null or undefined'));
	}

	const parsedURL = new URL(url);

	return(parsedURL);
}

async function getEndpoints(resolver: Resolver, request: KeetaAssetMovementAnchorInitiateTransferRequest): Promise<GetEndpointsResult | null> {
    if (request.allowedRails) {
        throw new Error('rail not currently supported');
    }
	const response = await resolver.lookup('assetMovement', {
        asset: convertAssetSearchInputToCanonical(request.asset),
        from: convertAssetLocationToString(request.from.location),
        to: convertAssetLocationToString(request.to.location),
		// rail: request.allowedRails
	});

	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaKYCVerificationServiceInfo]> {
		const supportedAssetPromises = (await serviceInfo.supportedAssets?.('array'))?.map(async function(supportedAssetObject): Promise<KeetaKYCVerificationServiceInfo['supportedAssets'][number]> {
			
            const resolvedAssetObject = await supportedAssetObject('object');

            if (!resolvedAssetObject) {
                throw new Error('Asset object resolved to undefined');
            }

            const asset = await resolvedAssetObject.asset('string');

            assertMovableAsset(asset);

            const paths = await Promise.all((await resolvedAssetObject.paths('array')).map(async function(pathObject) {
                const resolvedPathObject = await pathObject('object');

                if (!resolvedPathObject) {
                    throw new Error('Path object resolved to undefined')
                }

                if (resolvedPathObject.rails) {
                    throw new Error('rails not supported');
                }

                const [ to, from ] = await Promise.all(([ 'to', 'from' ] as const).map(async function(key) {
                    const resolvedValue = await resolvedPathObject[key]('string');

                    return(toAssetLocationFromString(resolvedValue));
                }));

                if (!to || !from) {
                    throw new Error('Could not get to or from from asset metadata');
                }

                return({
                    to, from
                })
            }));

            return({
                asset,
                paths
            })
		});

		const supportedAssets: KeetaKYCVerificationServiceInfo['supportedAssets'] = await Promise.all(supportedAssetPromises);

		const operations = await serviceInfo.operations('object');
		const operationsFunctions: KeetaKYCVerificationServiceInfo['operations'] = {};
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
			id as ProviderID,
			{
				supportedAssets: supportedAssets,
				operations: operationsFunctions
			}
		]);
	});

	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises));

	return(retval);
}

type KeetaAssetMovementAnchorCommonConfig = {
	id: ProviderID;
	serviceInfo: KeetaKYCVerificationServiceInfo;
	request: KeetaAssetMovementAnchorInitiateTransferRequest;
	client: KeetaAssetMovementAnchorClient;
	operations: NonNullable<Pick<KeetaAssetMovementAnchorOperations, 'initiateTransfer' | 'getTransfer'>>;
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
		this.id = response.id as RequestID;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.logger = args.logger;
		this.response = response;

		this.logger?.debug(`Created KYC verification for provider ID: ${this.providerID}, request: ${JSON.stringify(args.request)}, response: ${JSON.stringify(response)}`);
	}

	static async start(args: KeetaAssetMovementAnchorCommonConfig): Promise<KeetaAssetMovementTransfer> {
		args.logger?.debug(`Starting KYC verification for provider ID: ${args.id}, request: ${JSON.stringify(args.request)}`);

		const endpoints = args.operations;
		const createVerification = endpoints.initiateTransfer?.();
		if (createVerification === undefined) {
			throw(new Error('KYC verification service does not support createVerification operation'));
		}

		const requestInformation = await fetch(createVerification, {
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
	private readonly serviceInfo: KeetaKYCVerificationServiceInfo;
	private readonly request: KeetaAssetMovementAnchorInitiateTransferRequest;
	private readonly logger?: Logger | undefined;
	private readonly client: KeetaAssetMovementAnchorClient;
	private readonly operations: NonNullable<Pick<KeetaAssetMovementAnchorOperations, 'getTransfer' | 'initiateTransfer'>>;

	constructor(args: KeetaAssetMovementAnchorCommonConfig) {
		this.id = args.id;
		this.serviceInfo = args.serviceInfo;
		this.request = args.request;
		this.client = args.client;
		this.operations = args.operations;
		this.logger = args.logger;

		this.logger?.debug(`Created KYC verification for provider ID: ${args.id}`);
        // XXX:TODO handle bigints here
		// this.logger?.debug(`Created KYC verification for provider ID: ${args.id}, request: ${JSON.stringify(args.request)}`);
	}

	get supportedAssets(): KeetaKYCVerificationServiceInfo['supportedAssets'] {
		return(this.serviceInfo.supportedAssets);
	}

	async startVerification(): Promise<KeetaAssetMovementTransfer> {
		return(await KeetaAssetMovementTransfer.start({
			id: this.id,
			serviceInfo: this.serviceInfo,
			request: this.request,
			client: this.client,
			operations: this.operations,
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

		const validEndpoints = await Promise.allSettled(Object.entries(endpoints).map(async ([id, serviceInfo]) => {
			const endpoints = serviceInfo.operations;
			/*
			 * Verify that we have the required operations
			 * available to perform a KYC verification.
			 */
			const initiateTransfer = await endpoints.initiateTransfer;
			const getTransfer = await endpoints.getTransfer;
			if (getTransfer === undefined || initiateTransfer === undefined) {
				this.logger?.warn(`Asset movement provider ${id} does not support required operations (initiateTransfer, getTransfer)`);
				return(null);
			}

			/*
			 * We can safely cast the ID to a ProviderID because it's a branded type
			 * for this specific type
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const providerID = id as ProviderID;
			return(new KeetaAssetMovementProvider({
				id: providerID,
				serviceInfo: serviceInfo,
				request: request,
				client: this,
				logger: this.logger,
				operations: {
					initiateTransfer,
					getTransfer
				}
			}));
		}));

		/*
		 * Filter out any endpoints that were not able to be resolved
		 * or that did not have the required operations.
		 */
		const retval = validEndpoints.map(function(result) {
			if (result.status !== 'fulfilled') {
                console.log('throwing rerrrr');
                throw(result.reason)
				return(null);
			}
			if (result.value === null) {
				return(null);
			}
			return(result.value);
		}).filter(function(result) {
			return(result !== null);
		});

		if (retval.length === 0) {
			throw(new Error('No valid Asset movement endpoints found'));
		}

		return(retval);
	}

	async getTransferStatus(providerID: ProviderID, request: KeetaAssetMovementAnchorGetStatusRequest & { id: RequestID; }): Promise<KeetaAssetMovementAnchorGetStatusResponse> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			throw(new Error('No KYC endpoints found for the given criteria'));
		}
		const providerEndpoints = endpoints[providerID];
		if (providerEndpoints === undefined) {
			throw(new Error(`No KYC endpoints found for provider ID: ${providerID}`));
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
