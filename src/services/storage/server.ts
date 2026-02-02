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
	FullStorageBackend,
	QuotaConfig,
	StorageObjectVisibility,
	StorageObjectMetadata,
	PathPolicy,
	SearchResults,
	StorageGetResult,
	SearchPagination
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
	parseContainerPayload,
	Errors,
	CONTENT_TYPE_OCTET_STREAM,
	DEFAULT_SIGNED_URL_TTL_SECONDS
} from './common.js';
import { VerifySignedData } from '../../lib/utils/signing.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server/common.js';
import { arrayBufferLikeToBuffer, Buffer } from '../../lib/utils/buffer.js';
import { requiresValidation, findMatchingValidators } from './lib/validators.js';
import { EncryptedContainer, EncryptedContainerError } from '../../lib/encrypted-container.js';

type Account = InstanceType<typeof KeetaNet.lib.Account>;

/**
 * Build a standardized search response from search results.
 */
function buildSearchResponse(results: SearchResults): KeetaStorageAnchorSearchResponse {
	return({
		ok: true,
		results: results.results,
		...(results.nextCursor !== undefined ? { nextCursor: results.nextCursor } : {})
	});
}

// #region Module-Level Helpers

/**
 * Find a matching policy for a path, validate it, and check access.
 *
 * @param pathPolicies - Array of path policies to check against
 * @param account - The account to check access for
 * @param path - The path to check
 * @param operation - The operation being performed
 */
function assertPathAccess(
	pathPolicies: PathPolicy<unknown>[],
	account: Account,
	path: string,
	operation: 'get' | 'put' | 'delete' | 'search' | 'metadata'
): { policy: PathPolicy<unknown>; parsed: unknown } {
	for (const policy of pathPolicies) {
		const parsed = policy.parse(path);
		if (parsed !== null) {
			policy.validate(path);

			if (!policy.checkAccess(account, parsed, operation)) {
				throw(new Errors.AccessDenied('Can only access your own namespace'));
			}

			return({ policy, parsed });
		}
	}

	throw(new Errors.InvalidPath('Path does not match any policy'));
}

/**
 * Find a matching policy and parse a path.
 * Used for public endpoints where auth is optional.
 *
 * @param pathPolicies - Array of path policies to check against
 * @param path - The path to parse
 */
function parsePath(
	pathPolicies: PathPolicy<unknown>[],
	path: string
): { policy: PathPolicy<unknown>; parsed: unknown } {
	for (const policy of pathPolicies) {
		const parsed = policy.parse(path);
		if (parsed !== null) {
			policy.validate(path);
			return({ policy, parsed });
		}
	}

	throw(new Errors.InvalidPath('Path does not match any policy'));
}

/**
 * Verify a signed request from POST body.
 * Extracts account and signature from the request, verifies the signature,
 * and returns the authenticated account.
 *
 * @typeParam T - Request type containing optional account and signed fields
 *
 * @param request - The request object containing account and signed fields
 * @param getSigningData - Function to extract signable data from the request
 *
 * @returns The authenticated account
 *
 * @throws KeetaAnchorUserError if authentication is missing or invalid
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
 * Parses signature from URL, builds a request object, verifies the signature,
 * and returns the authenticated account.
 *
 * @typeParam T - Request type to build from the account public key
 *
 * @param url - The URL containing signature query parameters
 * @param getSigningData - Function to extract signable data from the request
 * @param buildRequest - Function to build a request object from the account public key
 *
 * @returns The authenticated account
 *
 * @throws KeetaAnchorUserError if authentication is missing or invalid
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

/**
 * Extract object path from wildcard route parameter.
 * Prepends a leading slash to create a valid storage path.
 *
 * @param params - Route parameters containing the wildcard match
 *
 * @returns The object path with leading slash
 *
 * @throws InvalidPath if wildcard parameter is missing
 */
function extractObjectPath(params: Map<string, string>): string {
	const wildcardPath = params.get('*');
	if (!wildcardPath) {
		throw(new Errors.InvalidPath());
	}

	return('/' + wildcardPath);
}

/**
 * Authorize access to an object path via URL-signed request.
 * Combines path validation, signature verification, and access control.
 *
 * @typeParam T - Request type to build from path and account
 *
 * @param pathPolicies - Array of path policies to check against
 * @param params - Route parameters containing the wildcard path
 * @param url - The URL containing signature query parameters
 * @param operation - The operation being authorized
 * @param getSigningData - Function to extract signable data from the request
 * @param buildRequest - Function to build a request object from path and account
 *
 * @returns The authenticated account and validated object path
 *
 * @throws InvalidPath if path is invalid or doesn't match any policy
 * @throws AccessDenied if user doesn't have access to the path
 * @throws KeetaAnchorUserError if signature is invalid
 */
async function authorizeURLAccess<T>(
	pathPolicies: PathPolicy<unknown>[],
	params: Map<string, string>,
	url: URL | string,
	operation: 'get' | 'put' | 'delete' | 'metadata',
	getSigningData: (req: T) => Signable,
	buildRequest: (path: string, accountPubKey: string) => T
): Promise<{ account: Account; objectPath: string }> {
	const objectPath = extractObjectPath(params);
	parsePath(pathPolicies, objectPath);

	const account = await verifyURLAuth(url, getSigningData, function(pubKey) {
		return(buildRequest(objectPath, pubKey));
	});

	assertPathAccess(pathPolicies, account, objectPath, operation);

	return({ account, objectPath });
}

// #endregion

/**
 * Configuration for the Storage Anchor
 *
 * The Storage Anchor provides encrypted object storage with the following operations:
 *
 * PUT (Create/Update):
 *   1. Client creates EncryptedContainer with data, shares with anchor for public objects
 *   2. Client signs request (path, visibility, tags) and sends to server
 *   3. Server reserves quota, validates, stores object, commits reservation
 *
 * GET (Retrieve):
 *   1. Client signs request (path) and sends to server
 *   2. Server verifies access, returns EncryptedContainer
 *   3. Client decrypts with their private key
 *
 * DELETE:
 *   1. Client signs request (path) and sends to server
 *   2. Server verifies ownership, removes object
 *
 * SEARCH:
 *   1. Client signs request with criteria (tags, prefix, etc.)
 *   2. Server returns matching metadata (scoped to user's namespace)
 *
 * PUBLIC ACCESS (Pre-signed URLs):
 *   1. Client generates pre-signed URL with expiry, signed by owner
 *   2. Anyone can fetch via URL (no auth headers)
 *   3. Server verifies signature, expiry, and visibility
 *   4. Server decrypts and returns plaintext content
 *
 *
 *   +-------------------+            +---------------------+             +------------------+
 *   |       Client      |            |  Storage Anchor     |             |  Storage Backend |
 *   +-------------------+            +---------------------+             +------------------+
 *         |                                   |                                  |
 *   (PUT) Create EncryptedContainer           |                                  |
 *         | Sign(path, visibility, tags)      |                                  |
 *         |---------------------------------->|                                  |
 *         |                                   | reserveUpload() ---------------->|
 *         |                                   | validate, put() ---------------->|
 *         |                                   | commitUpload() ----------------->|
 *         |<--------------------------------- | { ok: true, object: metadata }   |
 *         |                                   |                                  |
 *   (GET) Sign(path) ------------------------>|                                  |
 *         |                                   | get() -------------------------->|
 *         |<--------------------------------- | EncryptedContainer (binary)      |
 *         | Decrypt with private key          |                                  |
 *         |                                   |                                  |
 *   (PUBLIC) Generate pre-signed URL          |                                  |
 *         | URL with expires, signature       |                                  |
 *   (Anyone) Fetch URL ---------------------->|                                  |
 *         |                                   | verify signature, expiry         |
 *         |                                   | get(), decrypt ----------------->|
 *         |<--------------------------------- | Plaintext content                |
 */
export interface KeetaAnchorStorageServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/**
	 * The data to use for the index page (optional)
	 */
	homepage?: string | (() => Promise<string> | string);

	/**
	 * The storage backend to use for storing documents.
	 * Must implement full capabilities: CRUD, search, and quota management.
	 */
	backend: FullStorageBackend;

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
	 * Path policies for parsing, validating, and access control of storage paths.
	 * Each policy handles a specific path pattern. First matching policy wins.
	 */
	pathPolicies: PathPolicy<unknown>[];

	/**
	 * Tag validation configuration.
	 */
	tagValidation?: {
		/** Maximum number of tags per object (default: 10) */
		maxTags?: number;
		/** Maximum length of each tag (default: 50) */
		maxTagLength?: number;
		/** Pattern for valid tag characters (default: /^[a-zA-Z0-9_-]+$/) */
		pattern?: RegExp;
	};
}

// Default quota configuration
const DEFAULT_QUOTAS: QuotaConfig = {
	maxObjectSize: 10 * 1024 * 1024, // 10MB
	maxObjectsPerUser: 1000,
	maxStoragePerUser: 100 * 1024 * 1024, // 100MB
	maxSearchLimit: 100,
	maxSignedUrlTTL: 86400 // 24 hours
};

// Default tag validation configuration
const DEFAULT_TAG_VALIDATION = {
	maxTags: 10,
	maxTagLength: 50,
	pattern: /^[a-zA-Z0-9_-]+$/
};

export class KeetaNetStorageAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorStorageServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorStorageServerConfig['homepage']>;
	readonly backend: FullStorageBackend;
	readonly anchorAccount: Account;
	readonly quotas: QuotaConfig;
	readonly validators: NamespaceValidator[];
	readonly signedUrlDefaultTTL: number;
	readonly publicCorsOrigin: string | false;
	readonly pathPolicies: PathPolicy<unknown>[];
	readonly tagValidation: Required<NonNullable<KeetaAnchorStorageServerConfig['tagValidation']>>;

	constructor(config: KeetaAnchorStorageServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.backend = config.backend;
		this.anchorAccount = config.anchorAccount;
		this.quotas = config.quotas ?? DEFAULT_QUOTAS;
		this.validators = config.validators ?? [];
		this.signedUrlDefaultTTL = config.signedUrlDefaultTTL ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
		this.publicCorsOrigin = config.publicCorsOrigin ?? false;
		this.pathPolicies = config.pathPolicies;
		this.tagValidation = {
			maxTags: config.tagValidation?.maxTags ?? DEFAULT_TAG_VALIDATION.maxTags,
			maxTagLength: config.tagValidation?.maxTagLength ?? DEFAULT_TAG_VALIDATION.maxTagLength,
			pattern: config.tagValidation?.pattern ?? DEFAULT_TAG_VALIDATION.pattern
		};

		// Validate anchorAccount has private key
		if (!this.anchorAccount.hasPrivateKey) {
			throw(new Error('anchorAccount must have a private key'));
		}

		// Validate at least one path policy is provided
		if (this.pathPolicies.length === 0) {
			throw(new Error('At least one path policy must be provided'));
		}

		// Validate quota configuration values are positive
		if (this.quotas.maxObjectSize <= 0) {
			throw(new Error('quotas.maxObjectSize must be positive'));
		}
		if (this.quotas.maxObjectsPerUser <= 0) {
			throw(new Error('quotas.maxObjectsPerUser must be positive'));
		}
		if (this.quotas.maxStoragePerUser <= 0) {
			throw(new Error('quotas.maxStoragePerUser must be positive'));
		}
		if (this.quotas.maxSearchLimit <= 0) {
			throw(new Error('quotas.maxSearchLimit must be positive'));
		}
		if (this.quotas.maxSignedUrlTTL <= 0) {
			throw(new Error('quotas.maxSignedUrlTTL must be positive'));
		}

		// Validate tag validation configuration
		if (this.tagValidation.maxTags <= 0) {
			throw(new Error('tagValidation.maxTags must be positive'));
		}
		if (this.tagValidation.maxTagLength <= 0) {
			throw(new Error('tagValidation.maxTagLength must be positive'));
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
		const pathPolicies = this.pathPolicies;
		const tagValidation = this.tagValidation;
		const logger = this.logger;

		/**
		 * Build a JSON response with assertion.
		 */
		function jsonResponse<T>(response: T, assertionHandler: (input: unknown) => T): { output: string } {
			return({ output: JSON.stringify(assertionHandler(response)) });
		}

		/**
		 * Get an object or throw DocumentNotFound.
		 */
		async function requireObject(path: string): Promise<StorageGetResult> {
			const result = await backend.get(path);
			if (!result) {
				throw(new Errors.DocumentNotFound());
			}

			return(result);
		}

		/**
		 * Enforce server-side search limit cap.
		 */
		function enforceSearchLimit(pagination: SearchPagination | undefined): SearchPagination {
			const requestedLimit = pagination?.limit ?? quotas.maxSearchLimit;
			return({ ...pagination, limit: Math.min(requestedLimit, quotas.maxSearchLimit) });
		}

		/**
		 * Validate search results match expected constraints.
		 */
		function assertSearchResults(
			results: SearchResults,
			constraint: { visibility?: 'public'; owner?: string }
		): void {
			for (const obj of results.results) {
				if (constraint.visibility && obj.visibility !== constraint.visibility) {
					throw(new Errors.InvariantViolation(
						`Backend returned ${obj.visibility} object in ${constraint.visibility} search`
					));
				}
				if (constraint.owner && obj.owner !== constraint.owner) {
					throw(new Errors.InvariantViolation(
						`Backend returned object owned by ${obj.owner} in search for ${constraint.owner}`
					));
				}
			}
		}

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
				const objectPath = extractObjectPath(params);

				// Get metadata from query params
				const parsedUrl = new URL(url);
				const visibilityParam = parsedUrl.searchParams.get('visibility');
				const tagsParam = parsedUrl.searchParams.get('tags');

				// Parse visibility and raw tags
				const visibility: StorageObjectVisibility = visibilityParam === 'public' ? 'public' : 'private';
				const rawTags: string[] = (tagsParam ?? '')
					.split(',')
					.map(function(t) {
						return(t.trim());
					})
					.filter(function(t) {
						return(t.length > 0);
					});

				// Verify signature
				const account = await verifyURLAuth(url, getKeetaStorageAnchorPutRequestSigningData, function() {
					return({ path: objectPath, visibility, tags: rawTags });
				});

				// Validate tags
				const { maxTags, maxTagLength, pattern: tagPattern } = tagValidation;
				for (const tag of rawTags) {
					if (tag.length > maxTagLength) {
						throw(new Errors.InvalidTag(`Tag exceeds maximum length of ${maxTagLength}: "${tag}"`));
					}
					if (!tagPattern.test(tag)) {
						throw(new Errors.InvalidTag(`Tag contains invalid characters: "${tag}"`));
					}
				}
				if (rawTags.length > maxTags) {
					throw(new Errors.InvalidTag(`Too many tags: ${rawTags.length} exceeds maximum of ${maxTags}`));
				}
				const tags = rawTags;

				// Validate path format and ownership
				assertPathAccess(pathPolicies, account, objectPath, 'put');

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
							// Extract content and mimeType from encrypted payload
							const { content, mimeType } = parseContainerPayload(plaintext);
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

				const owner = account.publicKeyString.get();

				// Reserve quota before upload
				const reservation = await backend.reserveUpload(owner, objectPath, objectSize, {
					quotaLimits: {
						maxObjectsPerUser: quotas.maxObjectsPerUser,
						maxStoragePerUser: quotas.maxStoragePerUser
					}
				});

				let objectMetadata: StorageObjectMetadata;
				try {
					objectMetadata = await backend.put(objectPath, data, {
						owner,
						tags,
						visibility
					});

					await backend.commitUpload(reservation.id);
				} catch (e) {
					try {
						await backend.releaseUpload(reservation.id);
					} catch (releaseError) {
						/**
						 * This provides a hint for cleanup
						 */
						logger?.warn('Failed to release upload reservation', { reservationId: reservation.id, error: releaseError });
					}
					throw(e);
				}

				const response: KeetaStorageAnchorPutResponse = {
					ok: true,
					object: objectMetadata
				};

				return(jsonResponse(response, assertKeetaStorageAnchorPutResponse));
			}
		};

		// GET /api/object/* - Retrieve an object
		routes['GET /api/object/*'] = async function(params, _postData, _headers, url) {
			const { objectPath } = await authorizeURLAccess(
				pathPolicies,
				params,
				url,
				'get',
				getKeetaStorageAnchorGetRequestSigningData,
				function(path, pubKey) {
					return(assertKeetaStorageAnchorGetRequest({ path, account: pubKey }));
				}
			);

			const result = await requireObject(objectPath);
			return({
				output: result.data,
				contentType: CONTENT_TYPE_OCTET_STREAM
			});
		};

		// DELETE /api/object/* - Delete an object
		routes['DELETE /api/object/*'] = async function(params, _postData, _headers, url) {
			const { objectPath } = await authorizeURLAccess(
				pathPolicies,
				params,
				url,
				'delete',
				getKeetaStorageAnchorDeleteRequestSigningData,
				function(path, pubKey) {
					return({ path, account: pubKey });
				}
			);

			const deleted = await backend.delete(objectPath);
			const response: KeetaStorageAnchorDeleteResponse = {
				ok: true,
				deleted
			};

			return(jsonResponse(response, assertKeetaStorageAnchorDeleteResponse));
		};

		// GET /api/metadata/* - Get object metadata
		routes['GET /api/metadata/*'] = async function(params, _postData, _headers, url) {
			const { objectPath } = await authorizeURLAccess(
				pathPolicies,
				params,
				url,
				'metadata',
				getKeetaStorageAnchorGetRequestSigningData,
				function(path, pubKey) {
					return(assertKeetaStorageAnchorGetRequest({ path, account: pubKey }));
				}
			);

			const result = await requireObject(objectPath);
			return(jsonResponse({ ok: true, object: result.metadata }, assertKeetaStorageAnchorPutResponse));
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

				const results = await backend.search(
					scopedCriteria,
					enforceSearchLimit(request.pagination)
				);

				assertSearchResults(results, { visibility: 'public' });

				return(jsonResponse(buildSearchResponse(results), assertKeetaStorageAnchorSearchResponse));
			}

			// Scope search to authenticated account's namespace
			const scopedCriteria = {
				...request.criteria,
				owner: accountPubKey
			};

			const results = await backend.search(
				scopedCriteria,
				enforceSearchLimit(request.pagination)
			);

			assertSearchResults(results, { owner: accountPubKey });

			return(jsonResponse(buildSearchResponse(results), assertKeetaStorageAnchorSearchResponse));
		};

		// GET /api/quota - Get quota status
		routes['GET /api/quota'] = async function(_params, _postData, _headers, url) {
			const account = await verifyURLAuth(
				url,
				getKeetaStorageAnchorQuotaRequestSigningData,
				function() { return({}); }
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

			return(jsonResponse(response, assertKeetaStorageAnchorQuotaResponse));
		};

		// GET /api/public/* - Public object access via pre-signed URL
		routes['GET /api/public/*'] = async function(params, _postData, _headers, url) {
			const objectPath = extractObjectPath(params);
			const { policy, parsed } = parsePath(pathPolicies, objectPath);

			// Get the authorized signer for this path
			const signerPubKey = policy.getAuthorizedSigner(parsed);
			if (!signerPubKey) {
				throw(new Errors.AccessDenied('Pre-signed URLs not supported for this path'));
			}

			// Get signature parameters from query params
			const parsedUrl = new URL(url);
			const signature = parsedUrl.searchParams.get('signature');
			const expires = parsedUrl.searchParams.get('expires');
			const nonce = parsedUrl.searchParams.get('nonce');
			const timestamp = parsedUrl.searchParams.get('timestamp');
			if (!signature || !expires || !nonce || !timestamp) {
				throw(new Errors.SignatureInvalid('Missing required signature parameters'));
			}

			// Validate nonce format
			if (nonce.length === 0 || nonce.length > 64) {
				throw(new Errors.SignatureInvalid('Invalid nonce format'));
			}

			// Validate timestamp format (ISO 8601)
			const timestampDate = Date.parse(timestamp);
			if (!Number.isFinite(timestampDate)) {
				throw(new Errors.SignatureInvalid('Invalid timestamp format'));
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
			const ownerAccount = KeetaNet.lib.Account.fromPublicKeyString(signerPubKey).assertAccount();

			// Pre-validate signature is valid base64 with reasonable length
			const signatureBuffer = Buffer.from(signature, 'base64');
			if (signatureBuffer.length < 64 || signatureBuffer.length > 256) {
				throw(new Errors.SignatureInvalid('Invalid signature format'));
			}

			try {
				const signedData = { nonce, timestamp, signature };
				// Allow 5 minutes of clock skew for signature verification
				const valid = await VerifySignedData(ownerAccount, [objectPath, expiresAt], signedData, {
					maxSkewMs: 5 * 60 * 1000
				});
				if (!valid) {
					throw(new Errors.SignatureInvalid());
				}
			} catch (e) {
				if (Errors.SignatureInvalid.isInstance(e)) {
					throw(e);
				}

				throw(new Errors.SignatureInvalid('Signature verification failed'));
			}

			const result = await requireObject(objectPath);
			if (result.metadata.visibility !== 'public') {
				throw(new Errors.AccessDenied('Object is not public'));
			}

			// Decrypt using anchor account and extract mimeType from encrypted payload
			const data = arrayBufferLikeToBuffer(result.data);
			const container = EncryptedContainer.fromEncryptedBuffer(data, [anchorAccount]);
			const plaintext = await container.getPlaintext();
			const { content, mimeType } = parseContainerPayload(plaintext);

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
