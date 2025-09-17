import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createAssert, createIs } from 'typia';

import { getDefaultResolver } from '../../config.js';

import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementAnchorInitiateTransferRequest,
	KeetaAssetMovementAnchorInitiateTransferResponse,
	KeetaAssetMovementAnchorGetTransferStatusRequest,
	KeetaAssetMovementAnchorGetTransferStatusResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	MovableAsset,
	AssetTransferInstructions,
	SupportedAssets
} from './common.js';
import {
	convertAssetLocationToString,
	convertAssetSearchInputToCanonical
} from './common.js';
import type { Logger } from '../../lib/log/index.ts';
import Resolver from "../../lib/resolver.js";
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

	supportedAssets: SupportedAssets[];
};

/**
 * For each matching KYC Anchor service, this type describes the
 * operations available and the country codes that the service supports.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaAssetMovementServiceInfo;
};

// const isKeetaAssetPath = createIs<AssetPath>();
const asserKeetaSupportedAssets = createAssert<SupportedAssets[]>();

function validateURL(url: string | undefined): URL {
	if (url === undefined || url === null) {
		throw(new Error('Invalid URL: null or undefined'));
	}

	const parsedURL = new URL(url);

	return(parsedURL);
}

async function getEndpoints(resolver: Resolver, request: Partial<KeetaAssetMovementAnchorInitiateTransferRequest>): Promise<GetEndpointsResult | null> {
	if (request.allowedRails) {
		throw(new Error('rail not currently supported'));
	}
	const asset = request.asset ? convertAssetSearchInputToCanonical(request.asset) : undefined;
	if (asset === undefined) {
		throw(new Error('asset it required to lookup provider'));
	}
	const from = request.from?.location ? { from: convertAssetLocationToString(request.from.location) } : {};
	const to = request.to?.location ? { to: convertAssetLocationToString(request.to.location) } : {};
	const response = await resolver.lookup('assetMovement', {
		asset,
		...from,
		...to
		// rail: request.allowedRails
	});

	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaAssetMovementServiceInfo]> {
		const supportedAssetsMetadata = await Resolver.Metadata.fullyResolveValuizable(serviceInfo.supportedAssets);
		const supportedAssets = asserKeetaSupportedAssets(supportedAssetsMetadata);

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

/**
 * Represents an in-progress Asset Movement request.
 */
class KeetaAssetMovementTransfer {
	private readonly provider: KeetaAssetMovementAnchorProvider;
	private transferID: string;
	private transferInstructions: AssetTransferInstructions[];

	constructor(provider: KeetaAssetMovementAnchorProvider, transfer: { id: string; instructionChoices: AssetTransferInstructions[]; }) {
		this.provider = provider;
		this.transferID = transfer.id;
		this.transferInstructions = transfer.instructionChoices
	}

	async getTransferStatus(): Promise<KeetaAssetMovementAnchorGetTransferStatusResponse> {
		return(await this.provider.getTransferStatus({ id: this.transferID }));
	}

	get transferId(): typeof this.transferID {
		return(this.transferID);
	}

	get instructions(): typeof this.transferInstructions {
		return(this.transferInstructions);
	}
}

const isKeetaAssetMovementAnchorInitiateTransferRequest = createIs<KeetaAssetMovementAnchorInitiateTransferRequest>();
const isKeetaAssetMovementAnchorInitiateTransferResponse = createIs<KeetaAssetMovementAnchorInitiateTransferResponse>();
const isKeetaAssetMovementAnchorGetExchangeStatusResponse = createIs<KeetaAssetMovementAnchorGetTransferStatusResponse>();
const isKeetaAssetMovementAnchorCreatePersistentForwardingResponse = createIs<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>();

class KeetaAssetMovementAnchorProvider extends KeetaAssetMovementAnchorBase {
	readonly serviceInfo: KeetaAssetMovementServiceInfo;
	readonly providerID: ProviderID;
	readonly transfer: KeetaAssetMovementAnchorInitiateTransferRequest | { asset: MovableAsset };
	private readonly parent: KeetaAssetMovementAnchorClient;

	constructor(serviceInfo: KeetaAssetMovementServiceInfo, providerID: ProviderID, transfer: KeetaAssetMovementAnchorInitiateTransferRequest | { asset: MovableAsset }, parent: KeetaAssetMovementAnchorClient) {
		const parentPrivate = parent._internals(KeetaAssetMovementAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.transfer = transfer;
		this.parent = parent;
	}

	async initiateTransfer(): Promise<KeetaAssetMovementTransfer> {
		this.logger?.debug(`Starting Asset Movement Transfer for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(this.transfer)}`);

		if (!isKeetaAssetMovementAnchorInitiateTransferRequest(this.transfer)) {
			throw(new Error('initiateTransfer not supported for this request'));
		}

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

		const anchorTransfer = new KeetaAssetMovementTransfer(this, { id: requestInformationJSON.id, instructionChoices: requestInformationJSON.instructionChoices });
		return(anchorTransfer);
	}

	async getTransferStatus(request: KeetaAssetMovementAnchorGetTransferStatusRequest): Promise<KeetaAssetMovementAnchorGetTransferStatusResponse> {
		const endpoints = this.serviceInfo.operations;
		const getTransferStatus = await endpoints.getTransferStatus;
		if (getTransferStatus === undefined) {
			throw(new Error('Asset Movement service does not support getTransferStatus operation'));
		}
		const getTransferURL = getTransferStatus({ id: request.id });
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

		this.logger?.debug(`asset movement request successful, request ID ${request.id}`);

		return(requestInformationJSON);
	}

	async createPersistentForwardingAddress(request: Omit<KeetaAssetMovementAnchorCreatePersistentForwardingRequest, 'asset'>): Promise<KeetaAssetMovementAnchorCreatePersistentForwardingResponse | null> {
		this.logger?.debug(`Creating persistent forwarding for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(this.transfer)}`);

		const endpoints = this.serviceInfo.operations;
		const createPersistentForwarding = await endpoints.createPersistentForwarding;
		if (createPersistentForwarding === undefined) {
			throw(new Error('Asset Movement service does not support createPersistentForwarding operation'));
		}
		const createPersistentForwardingURL = createPersistentForwarding();
		const requestInformation = await fetch(createPersistentForwardingURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				asset: this.transfer.asset,
				...request
			})
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!isKeetaAssetMovementAnchorCreatePersistentForwardingResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from create persistent forwarding request: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(new Error(`create persistent forwarding request failed: ${requestInformationJSON.error}`));
		}

		this.logger?.debug(`create persistent forwarding request successful, ${requestInformationJSON.address}`);

		return(requestInformationJSON);
	}
}

class KeetaAssetMovementAnchorClient extends KeetaAssetMovementAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	readonly #account: InstanceType<typeof KeetaNetLib.Account>;

	constructor(client: KeetaNetUserClient, config: KeetaAssetMovementClientConfig = {}) {
		super({ client, logger: config.logger });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();

		if (config.signer) {
			this.#signer = config.signer;
		} else if ('signer' in client && client.signer !== null) {
			this.#signer = client.signer;
		} else if ('account' in client && client.account.hasPrivateKey) {
			this.#signer = client.account;
		} else {
			throw(new Error('KeetaAssetMovementAnchorClient requires a Signer or a UserClient with an associated Signer'));
		}

		if (config.account) {
			this.#account = config.account;
		} else if ('account' in client) {
			this.#account = client.account;
		} else {
			throw(new Error('KeetaAssetMovementAnchorClient requires an Account or a UserClient with an associated Account'));
		}
	}

	async getProvidersForTransfer(request: KeetaAssetMovementAnchorInitiateTransferRequest | { asset: MovableAsset }): Promise<KeetaAssetMovementAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, request);
		if (endpoints === null) {
			return(null);
		}

		const providers = typedAssetMovementServiceEntries(endpoints).map(([id, serviceInfo]) => {
			return(new KeetaAssetMovementAnchorProvider(serviceInfo, id, request, this));
		});

		return(providers);
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
