import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';
import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { KeetaNet } from '../../client/index.js';
import type { Logger } from '../../lib/log/index.ts';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType, ServiceMetadataEndpoint } from '../../lib/resolver.ts';
import type { Signable } from '../../lib/utils/signing.js';
import type { Buffer } from '../../lib/utils/buffer.js';
import type {
	StorageObjectMetadata,
	SearchCriteria,
	SearchPagination,
	QuotaStatus,
	StorageObjectVisibility,
	KeetaStorageAnchorDeleteClientRequest,
	KeetaStorageAnchorSearchRequest,
	KeetaStorageAnchorQuotaRequest
} from './common.ts';
import {
	isKeetaStorageAnchorDeleteResponse,
	isKeetaStorageAnchorPutResponse,
	isKeetaStorageAnchorSearchResponse,
	isKeetaStorageAnchorQuotaResponse,
	getKeetaStorageAnchorDeleteRequestSigningData,
	getKeetaStorageAnchorPutRequestSigningData,
	getKeetaStorageAnchorGetRequestSigningData,
	getKeetaStorageAnchorSearchRequestSigningData,
	getKeetaStorageAnchorQuotaRequestSigningData,
	parseContainerPayload,
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
import { arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';

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
 * Configuration for a storage session.
 * Sessions provide a simplified API with default account, working directory, and visibility.
 */
export type SessionConfig = {
	/**
	 * The account to use for all operations in this session.
	 */
	account: InstanceType<typeof KeetaNetLib.Account>;
	/**
	 * Optional working directory prefix for relative paths.
	 * e.g., '/user/pubkey/docs/' - relative paths will be appended to this.
	 */
	workingDirectory?: string;
	/**
	 * Default visibility for put operations (defaults to 'private').
	 */
	defaultVisibility?: StorageObjectVisibility;
};

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
	/**
	 * The anchor's public key string (for converting to Account object).
	 */
	anchorAccountPublicKey?: string;
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
		throw(new Errors.InvalidPath('Invalid URL: null or undefined'));
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

		// Extract anchor account public key from service metadata
		const result: KeetaStorageServiceInfo = { operations: operationsFunctions };
		if ('anchorAccount' in serviceInfo && typeof serviceInfo.anchorAccount === 'function') {
			const anchorAccountValue = await serviceInfo.anchorAccount('primitive');
			if (typeof anchorAccountValue === 'string') {
				result.anchorAccountPublicKey = anchorAccountValue;
			}
		}

		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as unknown as ProviderID,
			result
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
 * A session provides a simplified API for storage operations with default account,
 * working directory, and visibility settings.
 */
export class KeetaStorageAnchorSession {
	readonly provider: KeetaStorageAnchorProvider;
	readonly account: InstanceType<typeof KeetaNetLib.Account>;
	readonly workingDirectory: string;
	readonly #defaultVisibility: StorageObjectVisibility;

	constructor(provider: KeetaStorageAnchorProvider, config: SessionConfig) {
		this.provider = provider;
		this.account = config.account;
		this.workingDirectory = config.workingDirectory ?? '/';
		this.#defaultVisibility = config.defaultVisibility ?? 'private';
	}

	/**
	 * Resolve a relative path to a full storage path.
	 */
	#resolvePath(relativePath: string): string {
		// If path is already absolute (starts with /), use it as-is
		if (relativePath.startsWith('/')) {
			return(relativePath);
		}

		// Otherwise, prepend working directory
		return(this.workingDirectory + relativePath);
	}

	/**
	 * Store data at a relative path.
	 * For public visibility, the anchor account is automatically fetched from the provider.
	 */
	async put(
		relativePath: string,
		data: Buffer,
		options: {
			mimeType: string;
			tags?: string[];
			visibility?: StorageObjectVisibility;
		}
	): Promise<StorageObjectMetadata> {
		const fullPath = this.#resolvePath(relativePath);
		const visibility = options.visibility ?? this.#defaultVisibility;
		const putOpts: Parameters<typeof this.provider.put>[0] = {
			path: fullPath,
			data,
			mimeType: options.mimeType,
			visibility,
			account: this.account
		};
		if (options.tags) {
			putOpts.tags = options.tags;
		}
		if (visibility === 'public' && this.provider.anchorAccount) {
			putOpts.anchorAccount = this.provider.anchorAccount;
		}
		return(await this.provider.put(putOpts));
	}

	/**
	 * Get data from a relative path.
	 */
	async get(relativePath: string): Promise<{ data: Buffer; mimeType: string } | null> {
		const fullPath = this.#resolvePath(relativePath);
		return(await this.provider.get({ path: fullPath, account: this.account }));
	}

	/**
	 * Delete data at a relative path.
	 */
	async delete(relativePath: string): Promise<boolean> {
		const fullPath = this.#resolvePath(relativePath);
		return(await this.provider.delete({ path: fullPath, account: this.account }));
	}

	/**
	 * Search for objects. Owner is automatically set to the session account.
	 */
	async search(
		criteria?: Omit<SearchCriteria, 'owner'>,
		pagination?: SearchPagination
	): Promise<{ results: StorageObjectMetadata[]; nextCursor?: string }> {
		const fullCriteria: SearchCriteria = {
			...criteria,
			owner: this.account.publicKeyString.get()
		};

		const searchOpts: Parameters<typeof this.provider.search>[0] = {
			criteria: fullCriteria,
			account: this.account
		};
		if (pagination) {
			searchOpts.pagination = pagination;
		}

		return(await this.provider.search(searchOpts));
	}

	/**
	 * Get a pre-signed public URL for a relative path.
	 */
	async getPublicUrl(relativePath: string, options?: { ttl?: number }): Promise<string> {
		const fullPath = this.#resolvePath(relativePath);
		const urlOpts: Parameters<typeof this.provider.getPublicUrl>[0] = {
			path: fullPath,
			account: this.account
		};
		if (options?.ttl) {
			urlOpts.ttl = options.ttl;
		}

		return(await this.provider.getPublicUrl(urlOpts));
	}
}

/**
 * Represents a Storage Anchor provider for performing storage operations.
 */
export class KeetaStorageAnchorProvider extends KeetaStorageAnchorBase {
	/**
	 * Service information including available operations and endpoints.
	 */
	readonly serviceInfo: KeetaStorageServiceInfo;
	/**
	 * Unique identifier for this provider.
	 */
	readonly providerID: ProviderID;
	/**
	 * The anchor account for this provider.
	 */
	readonly anchorAccount: InstanceType<typeof KeetaNetLib.Account> | null;

	constructor(serviceInfo: KeetaStorageServiceInfo, providerID: ProviderID, parent: KeetaStorageAnchorClient) {
		const parentPrivate = parent._internals(KeetaStorageAnchorClientAccessToken);
		super(parentPrivate);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;

		// Convert anchor account public key string to Account
		if (serviceInfo.anchorAccountPublicKey) {
			try {
				this.anchorAccount = KeetaNet.lib.Account.fromPublicKeyString(serviceInfo.anchorAccountPublicKey).assertAccount();
			} catch {
				throw(new Errors.InvalidAnchorAccount(serviceInfo.anchorAccountPublicKey));
			}
		} else {
			this.anchorAccount = null;
		}
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
			throw(new Error('invariant: expected error response object'));
		}

		if (!('ok' in data) || data.ok !== false) {
			throw(new Error('invariant: expected error response with ok=false'));
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

	/**
	 * Resolve account to use for signing, with private key validation.
	 * @param account - Optional account override
	 * @param requirePrivateKey - Whether private key is required (default: true)
	 * @returns Resolved account
	 * @throws PrivateKeyRequired if private key is needed but not available
	 */
	#resolveSignerAccount(
		account: InstanceType<typeof KeetaNetLib.Account> | undefined,
		requirePrivateKey = true
	): InstanceType<typeof KeetaNetLib.Account> {
		const resolved = account ?? this.client.account;
		if (requirePrivateKey && !resolved?.hasPrivateKey) {
			throw(new Errors.PrivateKeyRequired());
		}
		if (!resolved) {
			throw(new Errors.AccountRequired());
		}

		return(resolved);
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
		pathSuffix?: string | undefined;
		body?: Request | undefined;
		serializeRequest?: (body: Request) => (SerializedRequest | Promise<Omit<SerializedRequest, 'signed'>>);
		getSignedData?: (request: SerializedRequest) => Signable;
		isResponse: (data: unknown) => data is Response;
	}): Promise<Extract<Response, { ok: true }>> {
		const { url, auth } = await this.#getOperationData(input.endpoint, input.params);

		// Append path suffix to URL pathname if provided
		if (input.pathSuffix) {
			// Remove leading slash from suffix if URL already ends with one
			const suffix = input.pathSuffix.startsWith('/') ? input.pathSuffix.slice(1) : input.pathSuffix;
			url.pathname = url.pathname.replace(/\/$/, '') + '/' + suffix;
		}

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
				throw(new Error('invariant: getSignedData required for signed requests'));
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
				throw(new Error('invariant: body cannot be sent with GET/DELETE requests'));
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
	 * Make a PUT request with raw binary body
	 */
	async #makeBinaryPutRequest(input: {
		path: string;
		data: Buffer;
		visibility?: StorageObjectVisibility;
		tags?: string[];
		account: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<{ ok: true; object: StorageObjectMetadata }> {
		const { url, auth } = await this.#getOperationData('put');

		// Append path to URL pathname
		const pathSuffix = input.path.startsWith('/') ? input.path.slice(1) : input.path;
		url.pathname = url.pathname.replace(/\/$/, '') + '/' + pathSuffix;

		if (auth.type === 'required' && !input.account) {
			throw(new Errors.AccountRequired());
		}

		// Sign the request
		const visibility = input.visibility ?? 'private';
		const tags = input.tags ?? [];
		const signable = getKeetaStorageAnchorPutRequestSigningData({ path: input.path, visibility, tags });
		const signed = await SignData(input.account.assertAccount(), signable);

		// Add auth to query params using helper (consistent with GET)
		const signedUrl = addSignatureToURL(url, { signedField: signed, account: input.account.assertAccount() });
		signedUrl.searchParams.set('visibility', visibility);
		if (tags.length > 0) {
			signedUrl.searchParams.set('tags', tags.join(','));
		}

		const response = await fetch(signedUrl, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
			body: input.data
		});

		if (!response.ok) {
			// Try to parse error as JSON (consistent with GET error handling)
			try {
				const errorJSON: unknown = await response.json();
				if (typeof errorJSON === 'object' && errorJSON !== null && 'ok' in errorJSON && errorJSON.ok === false) {
					throw(await this.#parseResponseError(errorJSON));
				}
			} catch (e) {
				// Re-throw if it's already a parsed error
				if (KeetaAnchorError.isInstance(e)) {
					throw(e);
				}

				// If JSON parsing fails, throw generic error
				throw(new Errors.InvalidResponse(`HTTP ${response.status}: ${response.statusText}`));
			}

			// If we got here, JSON parsed but didn't have expected error format
			throw(new Errors.InvalidResponse(`HTTP ${response.status}: ${response.statusText}`));
		}

		const responseJSON: unknown = await response.json();
		if (!isKeetaStorageAnchorPutResponse(responseJSON)) {
			throw(new Errors.InvalidResponse(JSON.stringify(responseJSON)));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return(responseJSON);
	}

	/**
	 * Make a GET request that returns raw binary data
	 */
	async #makeBinaryGetRequest(input: {
		path: string;
		account: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<Buffer> {
		const { url, auth } = await this.#getOperationData('get');

		// Append path to URL pathname
		const pathSuffix = input.path.startsWith('/') ? input.path.slice(1) : input.path;
		url.pathname = url.pathname.replace(/\/$/, '') + '/' + pathSuffix;

		if (auth.type === 'required' && !input.account) {
			throw(new Errors.AccountRequired());
		}

		// Sign the request
		const signable = getKeetaStorageAnchorGetRequestSigningData({ path: input.path, account: input.account.publicKeyString.get() });
		const signed = await SignData(input.account.assertAccount(), signable);

		// Add auth to query params
		const signedUrl = addSignatureToURL(url, { signedField: signed, account: input.account.assertAccount() });
		const response = await fetch(signedUrl, {
			method: 'GET',
			headers: { 'Accept': 'application/octet-stream' }
		});

		if (!response.ok) {
			// Try to parse error as JSON
			try {
				const errorJSON: unknown = await response.json();
				if (typeof errorJSON === 'object' && errorJSON !== null && 'ok' in errorJSON && errorJSON.ok === false) {
					throw(await this.#parseResponseError(errorJSON));
				}
			} catch (e) {
				// Re-throw if it's already a parsed error
				if (KeetaAnchorError.isInstance(e)) {
					throw(e);
				}

				// If JSON parsing fails, throw generic error
				throw(new Errors.InvalidResponse(`HTTP ${response.status}: ${response.statusText}`));
			}

			// If we got here, JSON parsed but didn't have expected error format
			throw(new Errors.InvalidResponse(`HTTP ${response.status}: ${response.statusText}`));
		}

		const arrayBuffer = await response.arrayBuffer();
		return(arrayBufferLikeToBuffer(arrayBuffer));
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
			pathSuffix: request.path,
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
	 * @param options.path - The storage path (e.g., "/user/<publicKey>/myfile.txt")
	 * @param options.account - Optional account to use (for signing and decryption)
	 *
	 * @returns The decrypted data and mime-type, or null if not found
	 */
	async get(options: {
		path: string;
		account?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<{ data: Buffer; mimeType: string } | null> {
		const { path } = options;
		this.logger?.debug(`Getting object at path: ${path}`);

		const signerAccount = this.#resolveSignerAccount(options.account);
		try {
			// Get raw binary data (EncryptedContainer)
			const encodedData = await this.#makeBinaryGetRequest({
				path,
				account: signerAccount
			});

			// Decrypt the container
			const container = EncryptedContainer.fromEncryptedBuffer(encodedData, [signerAccount]);
			const plaintext = await container.getPlaintext();
			// Parse the payload to extract mime-type and content
			const { mimeType, content: data } = parseContainerPayload(plaintext);

			this.logger?.debug(`Get request successful for path: ${path}`);

			return({
				data,
				mimeType
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
	 * Get metadata for an object by path.
	 *
	 * @param options.path - The storage path (e.g., "/user/<publicKey>/myfile.txt")
	 * @param options.account - Optional account to use (for signing)
	 * @returns The object metadata, or null if not found
	 */
	async getMetadata(options: {
		path: string;
		account?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<StorageObjectMetadata | null> {
		const { path } = options;
		this.logger?.debug(`Getting metadata at path: ${path}`);

		const signerAccount = this.#resolveSignerAccount(options.account);
		try {
			const response = await this.#makeRequest<
				{ ok: true; object: StorageObjectMetadata } | { ok: false; error: string }
			>({
				method: 'GET',
				endpoint: 'metadata',
				account: signerAccount,
				pathSuffix: path,
				getSignedData: () => getKeetaStorageAnchorGetRequestSigningData({ path, account: signerAccount.publicKeyString.get() }),
				isResponse: function(data: unknown): data is ({ ok: true; object: StorageObjectMetadata } | { ok: false; error: string }) {
					return(typeof data === 'object' && data !== null && 'ok' in data);
				}
			});

			this.logger?.debug(`Get metadata successful for path: ${path}`);

			return(response.object);
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
	 * @param options.path - The storage path (e.g., "/user/<publicKey>/myfile.txt")
	 * @param options.data - The data to store
	 * @param options.mimeType - MIME type of the data
	 * @param options.tags - Optional tags for the object
	 * @param options.visibility - Optional visibility ('private' or 'public')
	 * @param options.account - Optional account to use (for signing)
	 * @param options.anchorAccount - Optional anchor account (required for public objects)
	 */
	async put(options: {
		path: string;
		data: Buffer;
		mimeType: string;
		tags?: string[];
		visibility?: StorageObjectVisibility;
		account?: InstanceType<typeof KeetaNetLib.Account>;
		anchorAccount?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<StorageObjectMetadata> {
		const { path, data, mimeType, tags, visibility, anchorAccount } = options;
		this.logger?.debug(`Putting object at path: ${path}`);

		const signerAccount = this.#resolveSignerAccount(options.account);

		// Create payload with mime-type inside
		const payload = {
			mimeType,
			data: data.toString('base64')
		};

		// Create EncryptedContainer with appropriate principals
		const principals: InstanceType<typeof KeetaNetLib.Account>[] = [signerAccount];
		if (visibility === 'public') {
			if (!anchorAccount) {
				throw(new Errors.AccountRequired('anchorAccount is required for public visibility so the server can decrypt and serve the object'));
			}
			principals.push(anchorAccount);
		}

		const container = EncryptedContainer.fromPlaintext(
			JSON.stringify(payload),
			principals,
			{ signer: signerAccount }
		);

		const encodedBuffer = await container.getEncodedBuffer();
		const binaryData = arrayBufferLikeToBuffer(encodedBuffer);
		const putInput: {
			path: string;
			data: Buffer;
			visibility?: StorageObjectVisibility;
			tags?: string[];
			account: InstanceType<typeof KeetaNetLib.Account>;
		} = {
			path,
			data: binaryData,
			account: signerAccount
		};
		if (visibility !== undefined) {
			putInput.visibility = visibility;
		}
		if (tags !== undefined) {
			putInput.tags = tags;
		}

		const response = await this.#makeBinaryPutRequest(putInput);

		this.logger?.debug(`Put request successful for path: ${path}`);

		return(response.object);
	}

	/**
	 * Search for objects matching criteria.
	 *
	 * @param options.criteria - Search criteria
	 * @param options.pagination - Optional pagination settings
	 * @param options.account - Optional account to use
	 */
	async search(options: {
		criteria: SearchCriteria;
		pagination?: SearchPagination;
		account?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<{ results: StorageObjectMetadata[]; nextCursor?: string }> {
		const { criteria, pagination } = options;
		this.logger?.debug('Searching for objects');

		const signerAccount = this.#resolveSignerAccount(options.account, false);
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
	 *
	 * @param options.account - Optional account to use
	 */
	async getQuotaStatus(options?: {
		account?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<QuotaStatus> {
		this.logger?.debug('Getting quota status');

		const signerAccount = this.#resolveSignerAccount(options?.account, false);
		const response = await this.#makeRequest<
			{ ok: true; quota: QuotaStatus } | { ok: false; error: string },
			{ account?: InstanceType<typeof KeetaNetLib.Account> },
			KeetaStorageAnchorQuotaRequest
		>({
			method: 'GET',

			endpoint: 'quota',
			account: signerAccount,
			getSignedData: () => getKeetaStorageAnchorQuotaRequestSigningData({}),
			isResponse: isKeetaStorageAnchorQuotaResponse
		});

		this.logger?.debug('Quota status retrieved successfully');

		return(response.quota);
	}

	/**
	 * Generate a pre-signed URL for public access to an object.
	 * The URL is signed by the owner and has a limited lifetime.
	 *
	 * @param options.path - The path to the public object
	 * @param options.ttl - TTL (time-to-live in seconds), defaults to 1 hour
	 * @param options.account - The owner account (must have private key for signing)
	 */
	async getPublicUrl(options: {
		path: string;
		ttl?: number;
		account?: InstanceType<typeof KeetaNetLib.Account>;
	}): Promise<string> {
		const { path } = options;
		const signerAccount = this.#resolveSignerAccount(options.account);

		const ttl = options.ttl ?? 3600; // Default 1 hour
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;

		// Sign the message
		const signed = await SignData(signerAccount.assertAccount(), [path, expiresAt]);

		// Get base URL from service info
		const operationInfo = await this.serviceInfo.operations.public;
		if (!operationInfo) {
			throw(new Errors.ServiceUnavailable());
		}

		// Construct the public URL with path in pathname
		const publicUrl = new URL(operationInfo.url().href);
		// Append path to URL pathname (remove leading slash from path if URL already ends with one)
		const pathSuffix = path.startsWith('/') ? path.slice(1) : path;
		publicUrl.pathname = publicUrl.pathname.replace(/\/$/, '') + '/' + pathSuffix;
		publicUrl.searchParams.set('expires', String(expiresAt));
		publicUrl.searchParams.set('nonce', signed.nonce);
		publicUrl.searchParams.set('timestamp', signed.timestamp);
		publicUrl.searchParams.set('signature', signed.signature);

		return(publicUrl.toString());
	}

	/**
	 * Create a session.
	 */
	beginSession(config: SessionConfig): KeetaStorageAnchorSession {
		return(new KeetaStorageAnchorSession(this, config));
	}

	/**
	 * Execute a function within a session scope.
	 */
	async withSession<T>(config: SessionConfig, fn: (session: KeetaStorageAnchorSession) => Promise<T>): Promise<T> {
		const session = this.beginSession(config);
		return(await fn(session));
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
			throw(new Error('invariant: invalid internal access token'));
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
