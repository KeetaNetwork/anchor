import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import { getDefaultResolver } from '../../config.js';

import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type {
	KeetaAssetMovementAnchorGetTransferStatusResponse,
	KeetaAssetMovementAnchorCreatePersistentForwardingRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	SupportedAssetsMetadata,
	ProviderSearchInput,
	KeetaAssetMovementAnchorlistTransactionsRequest,
	KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	AssetTransferInstructions,
	KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest,
	KeetaAssetMovementAnchorInitiateTransferClientRequest,
	KeetaNetAccount,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest,
	KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	KeetaAssetMovementAnchorlistTransactionsClientRequest,
	KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest,
	PersistentAddressTemplateData,
	KeetaAssetMovementAnchorGetTransferStatusClientRequest,
	KeetaAssetMovementAnchorShareKYCClientRequest,
	KeetaAssetMovementAnchorShareKYCRequest,
	KeetaAssetMovementAnchorShareKYCResponse,
	KeetaAssetMovementAnchorListPersistentForwardingClientRequest,
	KeetaPersistentForwardingAddressDetails
} from './common.js';
import {
	assertKeetaSupportedAssetsMetadata,
	convertAssetLocationToString,
	convertAssetOrPairSearchInputToCanonical,
	convertAssetSearchInputToCanonical,
	getKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequestSigningData,
	getKeetaAssetMovementAnchorCreatePersistentForwardingRequestSigningData,
	getKeetaAssetMovementAnchorGetTransferStatusRequestSigningData,
	getKeetaAssetMovementAnchorInitiateTransferRequestSigningData,
	getKeetaAssetMovementAnchorListForwardingAddressTemplateRequestSigningData,
	getKeetaAssetMovementAnchorListPersistentForwardingRequestSigningData,
	getKeetaAssetMovementAnchorlistTransactionsRequestSigningData,
	getKeetaAssetMovementAnchorShareKYCRequestSigningData,
	isKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
	isKeetaAssetMovementAnchorCreatePersistentForwardingResponse,
	isKeetaAssetMovementAnchorGetExchangeStatusResponse,
	isKeetaAssetMovementAnchorInitiateTransferResponse,
	isKeetaAssetMovementAnchorListForwardingAddressTemplateResponse,
	isKeetaAssetMovementAnchorListPersistentForwardingResponse,
	isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
	isKeetaAssetMovementAnchorShareKYCResponse
} from './common.js';
import type { Logger } from '../../lib/log/index.ts';
import Resolver from "../../lib/resolver.js";
import type { ServiceMetadata, ServiceMetadataAuthenticationType, ServiceMetadataEndpoint, SharedLookupCriteria } from '../../lib/resolver.ts';
import crypto from '../../lib/utils/crypto.js';
import type { BrandedString } from '../../lib/utils/brand.js';
import { createAssertEquals } from 'typia';
import type { ExtractOk, HTTPSignedField } from '../../lib/http-server/common.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { SignData } from '../../lib/utils/signing.js';
import { KeetaAnchorError } from '../../lib/error.js';
import { KeetaNet } from '../../client/index.js';

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

const assertServiceMetadataEndpoint = createAssertEquals<ServiceMetadataEndpoint>();

/**
 * A list of operations that can be performed by the Asset Movement Anchor service.
 */
type KeetaAssetMovementAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['assetMovement']>[string]['operations']]?: {
		url: (params?: { [key: string]: string; }) => URL;
		options: {
			authentication: ServiceMetadataAuthenticationType;
		};
	};
};

/**
 * The service information for a KYC Anchor service.
 */
type KeetaAssetMovementServiceInfo = {
	operations: {
		[operation in keyof KeetaAssetMovementAnchorOperations]: Promise<KeetaAssetMovementAnchorOperations[operation]>;
	};

	supportedAssets: SupportedAssetsMetadata[];
};

/**
 * For each matching KYC Anchor service, this type describes the
 * operations available and the country codes that the service supports.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaAssetMovementServiceInfo;
};

function validateURL(url: string | undefined): URL {
	if (url === undefined || url === null) {
		throw(new Error('Invalid URL: null or undefined'));
	}

	const parsedURL = new URL(url);

	return(parsedURL);
}

async function getEndpoints(resolver: Resolver, request: ProviderSearchInput, shared?: SharedLookupCriteria, logger?: Logger): Promise<GetEndpointsResult | null> {
	const asset = request.asset ? { asset: convertAssetOrPairSearchInputToCanonical(request.asset) } : undefined;
	const from = request.from ? { from: convertAssetLocationToString(request.from) } : {};
	const to = request.to ? { to: convertAssetLocationToString(request.to) } : {};
	const rail = request.rail ? { rail: request.rail } : {};
	const response = await resolver.lookup('assetMovement', {
		...asset,
		...from,
		...to,
		...rail
	}, shared);

	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaAssetMovementServiceInfo]> {
		const supportedAssetsMetadata = await Resolver.Metadata.fullyResolveValuizable(serviceInfo.supportedAssets);
		const supportedAssets = assertKeetaSupportedAssetsMetadata(supportedAssetsMetadata);

		const operations = await serviceInfo.operations('object');
		const operationsFunctions: KeetaAssetMovementServiceInfo['operations'] = {};
		for (const [ key, operation ] of Object.entries(operations)) {
			if (operation === undefined) {
				continue;
			}

			Object.defineProperty(operationsFunctions, key, {
				get: async function() {
					const endpointInfo = assertServiceMetadataEndpoint(await Resolver.Metadata.fullyResolveValuizable(operation));

					let url;
					let authentication: ServiceMetadataAuthenticationType = {
						type: 'none',
						method: 'keeta-account'
					};

					if (typeof endpointInfo === 'string') {
						url = endpointInfo;
					} else {
						url = endpointInfo.url;
						if (endpointInfo.options?.authentication) {
							authentication = endpointInfo.options.authentication;
						}
					}

					return({
						url: function(params?: { [key: string]: string; }): URL {
							let substitutedURL;

							try {
								substitutedURL = decodeURI(url)
							} catch (error) {
								logger?.debug('getEndpoints', 'Failed to decode URI, using original URL for substitution', error, url);

								substitutedURL = url;
							}

							for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
								substitutedURL = substitutedURL.replace(`{${paramKey}}`, encodeURIComponent(paramValue));
							}

							return(validateURL(substitutedURL));
						},
						options: { authentication }
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
	private request: KeetaAssetMovementAnchorInitiateTransferClientRequest;
	private transfer:  { id: string, instructionChoices: AssetTransferInstructions[] }

	constructor(provider: KeetaAssetMovementAnchorProvider, request: KeetaAssetMovementAnchorInitiateTransferClientRequest, transfer: { id: string, instructionChoices: AssetTransferInstructions[] }) {
		this.provider = provider;
		this.request = request;
		this.transfer = transfer;
	}

	async getTransferStatus(): Promise<ExtractOk<KeetaAssetMovementAnchorGetTransferStatusResponse>> {
		const account = this.request.account ? { account: this.request.account } : undefined;
		return(await this.provider.getTransferStatus({ id: this.transfer.id, ...account }));
	}

	get transferId(): string {
		return(this.transfer.id);
	}

	get instructions(): AssetTransferInstructions[] {
		return(this.transfer.instructionChoices);
	}
}


interface AwaitPromiseURLOptions {
	defaultPollIntervalMs?: number;
	timeoutMs?: number;
	abortSignal?: AbortSignal;
}

class KeetaAssetMovementAnchorProvider extends KeetaAssetMovementAnchorBase {
	readonly serviceInfo: KeetaAssetMovementServiceInfo;
	readonly providerID: ProviderID;
	private readonly parent: KeetaAssetMovementAnchorClient;

	constructor(serviceInfo: KeetaAssetMovementServiceInfo, providerID: ProviderID, parent: KeetaAssetMovementAnchorClient) {
		const parentPrivate = parent._internals(KeetaAssetMovementAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.parent = parent;
	}

	async #getOperationData(operationName: keyof KeetaAssetMovementAnchorOperations, params?: { [key: string]: string; }) {
		const endpoint = await this.serviceInfo.operations[operationName];
		if (endpoint === undefined) {
			throw(new Error(`Asset Movement service does not support ${operationName} operation`));
		}

		if (endpoint.options.authentication.method !== 'keeta-account') {
			throw(new Error(`Unsupported authentication method: ${endpoint.options.authentication.method}`));
		}

		return({
			url: endpoint.url(params),
			auth: endpoint.options.authentication
		})
	}

	async #parseResponseError(data: unknown) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('Response is not an error'));
		}

		if (!('ok' in data) || data.ok !== false) {
			throw(new Error('Response is not an error'));
		}

		let errorStr;

		let parsedError: KeetaAnchorError | null = null;
		try {
			parsedError = await KeetaAnchorError.fromJSON(data);
		} catch (error: unknown) {
			this.logger?.debug('Failed to parse error response as KeetaAnchorError', error, data);
		}

		if (parsedError) {
			return(parsedError);
		} else {
			if ('error' in data && typeof data.error === 'string') {
				errorStr = data.error;
			} else {
				errorStr = 'Unknown error';
			}

			return(new Error(`asset movement request failed: ${errorStr}`));
		}
	}

	async #makeRequest<
		Response extends { ok: true } | { ok: false; error: string; },
		Request = undefined,
		SerializedRequest = Request
	>(input: {
		method: 'GET' | 'POST';
		endpoint: keyof KeetaAssetMovementAnchorOperations;
		account?: KeetaNetAccount | undefined;
		params?: { [key: string]: string; } | undefined;
		body?: Request | undefined;
		serializeRequest?: (body: Request) => (SerializedRequest | Promise<Omit<SerializedRequest, 'signed'>>);

		getSignedData?: (request: SerializedRequest) => Signable;
		isResponse: (data: unknown) => data is Response;
	}): Promise<Extract<Response, { ok: true }>>  {
		const { url, auth } = await this.#getOperationData(input.endpoint, input.params);

		let serializedRequest;

		if (input.body && input.serializeRequest) {
			serializedRequest = await input.serializeRequest(input.body);
		} else {
			serializedRequest = input.body;
		}

		let signed: HTTPSignedField | undefined;

		if (auth.type === 'required' || (auth.type === 'optional' && input.account)) {
			if (!input.account) {
				throw(new Error('Account information is required for this operation'));
			}

			if (!input.getSignedData) {
				throw(new Error('getSignedData function is required for signing the request'));
			}

			// We need this assertion because TypeScript cannot infer that the type is correct here, it is correct in the arguments.
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const signable = input.getSignedData(serializedRequest as SerializedRequest);

			signed = await SignData(input.account.assertAccount(), signable);
		}

		let usingUrl = url;
		const headers: { [key: string]: string } = {
			'Accept': 'application/json'
		};
		let body: BodyInit | null = null;
		if (input.method === 'POST') {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify({ ...serializedRequest, signed });
		} else {
			if (signed) {
				if (!input.account) {
					throw(new Error('invariant: Account information is required for this operation, which should exist at this point'));
				}

				usingUrl = addSignatureToURL(usingUrl, { signedField: signed, account: input.account.assertAccount() });
			}

			if (input.body) {
				throw(new Error('Body cannot be sent with GET requests'));
			}
		}

		const requestInformation = await fetch(usingUrl, {
			method: input.method, headers, body
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!input.isResponse(requestInformationJSON)) {
			throw(new Error(`Invalid response from asset movement service: ${JSON.stringify(requestInformationJSON)}`));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		// We need this assertion because TypeScript cannot infer that the type is correct here, it is correct because we checked it above.
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(requestInformationJSON as Extract<Response, { ok: true }>);
	}

	async initiateTransfer(request: KeetaAssetMovementAnchorInitiateTransferClientRequest): Promise<KeetaAssetMovementTransfer> {
		this.logger?.debug(`Starting Asset Movement Transfer for provider ID: ${String(this.providerID)}`);

		const requestInformationJSON = await this.#makeRequest({
			method: 'POST',
			endpoint: 'initiateTransfer',
			account: request.account,
			serializeRequest(body) {
				return({
					...body,
					value: String(body.value),
					from: {
						location: convertAssetLocationToString(body.from.location)
					},
					to: {
						location: convertAssetLocationToString(body.to.location),
						recipient: body.to.recipient
					},
					asset: convertAssetOrPairSearchInputToCanonical(body.asset),
					account: body.account?.assertAccount().publicKeyString.get()
				})
			},
			body: request,
			getSignedData: getKeetaAssetMovementAnchorInitiateTransferRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorInitiateTransferResponse
		});

		this.logger?.debug(`asset movement request successful, request ID ${requestInformationJSON.id}`);

		const anchorTransfer = new KeetaAssetMovementTransfer(this, request, { id: requestInformationJSON.id, instructionChoices: requestInformationJSON.instructionChoices });
		return(anchorTransfer);
	}

	async getTransferStatus(request: KeetaAssetMovementAnchorGetTransferStatusClientRequest): Promise<ExtractOk<KeetaAssetMovementAnchorGetTransferStatusResponse>> {
		const requestInformationJSON = await this.#makeRequest({
			method: 'GET',
			endpoint: 'getTransferStatus',
			account: request.account,
			params: { id: request.id },
			getSignedData: () => getKeetaAssetMovementAnchorGetTransferStatusRequestSigningData(request),
			isResponse: isKeetaAssetMovementAnchorGetExchangeStatusResponse
		});

		this.logger?.debug(`asset movement request successful, request ID ${request.id}`);

		return(requestInformationJSON);
	}

	async createPersistentForwardingTemplate(request: KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest): Promise<ExtractOk<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>> {
		this.logger?.debug(`Creating persistent forwarding for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(request)}`);

		const requestInformationJSON = await this.#makeRequest<
			KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse,
			KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateClientRequest,
			KeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequest
		>({
			method: 'POST',
			endpoint: 'createPersistentForwardingTemplate',
			account: request.account,
			serializeRequest(body) {
				return({
					...body,
					location: convertAssetLocationToString(body.location),
					asset: convertAssetOrPairSearchInputToCanonical(body.asset),
					account: body.account?.assertAccount().publicKeyString.get()
				})
			},
			body: request,
			getSignedData: getKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorCreatePersistentForwardingAddressTemplateResponse
		});

		this.logger?.debug(`create persistent forwarding request successful`, requestInformationJSON.address);

		return(requestInformationJSON);
	}

	async createPersistentForwardingAddress(request: KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest): Promise<ExtractOk<KeetaAssetMovementAnchorCreatePersistentForwardingResponse>> {
		this.logger?.debug(`Creating persistent forwarding for provider ID: ${String(this.providerID)}, request: ${JSON.stringify(request)}`);

		const requestInformationJSON = await this.#makeRequest<
			KeetaAssetMovementAnchorCreatePersistentForwardingResponse,
			KeetaAssetMovementAnchorCreatePersistentForwardingClientRequest,
			KeetaAssetMovementAnchorCreatePersistentForwardingRequest
		>({
			method: 'POST',
			endpoint: 'createPersistentForwarding',
			account: request.account,
			serializeRequest(body) {
				const base = {
					sourceLocation: convertAssetLocationToString(body.sourceLocation),
					asset: convertAssetOrPairSearchInputToCanonical(body.asset),
					account: body.account?.assertAccount().publicKeyString.get()
				} as const;

				if ('persistentAddressTemplateId' in body) {
					return({
						...base,
						persistentAddressTemplateId: body.persistentAddressTemplateId
					});
				} else {
					return({
						...base,
						destinationAddress: body.destinationAddress,
						destinationLocation: convertAssetLocationToString(body.destinationLocation)
					});
				}
			},
			body: request,
			getSignedData: getKeetaAssetMovementAnchorCreatePersistentForwardingRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorCreatePersistentForwardingResponse
		});

		this.logger?.debug(`create persistent forwarding request successful`, requestInformationJSON.address);

		return(requestInformationJSON);
	}

	async listForwardingAddressTemplates(request: KeetaAssetMovementAnchorListForwardingAddressTemplateClientRequest): Promise<{ templates: PersistentAddressTemplateData[]; total: number; }> {
		this.logger?.debug(`Listing persistent forwarding address templates for provider ID: ${String(this.providerID)}`);

		const requestInformationJSON = await this.#makeRequest({
			method: 'POST',
			endpoint: 'listPersistentForwardingTemplate',
			account: request.account,
			body: request,
			serializeRequest(body) {
				return({
					account: body.account?.assertAccount().publicKeyString.get(),
					asset: body.asset?.map(a => convertAssetSearchInputToCanonical(a)),
					location: body.location?.map(l => convertAssetLocationToString(l))
				});
			},
			getSignedData: getKeetaAssetMovementAnchorListForwardingAddressTemplateRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorListForwardingAddressTemplateResponse
		});

		this.logger?.debug(`list persistent forwarding address templates request successful`, requestInformationJSON.templates);

		return({
			templates: requestInformationJSON.templates,
			total: Number(requestInformationJSON.total)
		});
	}

	async listForwardingAddresses(request: KeetaAssetMovementAnchorListPersistentForwardingClientRequest): Promise<{ addresses: KeetaPersistentForwardingAddressDetails[]; total: number; }> {
		this.logger?.debug(`Listing persistent forwarding address templates for provider ID: ${String(this.providerID)}`);

		const requestInformationJSON = await this.#makeRequest({
			method: 'POST',
			endpoint: 'listPersistentForwarding',
			account: request.account,
			body: request,
			serializeRequest(body) {
				return({
					...body,
					account: body.account?.assertAccount().publicKeyString.get(),
					search: body.search ? body.search.map(function(searchItem) {
						return({
							...searchItem,
							asset: searchItem.asset ? convertAssetSearchInputToCanonical(searchItem.asset) : undefined,
							sourceLocation: searchItem.sourceLocation ? convertAssetLocationToString(searchItem.sourceLocation) : undefined,
							destinationLocation: searchItem.destinationLocation ? convertAssetLocationToString(searchItem.destinationLocation) : undefined
						})
					}) : undefined
				});
			},
			getSignedData: getKeetaAssetMovementAnchorListPersistentForwardingRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorListPersistentForwardingResponse
		});

		this.logger?.debug('KeetaAssetMovementAnchorProvider::listPersistentForwardingAddresses', `list persistent forwarding address request successful`, requestInformationJSON.addresses);

		return({
			addresses: requestInformationJSON.addresses,
			total: Number(requestInformationJSON.total)
		});
	}

	async listTransactions(request: KeetaAssetMovementAnchorlistTransactionsClientRequest): Promise<ExtractOk<KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse>> {
		this.logger?.debug(`List persistent forwarding transactions provider ID: ${String(this.providerID)}, request: ${JSON.stringify(request)}`);

		const requestInformationJSON = await this.#makeRequest<
			KeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse,
			KeetaAssetMovementAnchorlistTransactionsClientRequest,
			KeetaAssetMovementAnchorlistTransactionsRequest
		>({
			method: 'POST',
			endpoint: 'listTransactions',
			account: request.account,
			serializeRequest(body) {
				return({
					account: body.account?.assertAccount().publicKeyString.get(),
					pagination: body.pagination,
					persistentAddresses: body.persistentAddresses?.map(pa => ({
						location: convertAssetLocationToString(pa.location),
						...('persistentAddressTemplate' in pa ?
							{ persistentAddressTemplate: pa.persistentAddressTemplate } :
							{ persistentAddress: pa.persistentAddress }
						)
					})),
					from: body.from ? {
						location: convertAssetLocationToString(body.from.location),
						userAddress: body.from.userAddress,
						asset: body.from.asset ? convertAssetSearchInputToCanonical(body.from.asset) : undefined
					} : undefined,
					to: body.to ? {
						location: convertAssetLocationToString(body.to.location),
						userAddress: body.to.userAddress,
						asset: body.to.asset ? convertAssetSearchInputToCanonical(body.to.asset) : undefined
					} : undefined
				});
			},
			body: request,
			getSignedData: getKeetaAssetMovementAnchorlistTransactionsRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorlistPersistentForwardingTransactionsResponse
		});

		this.logger?.debug(`list persistent transactions request successful, ${requestInformationJSON.transactions}`);

		return(requestInformationJSON);
	}

	async #awaitPromiseURL(promiseURL: string, options?: AwaitPromiseURLOptions): Promise<void> {
		const startTime = Date.now();

		const timeout = options?.timeoutMs ?? (5 * 60 * 1000);

		while (true) {
			if (options?.abortSignal?.aborted) {
				break;
			}

			let response;

			try {
				response = await fetch(promiseURL);
			} catch (error) {
				this.logger?.debug('KeetaAssetMovementAnchorProvider::awaitPromiseURL', 'Error fetching promise URL', error);
				throw(new Error(`Error fetching promise URL: ${String(error)}`));
			}

			if (response.status === 200) {
				return;
			}

			if (response.status !== 202) {
				let errorData: unknown;
				try {
					errorData = await response.json();
				} catch {
					throw(new Error(`Error parsing error response json from promise, status code ${response.status}`));
				}
				throw(await this.#parseResponseError(errorData));
			}

			if (Date.now() - startTime > timeout) {
				throw(new Error('Timeout waiting for promise URL to complete'));
			}

			let retryAfterMS: number | undefined;
			const retryAfterHeader = response.headers.get('Retry-After');
			if (retryAfterHeader) {

				if (!isNaN(Number(retryAfterHeader))) {
					retryAfterMS = Number(retryAfterHeader) * 1000;
				} else {
					const retryAfterDate = new Date(retryAfterHeader);
					if (!isNaN(retryAfterDate.getTime())) {
						retryAfterMS = retryAfterDate.getTime() - Date.now();
					}
				}
			}

			if (!retryAfterMS) {
				retryAfterMS = options?.defaultPollIntervalMs ?? 1000;
			}

			await KeetaNet.lib.Utils.Helper.asleep(retryAfterMS);
		}
	}

	async shareKYCAttributes(request: KeetaAssetMovementAnchorShareKYCClientRequest, awaitOptions?: AwaitPromiseURLOptions): Promise<void> {
		this.logger?.debug('Sharing KYC attributes');

		const response = await this.#makeRequest<
			KeetaAssetMovementAnchorShareKYCResponse,
			KeetaAssetMovementAnchorShareKYCClientRequest,
			KeetaAssetMovementAnchorShareKYCRequest
		>({
			method: 'POST',
			endpoint: 'shareKYC',
			account: request.account,
			async serializeRequest(body) {
				let attributes;
				if (typeof body.attributes === 'string') {
					attributes = body.attributes;
				} else {
					attributes = await body.attributes.export({ format: 'string' });
				}

				return({
					account: body.account.assertAccount().publicKeyString.get(),
					attributes: attributes,
					tosAgreement: body.tosAgreement
				});
			},
			body: request,
			getSignedData: getKeetaAssetMovementAnchorShareKYCRequestSigningData,
			isResponse: isKeetaAssetMovementAnchorShareKYCResponse
		});

		if (response.isPending && response.promiseURL) {
			this.logger?.debug('KYC attribute sharing is pending, awaiting promise URL');

			let promiseURL;

			if (response.promiseURL.startsWith('/')) {
				const operationData = await this.#getOperationData('shareKYC');
				promiseURL = new URL(response.promiseURL, operationData.url).toString();
			} else {
				promiseURL = response.promiseURL;
			}

			await this.#awaitPromiseURL(promiseURL, { ...awaitOptions });
		}

		this.logger?.debug(`done sharing KYC attributes`);
	}
}

class KeetaAssetMovementAnchorClient extends KeetaAssetMovementAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;
	// eslint-disable-next-line no-unused-private-class-members
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	// eslint-disable-next-line no-unused-private-class-members
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

	async #lookup(request: ProviderSearchInput, shared?: SharedLookupCriteria): Promise<KeetaAssetMovementAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, request, shared, this.logger);
		if (endpoints === null) {
			return(null);
		}

		const providers = typedAssetMovementServiceEntries(endpoints).map(([id, serviceInfo]) => {
			return(new KeetaAssetMovementAnchorProvider(serviceInfo, id, this));
		});

		return(providers);
	}

	async getProvidersForTransfer(request: ProviderSearchInput): Promise<KeetaAssetMovementAnchorProvider[] | null> {
		return(await this.#lookup(request));
	}

	async getProviderByID(providerID: string): Promise<KeetaAssetMovementAnchorProvider | null> {
		const providers = await this.#lookup({}, { providerIDs: [providerID] });
		return(providers?.[0] ?? null);
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
