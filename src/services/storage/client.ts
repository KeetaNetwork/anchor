import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';
import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType, ServiceMetadataEndpoint } from '../../lib/resolver.ts';
import type { Signable } from '../../lib/utils/signing.js';
import type {
	StorageObjectMetadata,
	SearchCriteria,
	SearchPagination,
	QuotaStatus,
	StorageObjectVisibility,
	KeetaStorageAnchorDeleteClientRequest,
	KeetaStorageAnchorPutRequest,
	KeetaStorageAnchorSearchRequest,
	KeetaStorageAnchorQuotaRequest
} from './common.ts';
import {
	isKeetaStorageAnchorDeleteResponse,
	isKeetaStorageAnchorPutResponse,
	isKeetaStorageAnchorGetResponse,
	isKeetaStorageAnchorSearchResponse,
	isKeetaStorageAnchorQuotaResponse,
	getKeetaStorageAnchorDeleteRequestSigningData,
	getKeetaStorageAnchorPutRequestSigningData,
	getKeetaStorageAnchorGetRequestSigningData,
	getKeetaStorageAnchorSearchRequestSigningData,
	getKeetaStorageAnchorQuotaRequestSigningData,
	makeStoragePath,
	Errors
} from './common.js';
import { getDefaultResolver } from '../../config.js';
import { EncryptedContainer } from '../../lib/encrypted-container.js';
import Resolver from '../../lib/resolver.js';
import crypto from '../../lib/utils/crypto.js';
import { createAssertEquals } from 'typia';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import { SignData } from '../../lib/utils/signing.js';
import { KeetaAnchorError } from '../../lib/error.js';
import { Buffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';

/**
 * The configuration options for the Storage Anchor client.
 */
export type KeetaStorageAnchorClientConfig = {
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
	 * The resolver to use for resolving Storage Anchor services. If not
	 * provided, a default resolver will be created using the provided
	 * client and network.
	 */
	resolver?: Resolver;
	/**
	 * The account to use for signing requests. If not provided, the
	 * account associated with the provided client will be used.
	 */
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	/**
	 * Account to perform changes on. If not provided, the account
	 * associated with the provided client will be used.
	 */
	account?: InstanceType<typeof KeetaNetLib.Account>;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

/**
 * An opaque type that represents a provider ID.
 */
type ProviderID = string;

const KeetaStorageAnchorClientAccessToken = Symbol('KeetaStorageAnchorClientAccessToken');

const assertServiceMetadataEndpoint = createAssertEquals<ServiceMetadataEndpoint>();

/**
 * A list of operations that can be performed by the Storage Anchor service.
 */
type KeetaStorageAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['storage']>[string]['operations']]?: {
		url: (params?: { [key: string]: string; }) => URL;
		options: {
			authentication: ServiceMetadataAuthenticationType;
		};
	};
};

/**
 * The service information for a Storage Anchor service.
 */
type KeetaStorageServiceInfo = {
	operations: {
		[operation in keyof KeetaStorageAnchorOperations]: Promise<KeetaStorageAnchorOperations[operation]>;
	};
};

/**
 * For each matching Storage Anchor service, this type describes the
 * operations available.
 */
type GetEndpointsResult = {
	[id: ProviderID]: KeetaStorageServiceInfo;
};

function validateURL(url: string | undefined): URL {
	if (url === undefined || url === null) {
		throw(new Error('Invalid URL: null or undefined'));
	}

	const parsedURL = new URL(url);
	return(parsedURL);
}

async function getEndpoints(resolver: Resolver, logger?: Logger): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('storage', {});
	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaStorageServiceInfo]> {
		const operations = await serviceInfo.operations('object');
		const operationsFunctions: KeetaStorageServiceInfo['operations'] = {};
		for (const [key, operation] of Object.entries(operations)) {
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
								substitutedURL = decodeURI(url);
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
				operations: operationsFunctions
			}
		]);
	});

	const retval = Object.fromEntries(await Promise.all(serviceInfoPromises));
	return(retval);
}

interface KeetaStorageAnchorBaseConfig {
	client: KeetaNetUserClient;
	logger?: Logger | undefined;
}

class KeetaStorageAnchorBase {
	protected readonly logger?: Logger | undefined;
	protected readonly client: KeetaNetUserClient;

	constructor(config: KeetaStorageAnchorBaseConfig) {
		this.client = config.client;
		this.logger = config.logger;
	}
}

/**
 * Represents a Storage Anchor provider for performing storage operations.
 */
class KeetaStorageAnchorProvider extends KeetaStorageAnchorBase {
	readonly serviceInfo: KeetaStorageServiceInfo;
	readonly providerID: ProviderID;

	constructor(serviceInfo: KeetaStorageServiceInfo, providerID: ProviderID, parent: KeetaStorageAnchorClient) {
		const parentPrivate = parent._internals(KeetaStorageAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
	}

	async #getOperationData(operationName: keyof KeetaStorageAnchorOperations, params?: { [key: string]: string; }) {
		const endpoint = await this.serviceInfo.operations[operationName];
		if (endpoint === undefined) {
			throw(new Errors.OperationNotSupported(operationName));
		}

		if (endpoint.options.authentication.method !== 'keeta-account') {
			throw(new Errors.UnsupportedAuthMethod(endpoint.options.authentication.method));
		}

		return({
			url: endpoint.url(params),
			auth: endpoint.options.authentication
		});
	}

	async #parseResponseError(data: unknown) {
		if (typeof data !== 'object' || data === null) {
			throw(new Error('Response is not an error'));
		}

		if (!('ok' in data) || data.ok !== false) {
			throw(new Error('Response is not an error'));
		}

		let parsedError: KeetaAnchorError | null = null;
		try {
			parsedError = await KeetaAnchorError.fromJSON(data);
		} catch (error: unknown) {
			this.logger?.debug('Failed to parse error response as KeetaAnchorError', error, data);
		}

		if (parsedError) {
			return(parsedError);
		} else {
			let errorStr;
			if ('error' in data && typeof data.error === 'string') {
				errorStr = data.error;
			} else {
				errorStr = 'Unknown error';
			}

			return(new Error(`storage request failed: ${errorStr}`));
		}
	}

	async #makeRequest<
		Response extends { ok: true } | { ok: false; error: string; },
		Request = undefined,
		SerializedRequest = Request
	>(input: {
		method: 'GET' | 'POST' | 'PUT' | 'DELETE';
		endpoint: keyof KeetaStorageAnchorOperations;
		account?: InstanceType<typeof KeetaNetLib.Account> | undefined;
		params?: { [key: string]: string; } | undefined;
		queryParams?: { [key: string]: string; } | undefined;
		body?: Request | undefined;
		serializeRequest?: (body: Request) => (SerializedRequest | Promise<Omit<SerializedRequest, 'signed'>>);
		getSignedData?: (request: SerializedRequest) => Signable;
		isResponse: (data: unknown) => data is Response;
	}): Promise<Extract<Response, { ok: true }>> {
		const { url, auth } = await this.#getOperationData(input.endpoint, input.params);

		// Add query parameters to URL if provided
		if (input.queryParams) {
			for (const [key, value] of Object.entries(input.queryParams)) {
				url.searchParams.set(key, value);
			}
		}

		let serializedRequest;
		if (input.body && input.serializeRequest) {
			serializedRequest = await input.serializeRequest(input.body);
		} else {
			serializedRequest = input.body;
		}

		let signed: HTTPSignedField | undefined;
		if (auth.type === 'required' || (auth.type === 'optional' && input.account)) {
			if (!input.account) {
				throw(new Errors.AccountRequired());
			}

			if (!input.getSignedData) {
				throw(new Error('getSignedData function is required for signing the request'));
			}

			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const signable = input.getSignedData(serializedRequest as SerializedRequest);
			signed = await SignData(input.account.assertAccount(), signable);
		}

		const headers: { [key: string]: string } = {
			'Accept': 'application/json'
		};
		let usingUrl = url;
		let body: BodyInit | null = null;
		if (input.method === 'POST' || input.method === 'PUT') {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify({ ...serializedRequest, signed });
		} else {
			if (signed) {
				if (!input.account) {
					throw(new Error('invariant: Account information is required for this operation'));
				}

				usingUrl = addSignatureToURL(usingUrl, { signedField: signed, account: input.account.assertAccount() });
			}

			if (input.body) {
				throw(new Error('Body cannot be sent with GET/DELETE requests'));
			}
		}

		const requestInformation = await fetch(usingUrl, {
			method: input.method, headers, body
		});

		const requestInformationJSON: unknown = await requestInformation.json();
		if (!input.isResponse(requestInformationJSON)) {
			throw(new Errors.InvalidResponse(JSON.stringify(requestInformationJSON)));
		}

		if (!requestInformationJSON.ok) {
			throw(await this.#parseResponseError(requestInformationJSON));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(requestInformationJSON as Extract<Response, { ok: true }>);
	}

	/**
	 * Delete an object by path.
	 */
	async delete(request: KeetaStorageAnchorDeleteClientRequest): Promise<boolean> {
		this.logger?.debug(`Deleting object at ${request.path} for provider ID: ${String(this.providerID)}`);

		const response = await this.#makeRequest<
			{ ok: true; deleted: boolean } | { ok: false; error: string }
		>({
			method: 'DELETE',
			endpoint: 'delete',
			account: request.account,
			queryParams: { path: request.path },
			getSignedData: () => getKeetaStorageAnchorDeleteRequestSigningData({ path: request.path }),
			isResponse: isKeetaStorageAnchorDeleteResponse
		});

		this.logger?.debug(`Delete request successful for path: ${request.path}`);

		return(response.deleted);
	}

	/**
	 * Get (retrieve) an object by path.
	 * Data is automatically decrypted from the EncryptedContainer.
	 *
	 * @param path - The storage path (e.g., "/user/<publicKey>/myfile.txt")
	 * @param account - Optional account to use (for signing and decryption)
	 * @returns The decrypted data, mime-type, and metadata, or null if not found
	 */
	async get(
		path: string,
		account?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<{ data: Buffer; mimeType: string; metadata: StorageObjectMetadata } | null> {
		this.logger?.debug(`Getting object at path: ${path}`);

		const signerAccount = account ?? this.client.account;
		if (!signerAccount?.hasPrivateKey) {
			throw(new Errors.PrivateKeyRequired());
		}

		try {
			const response = await this.#makeRequest<
				{ ok: true; data: string; object: StorageObjectMetadata } | { ok: false; error: string }
			>({
				method: 'GET',
				endpoint: 'get',
				account: signerAccount,
				queryParams: { path },
				getSignedData: () => getKeetaStorageAnchorGetRequestSigningData({ path, account: signerAccount.publicKeyString.get() }),
				isResponse: isKeetaStorageAnchorGetResponse
			});

			// Decode the base64 EncryptedContainer
			const encodedData = Buffer.from(response.data, 'base64');

			// Decrypt the container
			const container = EncryptedContainer.fromEncryptedBuffer(encodedData, [signerAccount]);
			const plaintext = await container.getPlaintext();

			// Parse the payload to extract mime-type and content
			const payloadStr = Buffer.from(plaintext).toString('utf-8');
			let mimeType = 'application/octet-stream';

			let data: Buffer;
			try {
				const payload: unknown = JSON.parse(payloadStr);
				if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
					const payloadMime = 'mimeType' in payload ? payload.mimeType : undefined;
					const payloadData = 'data' in payload ? payload.data : undefined;
					if (typeof payloadMime === 'string') {
						mimeType = payloadMime;
					}
					if (typeof payloadData === 'string') {
						data = arrayBufferLikeToBuffer(Buffer.from(payloadData, 'base64'));
					} else {
						data = arrayBufferLikeToBuffer(plaintext);
					}
				} else {
					data = arrayBufferLikeToBuffer(plaintext);
				}
			} catch {
				// If not JSON, return raw plaintext as content
				data = arrayBufferLikeToBuffer(plaintext);
			}

			this.logger?.debug(`Get request successful for path: ${path}`);

			return({
				data,
				mimeType,
				metadata: response.object
			});
		} catch (e) {
			// Check if it's a "not found" error
			if (Errors.DocumentNotFound.isInstance(e)) {
				return(null);
			}
			throw(e);
		}
	}

	/**
	 * Put (create/update) an object.
	 * Data is automatically wrapped in an EncryptedContainer.
	 *
	 * @param path - The storage path (e.g., "/user/<publicKey>/myfile.txt")
	 * @param data - The data to store
	 * @param options - Options including mimeType, tags, visibility
	 * @param account - Optional account to use (for signing)
	 * @param anchorAccount - Optional anchor account (required for public objects)
	 */
	async put(
		path: string,
		data: Buffer,
		options: {
			mimeType: string;
			tags?: string[];
			visibility?: StorageObjectVisibility;
		},
		account?: InstanceType<typeof KeetaNetLib.Account>,
		anchorAccount?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<StorageObjectMetadata> {
		this.logger?.debug(`Putting object at path: ${path}`);

		const signerAccount = account ?? this.client.account;
		if (!signerAccount?.hasPrivateKey) {
			throw(new Errors.PrivateKeyRequired());
		}

		// Create payload with mime-type inside
		const payload = {
			mimeType: options.mimeType,
			data: data.toString('base64')
		};

		// Create EncryptedContainer
		const principals: InstanceType<typeof KeetaNetLib.Account>[] = [signerAccount];
		if (options.visibility === 'public' && anchorAccount) {
			principals.push(anchorAccount);
		}

		const container = EncryptedContainer.fromPlaintext(
			JSON.stringify(payload),
			principals,
			{ signer: signerAccount }
		);

		const encodedBuffer = await container.getEncodedBuffer();
		const encodedData = Buffer.from(encodedBuffer).toString('base64');

		const bodyToSend: { path: string; data: string; tags?: string[]; visibility?: StorageObjectVisibility; account?: InstanceType<typeof KeetaNetLib.Account> } = {
			path,
			data: encodedData,
			account: signerAccount
		};
		if (options.tags !== undefined) {
			bodyToSend.tags = options.tags;
		}
		if (options.visibility !== undefined) {
			bodyToSend.visibility = options.visibility;
		}

		const response = await this.#makeRequest<
			{ ok: true; object: StorageObjectMetadata } | { ok: false; error: string },
			{ path: string; data: string; tags?: string[]; visibility?: StorageObjectVisibility; account?: InstanceType<typeof KeetaNetLib.Account> },
			KeetaStorageAnchorPutRequest
		>({
			method: 'PUT',

			endpoint: 'put',
			account: signerAccount,
			serializeRequest(body) {
				const serialized: KeetaStorageAnchorPutRequest = {
					path: body.path,
					data: body.data
				};
				if (body.tags !== undefined) {
					serialized.tags = body.tags;
				}
				if (body.visibility !== undefined) {
					serialized.visibility = body.visibility;
				}
				if (body.account !== undefined) {
					serialized.account = body.account.assertAccount().publicKeyString.get();
				}
				return(serialized);
			},
			body: bodyToSend,
			getSignedData: getKeetaStorageAnchorPutRequestSigningData,
			isResponse: isKeetaStorageAnchorPutResponse
		});

		this.logger?.debug(`Put request successful for path: ${path}`);

		return(response.object);
	}

	/**
	 * Put data directly using owner's public key and relative path.
	 * Constructs the full path automatically.
	 */
	async putData(
		relativePath: string,
		data: Buffer,
		options: {
			mimeType: string;
			tags?: string[];
			visibility?: StorageObjectVisibility;
		},
		account?: InstanceType<typeof KeetaNetLib.Account>,
		anchorAccount?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<StorageObjectMetadata> {
		const signerAccount = account ?? this.client.account;
		const ownerPublicKey = signerAccount.publicKeyString.get();

		const fullPath = makeStoragePath(ownerPublicKey, relativePath);
		return(await this.put(fullPath, data, options, account, anchorAccount));
	}

	/**
	 * Search for objects matching criteria.
	 */
	async search(
		criteria: SearchCriteria,
		pagination?: SearchPagination,
		account?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<{ results: StorageObjectMetadata[]; nextCursor?: string }> {
		this.logger?.debug('Searching for objects');

		const signerAccount = account ?? this.client.account;
		const bodyToSend: { criteria: SearchCriteria; pagination?: SearchPagination; account?: InstanceType<typeof KeetaNetLib.Account> } = {
			criteria,
			account: signerAccount
		};
		if (pagination !== undefined) {
			bodyToSend.pagination = pagination;
		}

		const response = await this.#makeRequest<
			{ ok: true; results: StorageObjectMetadata[]; nextCursor?: string } | { ok: false; error: string },
			{ criteria: SearchCriteria; pagination?: SearchPagination; account?: InstanceType<typeof KeetaNetLib.Account> },
			KeetaStorageAnchorSearchRequest
		>({
			method: 'POST',
			endpoint: 'search',
			account: signerAccount,
			serializeRequest(body) {
				const serialized: KeetaStorageAnchorSearchRequest = {
					criteria: body.criteria
				};
				if (body.pagination !== undefined) {
					serialized.pagination = body.pagination;
				}
				if (body.account !== undefined) {
					serialized.account = body.account.assertAccount().publicKeyString.get();
				}
				return(serialized);
			},
			body: bodyToSend,
			getSignedData: getKeetaStorageAnchorSearchRequestSigningData,
			isResponse: isKeetaStorageAnchorSearchResponse
		});

		this.logger?.debug(`Search returned ${response.results.length} results`);

		return({
			results: response.results,
			...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {})
		});
	}

	/**
	 * Get quota status for the authenticated user.
	 */
	async getQuotaStatus(
		account?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<QuotaStatus> {
		this.logger?.debug('Getting quota status');

		const signerAccount = account ?? this.client.account;
		const response = await this.#makeRequest<
			{ ok: true; quota: QuotaStatus } | { ok: false; error: string },
			{ account?: InstanceType<typeof KeetaNetLib.Account> },
			KeetaStorageAnchorQuotaRequest
		>({
			method: 'GET',

			endpoint: 'quota',
			account: signerAccount,
			getSignedData: getKeetaStorageAnchorQuotaRequestSigningData,
			isResponse: isKeetaStorageAnchorQuotaResponse
		});

		this.logger?.debug('Quota status retrieved successfully');

		return(response.quota);
	}

	/**
	 * Generate a pre-signed URL for public access to an object.
	 * The URL is signed by the owner and has a limited lifetime.
	 *
	 * @param path - The path to the public object
	 * @param options - Options including TTL (time-to-live in seconds)
	 * @param account - The owner account (must have private key for signing)
	 */
	async getPublicUrl(
		path: string,
		options?: { ttl?: number },
		account?: InstanceType<typeof KeetaNetLib.Account>
	): Promise<string> {
		const signerAccount = account ?? this.client.account;
		if (!signerAccount?.hasPrivateKey) {
			throw(new Errors.PrivateKeyRequired());
		}

		const ttl = options?.ttl ?? 3600; // Default 1 hour
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;

		// Create signature message
		const message = `${path}:${expiresAt}`;
		const messageBuffer = Buffer.from(message, 'utf-8');

		// Sign the message
		const signatureResult = await signerAccount.sign(
			messageBuffer.buffer.slice(messageBuffer.byteOffset, messageBuffer.byteOffset + messageBuffer.byteLength)
		);

		let signature: Buffer;
		if (Buffer.isBuffer(signatureResult)) {
			signature = arrayBufferLikeToBuffer(signatureResult);
		} else if ('get' in signatureResult && typeof signatureResult.get === 'function') {
			signature = arrayBufferLikeToBuffer(signatureResult.get());
		} else {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			signature = arrayBufferLikeToBuffer(signatureResult as unknown as ArrayBuffer);
		}

		// Get base URL from service info
		const operationInfo = await this.serviceInfo.operations.public;
		if (!operationInfo) {
			throw(new Errors.ServiceUnavailable());
		}

		// Construct the public URL using the full operation URL, appending query params
		const publicUrl = new URL(operationInfo.url().href);
		publicUrl.searchParams.set('path', path);
		publicUrl.searchParams.set('signature', signature.toString('base64'));
		publicUrl.searchParams.set('expires', String(expiresAt));

		return(publicUrl.toString());
	}
}

class KeetaStorageAnchorClient extends KeetaStorageAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;
	readonly #signer: InstanceType<typeof KeetaNetLib.Account>;
	readonly #account: InstanceType<typeof KeetaNetLib.Account>;

	constructor(client: KeetaNetUserClient, config: KeetaStorageAnchorClientConfig = {}) {
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
			throw(new Errors.SignerRequired());
		}

		if (config.account) {
			this.#account = config.account;
		} else if ('account' in client) {
			this.#account = client.account;
		} else {
			throw(new Errors.AccountRequired());
		}
	}

	async #lookup(): Promise<KeetaStorageAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, this.logger);
		if (endpoints === null) {
			return(null);
		}

		const providers = Object.entries(endpoints).map(([id, serviceInfo]) => {
			return(new KeetaStorageAnchorProvider(serviceInfo, id, this));
		});

		return(providers);
	}

	/**
	 * Get all available storage providers
	 */
	async getProviders(): Promise<KeetaStorageAnchorProvider[] | null> {
		return(await this.#lookup());
	}

	/**
	 * Get a specific provider by ID
	 */
	async getProviderByID(providerID: string): Promise<KeetaStorageAnchorProvider | null> {
		const providers = await this.#lookup();
		if (!providers) {
			return(null);
		}

		const provider = providers.find(p => p.providerID === providerID);
		return(provider ?? null);
	}

	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaStorageAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			resolver: this.resolver,
			logger: this.logger,
			client: this.client,
			signer: this.#signer,
			account: this.#account
		});
	}
}

export default KeetaStorageAnchorClient;
export { KeetaStorageAnchorProvider };
