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
	KeetaStorageAnchorSearchResponse,
	KeetaStorageAnchorQuotaResponse,
	StorageBackend,
	QuotaConfig,
	StorageObjectVisibility,
	PathPolicy
} from './common.ts';
import {
	assertKeetaStorageAnchorDeleteResponse,
	assertKeetaStorageAnchorPutResponse,
	assertKeetaStorageAnchorGetRequest,
	assertKeetaStorageAnchorSearchRequest,
	assertKeetaStorageAnchorSearchResponse,
	assertKeetaStorageAnchorQuotaResponse,
	getKeetaStorageAnchorDeleteRequestSigningData,
	getKeetaStorageAnchorPutRequestSigningData,
	getKeetaStorageAnchorGetRequestSigningData,
	getKeetaStorageAnchorSearchRequestSigningData,
	getKeetaStorageAnchorQuotaRequestSigningData,
	defaultPathPolicy,
	parseContainerPayload,
	Errors
} from './common.js';
import { VerifySignedData } from '../../lib/utils/signing.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server/common.js';
import { arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';
import { requiresValidation, findMatchingValidators } from './lib/validators.js';
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
	 * The anchor's account for decrypting objects.
	 */
	anchorAccount: Account;

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

	/**
	 * CORS origin for public endpoints (default: false).
	 * - '*' allows all origins
	 * - specific origin string restricts to that origin
	 * - false (default) disables CORS headers on public responses
	 */
	publicCorsOrigin?: string | false;

	/**
	 * Path policy for parsing and validating storage paths.
	 * Defaults to the standard /user/<pubkey>/<path> format.
	 */
	pathPolicy?: PathPolicy;
}

// Default quota configuration
const DEFAULT_QUOTAS: QuotaConfig = {
	maxObjectSize: 10 * 1024 * 1024, // 10MB
	maxObjectsPerUser: 1000,
	maxStoragePerUser: 100 * 1024 * 1024, // 100MB
	maxSearchLimit: 100,
	maxSignedUrlTTL: 86400 // 24 hours
};

export class KeetaNetStorageAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorStorageServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorStorageServerConfig['homepage']>;
	readonly backend: StorageBackend;
	readonly anchorAccount: Account;
	readonly quotas: QuotaConfig;
	readonly validators: NamespaceValidator[];
	readonly signedUrlDefaultTTL: number;
	readonly publicCorsOrigin: string | false;
	readonly pathPolicy: PathPolicy;

	constructor(config: KeetaAnchorStorageServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.backend = config.backend;
		this.anchorAccount = config.anchorAccount;
		this.quotas = config.quotas ?? DEFAULT_QUOTAS;
		this.validators = config.validators ?? [];
		this.signedUrlDefaultTTL = config.signedUrlDefaultTTL ?? 3600;
		this.publicCorsOrigin = config.publicCorsOrigin ?? false;
		this.pathPolicy = config.pathPolicy ?? defaultPathPolicy;

		// Validate anchorAccount has private key
		if (!this.anchorAccount.hasPrivateKey) {
			throw(new Error('anchorAccount must have a private key'));
		}
	}

	// Note: We use this.* properties instead of config.*.
	// The config parameter is required by the abstract method signature but unused here.
	protected async initRoutes(_ignoreConfig: KeetaAnchorStorageServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = {};
		const backend = this.backend;
		const anchorAccount = this.anchorAccount;
		const quotas = this.quotas;
		const validators = this.validators;
		const publicCorsOrigin = this.publicCorsOrigin;
		const pathPolicy = this.pathPolicy;

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

		// PUT /api/object/* - Create or update an object
		routes['PUT /api/object/*'] = {
			bodyType: 'raw',
			handler: async function(params, postData, _headers, url) {
				// Extract path from URL pathname
				const wildcardPath = params.get('*');
				if (!wildcardPath) {
					throw(new Errors.InvalidPath());
				}

				const objectPath = '/' + wildcardPath;

				// Get metadata from query params
				const parsedUrl = new URL(url);
				const visibilityParam = parsedUrl.searchParams.get('visibility');
				const tagsParam = parsedUrl.searchParams.get('tags');

				// Parse visibility and tags
				const visibility: StorageObjectVisibility = visibilityParam === 'public' ? 'public' : 'private';
				const tags: string[] = (tagsParam ?? '')
					.split(',')
					.map(function(t) {
						return(t.trim());
					})
					.filter(function(t) {
						return(t.length > 0);
					});

				// Verify signature using verifyURLAuth (consistent with GET/DELETE)
				const account = await verifyURLAuth(
					url,
					getKeetaStorageAnchorPutRequestSigningData,
					() => ({ path: objectPath, visibility, tags })
				);

				// Validate path format and ownership
				const pathInfo = pathPolicy.assertAccess(account, objectPath, 'put');
				// Body is raw binary (EncryptedContainer)
				const data = arrayBufferLikeToBuffer(postData);

				const objectSize = data.byteLength;
				if (objectSize > quotas.maxObjectSize) {
					throw(new Errors.QuotaExceeded(`Object too large: ${objectSize} bytes exceeds limit of ${quotas.maxObjectSize}`));
				}

				const needsValidation = requiresValidation(objectPath, validators);
				const needsAnchorDecryption = needsValidation || visibility === 'public';
				if (needsAnchorDecryption) {
					try {
						const container = EncryptedContainer.fromEncryptedBuffer(data, [anchorAccount]);
						const plaintext = await container.getPlaintext();

						if (needsValidation) {
							const { mimeType, content } = parseContainerPayload(plaintext);
							const matchingValidators = findMatchingValidators(objectPath, validators);
							for (const validator of matchingValidators) {
								const result = await validator.validate(objectPath, content, mimeType);
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

				const objectMetadata = await backend.withAtomic(async function(atomic) {
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
						tags,
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
			}
		};

		// GET /api/object/* - Retrieve an object (returns raw binary)
		routes['GET /api/object/*'] = async function(params, _postData, _headers, url) {
			// Extract path from URL pathname
			const wildcardPath = params.get('*');
			if (!wildcardPath) {
				throw(new Errors.InvalidPath());
			}

			const objectPath = '/' + wildcardPath;
			const pathInfo = pathPolicy.validate(objectPath);

			// Handle authentication
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorGetRequestSigningData,
				(accountPubKey) => assertKeetaStorageAnchorGetRequest({ path: pathInfo.path, account: accountPubKey })
			);

			// Verify ownership
			pathPolicy.assertAccess(account, objectPath, 'get');

			const result = await backend.get(pathInfo.path);
			if (!result) {
				throw(new Errors.DocumentNotFound());
			}

			// Return raw binary data (EncryptedContainer)
			return({
				output: result.data,
				contentType: 'application/octet-stream'
			});
		};

		// DELETE /api/object/* - Delete an object
		routes['DELETE /api/object/*'] = async function(params, _postData, _headers, url) {
			// Extract path from URL pathname
			const wildcardPath = params.get('*');
			if (!wildcardPath) {
				throw(new Errors.InvalidPath());
			}

			const objectPath = '/' + wildcardPath;
			const pathInfo = pathPolicy.validate(objectPath);

			// Handle authentication
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorDeleteRequestSigningData,
				(accountPubKey) => ({ path: objectPath, account: accountPubKey })
			);

			// Verify ownership
			pathPolicy.assertAccess(account, objectPath, 'delete');

			const deleted = await backend.delete(pathInfo.path);
			const response: KeetaStorageAnchorDeleteResponse = {
				ok: true,
				deleted
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorDeleteResponse(response))
			});
		};

		// GET /api/metadata/* - Get object metadata
		routes['GET /api/metadata/*'] = async function(params, _postData, _headers, url) {
			// Extract path from URL pathname
			const wildcardPath = params.get('*');
			if (!wildcardPath) {
				throw(new Errors.InvalidPath());
			}

			const objectPath = '/' + wildcardPath;
			const pathInfo = pathPolicy.validate(objectPath);

			// Handle authentication
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorGetRequestSigningData,
				(accountPubKey) => assertKeetaStorageAnchorGetRequest({ path: pathInfo.path, account: accountPubKey })
			);

			// Verify ownership
			pathPolicy.assertAccess(account, objectPath, 'metadata');

			const result = await backend.get(pathInfo.path);
			if (!result) {
				throw(new Errors.DocumentNotFound());
			}

			return({
				output: JSON.stringify({ ok: true, object: result.metadata })
			});
		};

		// POST /api/search - Search for objects
		routes['POST /api/search'] = async function(_params, postData) {
			const request = assertKeetaStorageAnchorSearchRequest(postData);
			const account = await verifyBodyAuth(request, getKeetaStorageAnchorSearchRequestSigningData);
			const accountPubKey = account.publicKeyString.get();

			// Check if searching for public objects outside namespace
			const searchingPublic = request.criteria.visibility === 'public';
			if (searchingPublic) {
				// When searching for public objects, we allow searching outside the caller's namespace
				// but only for objects with visibility: 'public'
				const scopedCriteria = {
					...request.criteria,
					visibility: 'public' as const
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
			}

			// Standard search: restricted to caller's namespace
			pathPolicy.assertSearchAccess(account, request.criteria);

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
					remainingObjects: Math.max(0, quotas.maxObjectsPerUser - backendStatus.objectCount),
					remainingSize: Math.max(0, quotas.maxStoragePerUser - backendStatus.totalSize)
				}
			};

			return({
				output: JSON.stringify(assertKeetaStorageAnchorQuotaResponse(response))
			});
		};

		// GET /api/public/* - Public object access via pre-signed URL
		routes['GET /api/public/*'] = async function(params, _postData, _headers, url) {
			// Extract path from URL pathname
			const wildcardPath = params.get('*');
			if (!wildcardPath) {
				throw(new Errors.InvalidPath());
			}

			const objectPath = '/' + wildcardPath;
			const pathInfo = pathPolicy.validate(objectPath);

			// Get signature parameters from query params
			const parsedUrl = new URL(url);
			const signature = parsedUrl.searchParams.get('signature');
			const expires = parsedUrl.searchParams.get('expires');
			const nonce = parsedUrl.searchParams.get('nonce');
			const timestamp = parsedUrl.searchParams.get('timestamp');
			if (!signature || !expires || !nonce || !timestamp) {
				throw(new Errors.SignatureInvalid('Missing required signature parameters'));
			}

			// Check expiry
			const expiresAt = parseInt(expires, 10);
			if (!Number.isFinite(expiresAt)) {
				throw(new Errors.SignatureInvalid('Invalid expires parameter'));
			}
			if (Date.now() > expiresAt * 1000) {
				throw(new Errors.SignatureExpired());
			}

			// Enforce maximum TTL
			const maxExpiresAt = Math.floor(Date.now() / 1000) + quotas.maxSignedUrlTTL;
			if (expiresAt > maxExpiresAt) {
				throw(new Errors.SignatureExpired('Signed URL TTL exceeds maximum allowed'));
			}

			// Verify signature using the signing library
			const ownerAccount = KeetaNet.lib.Account.fromPublicKeyString(pathInfo.owner).assertAccount();

			try {
				const signedData = { nonce, timestamp, signature };
				// Allow skew up to maxSignedUrlTTL to cover the entire validity period
				const valid = await VerifySignedData(ownerAccount, [objectPath, expiresAt], signedData, {
					maxSkewMs: quotas.maxSignedUrlTTL * 1000
				});
				if (!valid) {
					throw(new Errors.SignatureInvalid());
				}
			} catch (e) {
				if (Errors.SignatureInvalid.isInstance(e)) {
					throw(e);
				}
				throw(new Errors.SignatureInvalid('Invalid signature format'));
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
			const data = arrayBufferLikeToBuffer(result.data);
			const container = EncryptedContainer.fromEncryptedBuffer(data, [anchorAccount]);
			const plaintext = await container.getPlaintext();
			const { mimeType, content } = parseContainerPayload(plaintext);

			const headers: { [key: string]: string } = {};
			if (publicCorsOrigin) {
				headers['Access-Control-Allow-Origin'] = publicCorsOrigin;
			}

			return({
				output: content,
				contentType: mimeType,
				headers
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
			metadata: { url: (new URL('/api/metadata', this.url)).toString(), ...authRequired },
			search: { url: (new URL('/api/search', this.url)).toString(), ...authRequired },
			public: (new URL('/api/public', this.url)).toString(),
			quota: { url: (new URL('/api/quota', this.url)).toString(), ...authRequired }
		};

		return({
			operations,
			anchorAccount: this.anchorAccount.publicKeyString.get(),
			quotas: this.quotas,
			signedUrlDefaultTTL: this.signedUrlDefaultTTL,
			searchableFields: ['owner', 'tags', 'visibility', 'pathPrefix']
		});
	}
}
