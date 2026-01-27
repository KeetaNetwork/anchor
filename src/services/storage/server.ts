import type { ServiceMetadata } from '../../lib/resolver.ts';
import type { Signable } from '../../lib/utils/signing.js';
import type { NamespaceValidator } from './lib/validators.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import { KeetaNet } from '../../client/index.js';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type {
	KeetaStorageAnchorDeleteResponse,
	KeetaStorageAnchorPutResponse,
	KeetaStorageAnchorGetResponse,
	KeetaStorageAnchorSearchResponse,
	KeetaStorageAnchorQuotaResponse,
	StorageBackend,
	QuotaConfig,
	StorageObjectVisibility
} from './common.ts';
import {
	assertKeetaStorageAnchorDeleteResponse,
	assertKeetaStorageAnchorPutRequest,
	assertKeetaStorageAnchorPutResponse,
	assertKeetaStorageAnchorGetRequest,
	assertKeetaStorageAnchorGetResponse,
	assertKeetaStorageAnchorSearchRequest,
	assertKeetaStorageAnchorSearchResponse,
	assertKeetaStorageAnchorQuotaResponse,
	getKeetaStorageAnchorDeleteRequestSigningData,
	getKeetaStorageAnchorPutRequestSigningData,
	getKeetaStorageAnchorGetRequestSigningData,
	getKeetaStorageAnchorSearchRequestSigningData,
	getKeetaStorageAnchorQuotaRequestSigningData,
	validateStoragePath,
	isValidStoragePath,
	parseContainerPayload,
	Errors
} from './common.js';
import { VerifySignedData } from '../../lib/utils/signing.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server/common.js';
import { Buffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';
import { requiresValidation, findMatchingValidators, defaultValidators } from './lib/validators.js';
import { EncryptedContainer, EncryptedContainerError } from '../../lib/encrypted-container.js';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

export interface KeetaAnchorStorageServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The storage backend to use for storing documents
	 */
	backend: StorageBackend;

	/**
	 * The anchor's account WITH PRIVATE KEY for decrypting public objects.
	 * This account must have hasPrivateKey=true.
	 */
	anchorAccount?: Account;

	/**
	 * Quota configuration for storage limits
	 */
	quotas?: QuotaConfig;

	/**
	 * Namespace validators for special paths
	 */
	validators?: NamespaceValidator[];

	/**
	 * Default TTL in seconds for pre-signed URLs (default: 3600)
	 */
	signedUrlDefaultTTL?: number;
}

// Default quota configuration
const DEFAULT_QUOTAS: QuotaConfig = {
	maxObjectSize: 10 * 1024 * 1024, // 10MB
	maxObjectsPerUser: 1000,
	maxStoragePerUser: 100 * 1024 * 1024, // 100MB
	maxSearchLimit: 100
};

export class KeetaNetStorageAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorStorageServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorStorageServerConfig['homepage']>;
	readonly backend: StorageBackend;
	readonly anchorAccount: Account | undefined;
	readonly quotas: QuotaConfig;
	readonly validators: NamespaceValidator[];
	readonly signedUrlDefaultTTL: number;

	constructor(config: KeetaAnchorStorageServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.backend = config.backend;
		this.anchorAccount = config.anchorAccount;
		this.quotas = config.quotas ?? DEFAULT_QUOTAS;
		this.validators = config.validators ?? defaultValidators;
		this.signedUrlDefaultTTL = config.signedUrlDefaultTTL ?? 3600;
	}

	// Note: We use this.* properties instead of config.*.
	// The config parameter is required by the abstract method signature but unused here.
	protected async initRoutes(_ignoreConfig: KeetaAnchorStorageServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {};
		const backend = this.backend;
		const anchorAccount = this.anchorAccount;
		const quotas = this.quotas;
		const validators = this.validators;

		// #region Authentication Helpers

		/**
		 * Verify a signed request from POST body.
		 * Returns the authenticated account on success, throws on failure.
		 */
		async function verifyBodyAuth<T extends { account?: string; signed?: unknown }>(
			request: T,
			getSigningData: (req: T) => Signable
		): Promise<Account> {
			if (!request.account || !request.signed) {
				throw(new KeetaAnchorUserError('Authentication required'));
			}

			const account = KeetaNet.lib.Account.fromPublicKeyString(request.account).assertAccount();
			const signable = getSigningData(request);
			const signed = assertHTTPSignedField(request.signed);

			const valid = await VerifySignedData(account, signable, signed);
			if (!valid) {
				throw(new KeetaAnchorUserError('Invalid signature'));
			}

			return(account);
		}

		/**
		 * Verify a signed request from URL query parameters.
		 * Returns the authenticated account on success, throws on failure.
		 */
		async function verifyURLAuth<T>(
			url: URL | string,
			getSigningData: (req: T) => Signable,
			buildRequest: (accountPubKey: string) => T
		): Promise<Account> {
			const urlString = typeof url === 'string' ? url : url.href;
			const parsed = parseSignatureFromURL(urlString);
			if (!parsed.account || !parsed.signedField) {
				throw(new KeetaAnchorUserError('Authentication required'));
			}

			const request = buildRequest(parsed.account.publicKeyString.get());
			const signable = getSigningData(request);

			const valid = await VerifySignedData(parsed.account, signable, parsed.signedField);
			if (!valid) {
				throw(new KeetaAnchorUserError('Invalid signature'));
			}

			return(parsed.account);
		}

		// #endregion

		/**
		 * If a homepage is provided, setup the route for it
		 */
		const homepage = this.homepage;
		if (homepage) {
			routes['GET /'] = async function() {
				const homepageData = typeof homepage === 'string' ? homepage : await homepage();
				return({
					output: homepageData,
					contentType: 'text/html'
				});
			};
		}

		// #region API Routes

		// PUT /api/object - Create or update an object
		routes['PUT /api/object'] = async function(_params, postData) {
			const request = assertKeetaStorageAnchorPutRequest(postData);
			const account = await verifyBodyAuth(request, getKeetaStorageAnchorPutRequestSigningData);

			// Validate path format and ownership
			const pathInfo = validateStoragePath(request.path);
			if (pathInfo.owner !== account.publicKeyString.get()) {
				throw(new Errors.AccessDenied('Can only write to your own namespace'));
			}

			// Decode base64 data to get actual stored object size
			const data = Buffer.from(request.data, 'base64');
			const objectSize = data.byteLength;

			// Check max object size
			if (objectSize > quotas.maxObjectSize) {
				throw(new Errors.QuotaExceeded(`Object too large: ${objectSize} bytes exceeds limit of ${quotas.maxObjectSize}`));
			}

			const visibility: StorageObjectVisibility = request.visibility ?? 'private';
			const needsValidation = requiresValidation(request.path, validators);
			const needsAnchorDecryption = needsValidation || visibility === 'public';

			// Validate encrypted container if needed
			if (needsAnchorDecryption) {
				if (!anchorAccount?.hasPrivateKey) {
					throw(new KeetaAnchorUserError(
						needsValidation
							? 'Anchor account with private key required for namespace validation'
							: 'Anchor account with private key required for public objects'
					));
				}

				try {
					const container = EncryptedContainer.fromEncryptedBuffer(data, [anchorAccount]);
					const plaintext = await container.getPlaintext();

					if (needsValidation) {
						const { mimeType, content } = parseContainerPayload(plaintext);
						const matchingValidators = findMatchingValidators(request.path, validators);
						for (const validator of matchingValidators) {
							const result = await validator.validate(request.path, content, mimeType);
							if (!result.valid) {
								throw(new Errors.ValidationFailed(result.error));
							}
						}
					}
				} catch (e) {
					if (Errors.ValidationFailed.isInstance(e)) {
						throw(e);
					}
					if (EncryptedContainerError.isInstance(e)) {
						if (e.code.startsWith('MALFORMED_')) {
							throw(new Errors.ValidationFailed(`Invalid encrypted container: ${e.message}`));
						}
						if (e.code === 'NO_MATCHING_KEY' || e.code === 'DECRYPTION_FAILED') {
							throw(new Errors.AnchorPrincipalRequired());
						}
					}
					throw(e);
				}
			}

			const objectMetadata = await backend.withAtomic(async (atomic) => {
				// Check if object already exists
				const existing = await atomic.get(pathInfo.path);
				const existingSize = existing ? parseInt(existing.metadata.size, 10) : 0;
				const isNewObject = !existing;

				// Get quota status
				const quotaStatus = await atomic.getQuotaStatus(pathInfo.owner);

				// Object count check - only reject for new objects
				if (isNewObject && quotaStatus.objectCount >= quotas.maxObjectsPerUser) {
					throw(new Errors.QuotaExceeded('Maximum number of objects reached'));
				}

				// Size check - use delta for updates
				const sizeDelta = objectSize - existingSize;
				if (quotaStatus.totalSize + sizeDelta > quotas.maxStoragePerUser) {
					throw(new Errors.QuotaExceeded('Storage quota exceeded'));
				}

				return(await atomic.put(pathInfo.path, data, {
					owner: pathInfo.owner,
					tags: request.tags ?? [],
					visibility
				}));
			});

			const response: KeetaStorageAnchorPutResponse = {
				ok: true,
				object: objectMetadata
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorPutResponse(response))
			});
		};

		// GET /api/object - Retrieve an object
		routes['GET /api/object'] = async function(_params, _postData, _headers, url) {
			const parsedUrl = new URL(url);
			const objectPath = parsedUrl.searchParams.get('path');
			if (!objectPath) {
				throw(new Errors.InvalidPath());
			}

			const pathInfo = validateStoragePath(objectPath);

			// Handle authentication and verify ownership
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorGetRequestSigningData,
				(accountPubKey) => assertKeetaStorageAnchorGetRequest({ path: pathInfo.path, account: accountPubKey })
			);

			if (pathInfo.owner !== account.publicKeyString.get()) {
				throw(new Errors.AccessDenied('Can only read objects in your own namespace'));
			}

			const result = await backend.get(pathInfo.path);
			if (!result) {
				throw(new Errors.DocumentNotFound());
			}

			const response: KeetaStorageAnchorGetResponse = {
				ok: true,
				data: result.data.toString('base64'),
				object: result.metadata
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorGetResponse(response))
			});
		};

		// DELETE /api/object - Delete an object
		routes['DELETE /api/object'] = async function(_params, _postData, _headers, url) {
			const parsedUrl = new URL(url);
			const objectPath = parsedUrl.searchParams.get('path');
			if (!objectPath || !isValidStoragePath(objectPath)) {
				throw(new Errors.InvalidPath());
			}

			// Handle authentication and verify ownership
			const pathInfo = validateStoragePath(objectPath);
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorDeleteRequestSigningData,
				(accountPubKey) => ({ path: objectPath, account: accountPubKey })
			);

			if (pathInfo.owner !== account.publicKeyString.get()) {
				throw(new Errors.AccessDenied('Can only delete objects in your own namespace'));
			}

			const deleted = await backend.delete(pathInfo.path);
			const response: KeetaStorageAnchorDeleteResponse = {
				ok: true,
				deleted
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorDeleteResponse(response))
			});
		};

		// POST /api/search - Search for objects
		routes['POST /api/search'] = async function(_params, postData) {
			const request = assertKeetaStorageAnchorSearchRequest(postData);
			const account = await verifyBodyAuth(request, getKeetaStorageAnchorSearchRequestSigningData);

			const accountPubKey = account.publicKeyString.get();
			const userNamespacePrefix = `/user/${accountPubKey}/`;

			// Validate owner: default if omitted, reject if mismatched
			if (request.criteria.owner !== undefined && request.criteria.owner !== accountPubKey) {
				throw(new Errors.AccessDenied('Can only search your own namespace'));
			}

			// Validate pathPrefix is within caller's namespace (if provided)
			if (request.criteria.pathPrefix !== undefined && !request.criteria.pathPrefix.startsWith(userNamespacePrefix)) {
				throw(new Errors.AccessDenied('Can only search within your own namespace'));
			}

			// Scope criteria to authenticated account
			const scopedCriteria = {
				...request.criteria,
				owner: accountPubKey
			};

			// Enforce server-side limit cap
			const requestedLimit = request.pagination?.limit ?? quotas.maxSearchLimit;
			const effectiveLimit = Math.min(requestedLimit, quotas.maxSearchLimit);

			const results = await backend.search(
				scopedCriteria,
				{ ...request.pagination, limit: effectiveLimit }
			);

			const response: KeetaStorageAnchorSearchResponse = {
				ok: true,
				results: results.results,
				...(results.nextCursor !== undefined ? { nextCursor: results.nextCursor } : {})
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorSearchResponse(response))
			});
		};

		// GET /api/quota - Get quota status
		routes['GET /api/quota'] = async function(_params, _postData, _headers, url) {
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorQuotaRequestSigningData,
				() => ({})
			);

			// Get current usage from backend and compute remaining using server's quota config
			const backendStatus = await backend.getQuotaStatus(account.publicKeyString.get());
			const response: KeetaStorageAnchorQuotaResponse = {
				ok: true,
				quota: {
					objectCount: backendStatus.objectCount,
					totalSize: backendStatus.totalSize,
					remainingObjects: quotas.maxObjectsPerUser - backendStatus.objectCount,
					remainingSize: quotas.maxStoragePerUser - backendStatus.totalSize
				}
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorQuotaResponse(response))
			});
		};

		// GET /api/public - Public object access via pre-signed URL
		routes['GET /api/public'] = async function(_params, _postData, _headers, url) {
			const parsedUrl = new URL(url);
			const objectPath = parsedUrl.searchParams.get('path');
			if (!objectPath || !isValidStoragePath(objectPath)) {
				throw(new Errors.InvalidPath());
			}

			// Get signature and expiry from query params
			const signature = parsedUrl.searchParams.get('signature');
			const expires = parsedUrl.searchParams.get('expires');

			if (!signature || !expires) {
				throw(new Errors.SignatureInvalid('Missing signature or expires parameter'));
			}

			// Check expiry
			const expiresAt = parseInt(expires, 10);
			if (Date.now() > expiresAt * 1000) {
				throw(new Errors.SignatureExpired());
			}

			// Verify signature
			const pathInfo = validateStoragePath(objectPath);
			const ownerAccount = KeetaNet.lib.Account.fromPublicKeyString(pathInfo.owner).assertAccount();
			const message = `${objectPath}:${expires}`;
			const signatureBuffer = Buffer.from(signature, 'base64');
			const messageBuffer = Buffer.from(message, 'utf-8');

			const validSig = ownerAccount.verify(
				messageBuffer.buffer.slice(messageBuffer.byteOffset, messageBuffer.byteOffset + messageBuffer.byteLength),
				signatureBuffer.buffer.slice(signatureBuffer.byteOffset, signatureBuffer.byteOffset + signatureBuffer.byteLength)
			);
			if (!validSig) {
				throw(new Errors.SignatureInvalid());
			}

			// Get the object
			const result = await backend.get(pathInfo.path);
			if (!result) {
				throw(new Errors.DocumentNotFound());
			}

			// Check visibility
			if (result.metadata.visibility !== 'public') {
				throw(new Errors.AccessDenied('Object is not public'));
			}

			// Decrypt using anchor account
			if (!anchorAccount?.hasPrivateKey) {
				throw(new KeetaAnchorUserError('Anchor account not configured for public object serving'));
			}

			const data = arrayBufferLikeToBuffer(result.data);
			const container = EncryptedContainer.fromEncryptedBuffer(data, [anchorAccount]);
			const plaintext = await container.getPlaintext();
			const { mimeType, content } = parseContainerPayload(plaintext);

			return({
				output: content,
				contentType: mimeType
			});
		};

		// #endregion

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['storage']>[string]> {
		const authRequired = { options: { authentication: { type: 'required' as const, method: 'keeta-account' as const }}};
		const operations: NonNullable<ServiceMetadata['services']['storage']>[string]['operations'] = {
			put: { url: (new URL('/api/object', this.url)).toString(), ...authRequired },
			get: { url: (new URL('/api/object', this.url)).toString(), ...authRequired },
			delete: { url: (new URL('/api/object', this.url)).toString(), ...authRequired },
			search: { url: (new URL('/api/search', this.url)).toString(), ...authRequired },
			public: (new URL('/api/public', this.url)).toString(),  // No auth for public access
			quota: { url: (new URL('/api/quota', this.url)).toString(), ...authRequired }
		};

		return({
			operations,
			...(this.anchorAccount ? { anchorAccount: this.anchorAccount.publicKeyString.get() } : {}),
			quotas: this.quotas,
			signedUrlDefaultTTL: this.signedUrlDefaultTTL
		});
	}
}
