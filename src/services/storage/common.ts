import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createIs, createAssert } from 'typia';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { KeetaAnchorUserError, KeetaAnchorUserValidationError } from '../../lib/error.js';
import { Buffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';

/**
 * Type alias for a KeetaNet Account instance.
 * Used throughout the storage service for account authentication and signing.
 */
export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;

// #region Shared Constants

/** Content type for JSON payloads */
export const CONTENT_TYPE_JSON = 'application/json';

/** Content type for binary/octet-stream payloads */
export const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';

/** Default TTL for signed URLs in seconds (1 hour) */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;

// #endregion

// #region Common Types

/**
 * Visibility of a storage object
 */
export type StorageObjectVisibility = 'public' | 'private';

// #endregion

// #region Object Metadata

/**
 * Metadata for a stored object
 */
export type StorageObjectMetadata = {
	/**
	 * Full path (the unique ID)
	 */
	path: string;

	/**
	 * Owner's identifier
	 */
	owner: string;

	/**
	 * Plaintext tags (searchable)
	 */
	tags: string[];

	/**
	 * Visibility setting
	 */
	visibility: StorageObjectVisibility;

	/**
	 * Size in bytes
	 */
	size: number;

	/**
	 * ISO timestamp of creation
	 */
	createdAt: string;

	/**
	 * ISO timestamp of last update
	 */
	updatedAt?: string;
};

// #endregion

// #region Search

/**
 * Criteria for searching storage objects.
 * Note: Content/keyword search is not supported (content is encrypted).
 */
export type SearchCriteria = {
	/**
	 * Match objects with paths starting with this prefix
	 * e.g., "/user/keeta1abc.../contacts/"
	 */
	pathPrefix?: string;

	/**
	 * Match objects that have ANY of these tags
	 */
	tags?: string[];

	/**
	 * Match path segment (filename portion)
	 */
	name?: string;

	/**
	 * Filter by owner's public key
	 */
	owner?: string;

	/**
	 * Include objects in nested paths (default: false)
	 */
	recursive?: boolean;

	/**
	 * Filter by visibility.
	 * When 'public', allows searching public objects outside caller's namespace.
	 */
	visibility?: StorageObjectVisibility;
};

/**
 * Pagination options for search
 */
export type SearchPagination = {
	/**
	 * Cursor for pagination (from previous response)
	 */
	cursor?: string;

	/**
	 * Maximum number of results to return
	 */
	limit?: number;
};

/**
 * Search results with pagination
 */
export type SearchResults = {
	/**
	 * Matching objects
	 */
	results: StorageObjectMetadata[];

	/**
	 * Cursor for next page (undefined if no more results)
	 */
	nextCursor?: string;
};

// #endregion

// #region Quota

/**
 * Quota configuration for the storage service
 */
export type QuotaConfig = {
	/**
	 * Maximum size in bytes per object
	 */
	maxObjectSize: number;

	/**
	 * Maximum number of objects per user
	 */
	maxObjectsPerUser: number;

	/**
	 * Maximum total storage in bytes per user
	 */
	maxStoragePerUser: number;

	/**
	 * Maximum number of results per search request
	 */
	maxSearchLimit: number;

	/**
	 * Maximum TTL in seconds for signed URLs
	 */
	maxSignedUrlTTL: number;
};

/**
 * Per-user quota limits.
 * Subset of QuotaConfig that can be overridden on a per-user basis.
 */
export type QuotaLimits = Pick<QuotaConfig, 'maxObjectsPerUser' | 'maxStoragePerUser' | 'maxObjectSize'>;

/**
 * Current quota status for a user.
 * Backends must provide objectCount and totalSize.
 */
export type QuotaStatus = {
	/**
	 * Current number of objects
	 */
	objectCount: number;

	/**
	 * Current total size in bytes
	 */
	totalSize: number;

	/**
	 * Remaining objects allowed (optional, server computes if absent)
	 */
	remainingObjects?: number;

	/**
	 * Remaining storage in bytes (optional, server computes if absent)
	 */
	remainingSize?: number;
};

// #endregion

// #region Request Type Helpers

// #endregion

// #region PUT Object

/**
 * Client-side request to put (create/update) an object
 */
export type KeetaStorageAnchorPutClientRequest = {
	account?: KeetaNetAccount;
	path: string;
	data: string;  // Base64-encoded EncryptedContainer
	tags?: string[];
	visibility?: StorageObjectVisibility;
};

/**
 * Server-side request to put an object
 */
export type KeetaStorageAnchorPutRequest = {
	account?: string;
	signed?: HTTPSignedField;
	path: string;
	data: string;
	tags?: string[];
	visibility?: StorageObjectVisibility;
};

/**
 * Generic response type for storage operations.
 */
export type StorageResponse<T> = ({ ok: true } & T) | { ok: false; error: string };

export type KeetaStorageAnchorPutResponse = StorageResponse<{ object: StorageObjectMetadata }>;

export function getKeetaStorageAnchorPutRequestSigningData(
	input: { path: string; visibility?: StorageObjectVisibility; tags?: string[] }
): Signable {
	const visibility = input.visibility ?? 'private';
	const tags: string[] = input.tags ?? [];
	const sortedTags = [...tags].sort();
	return(['put', input.path, visibility, ...sortedTags]);
}

// #endregion

// #region GET Object

/**
 * Client-side request to get an object
 */
export type KeetaStorageAnchorGetClientRequest = {
	account?: KeetaNetAccount;
	path: string;
};

/**
 * Server-side request to get an object
 */
export type KeetaStorageAnchorGetRequest = {
	account?: string;
	signed?: HTTPSignedField;
	path: string;
};

export type KeetaStorageAnchorGetResponse = StorageResponse<{
	data: string;  // Base64-encoded EncryptedContainer
	object: StorageObjectMetadata;
}>;

export function getKeetaStorageAnchorGetRequestSigningData(
	input: KeetaStorageAnchorGetRequest
): Signable {
	return(['get', input.path]);
}

// #endregion

// #region DELETE Object

/**
 * Client-side request to delete an object
 */
export type KeetaStorageAnchorDeleteClientRequest = {
	account?: KeetaNetAccount;
	/**
	 * Path to the object
	 */
	path: string;
};

/**
 * Server-side request to delete an object
 */
export type KeetaStorageAnchorDeleteRequest = {
	account?: string;
	signed?: HTTPSignedField;
	/**
	 * Path to the object
	 */
	path: string;
};

export type KeetaStorageAnchorDeleteResponse = StorageResponse<{ deleted: boolean }>;

export function getKeetaStorageAnchorDeleteRequestSigningData(
	input: KeetaStorageAnchorDeleteRequest
): Signable {
	return(['delete', input.path]);
}

// #endregion

// #region SEARCH

/**
 * Client-side request to search objects
 */
export type KeetaStorageAnchorSearchClientRequest = {
	account?: KeetaNetAccount;
	criteria: SearchCriteria;
	pagination?: SearchPagination;
};

/**
 * Server-side request to search objects
 */
export type KeetaStorageAnchorSearchRequest = {
	account?: string;
	signed?: HTTPSignedField;
	criteria: SearchCriteria;
	pagination?: SearchPagination;
};

export type KeetaStorageAnchorSearchResponse = StorageResponse<{
	results: StorageObjectMetadata[];
	nextCursor?: string;
}>;

export function getKeetaStorageAnchorSearchRequestSigningData(
	input: KeetaStorageAnchorSearchRequest
): Signable {
	const limit = input.pagination?.limit ?? 0;
	const cursor = input.pagination?.cursor ?? '';
	return(['search', JSON.stringify(input.criteria), limit, cursor]);
}

// #endregion

// #region Quota

/**
 * Client-side request to get quota status
 */
export type KeetaStorageAnchorQuotaClientRequest = {
	account?: KeetaNetAccount;
};

/**
 * Server-side request to get quota status
 */
export type KeetaStorageAnchorQuotaRequest = {
	account?: string;
	signed?: HTTPSignedField;
};

export type KeetaStorageAnchorQuotaResponse = StorageResponse<{ quota: QuotaStatus }>;

/**
 * Get signing data for quota requests.
 * The input is unused because quota requests don't need request-specific signing -
 * authentication alone is sufficient.
 *
 * The parameter was kept for API consistency with other signing functions.
 */
export function getKeetaStorageAnchorQuotaRequestSigningData(
	_ignoreInput: KeetaStorageAnchorQuotaRequest
): Signable {
	return(['quota']);
}

// #endregion

// #region Typia Validators

export const isKeetaStorageAnchorPutResponse: (input: unknown) => input is KeetaStorageAnchorPutResponse = createIs<KeetaStorageAnchorPutResponse>();
export const isKeetaStorageAnchorGetResponse: (input: unknown) => input is KeetaStorageAnchorGetResponse = createIs<KeetaStorageAnchorGetResponse>();
export const isKeetaStorageAnchorDeleteResponse: (input: unknown) => input is KeetaStorageAnchorDeleteResponse = createIs<KeetaStorageAnchorDeleteResponse>();
export const isKeetaStorageAnchorSearchResponse: (input: unknown) => input is KeetaStorageAnchorSearchResponse = createIs<KeetaStorageAnchorSearchResponse>();
export const isKeetaStorageAnchorQuotaResponse: (input: unknown) => input is KeetaStorageAnchorQuotaResponse = createIs<KeetaStorageAnchorQuotaResponse>();

export const assertKeetaStorageAnchorPutRequest: (input: unknown) => KeetaStorageAnchorPutRequest = createAssert<KeetaStorageAnchorPutRequest>();
export const assertKeetaStorageAnchorPutResponse: (input: unknown) => KeetaStorageAnchorPutResponse = createAssert<KeetaStorageAnchorPutResponse>();
export const assertKeetaStorageAnchorGetRequest: (input: unknown) => KeetaStorageAnchorGetRequest = createAssert<KeetaStorageAnchorGetRequest>();
export const assertKeetaStorageAnchorGetResponse: (input: unknown) => KeetaStorageAnchorGetResponse = createAssert<KeetaStorageAnchorGetResponse>();
export const assertKeetaStorageAnchorDeleteRequest: (input: unknown) => KeetaStorageAnchorDeleteRequest = createAssert<KeetaStorageAnchorDeleteRequest>();
export const assertKeetaStorageAnchorDeleteResponse: (input: unknown) => KeetaStorageAnchorDeleteResponse = createAssert<KeetaStorageAnchorDeleteResponse>();
export const assertKeetaStorageAnchorSearchRequest: (input: unknown) => KeetaStorageAnchorSearchRequest = createAssert<KeetaStorageAnchorSearchRequest>();
export const assertKeetaStorageAnchorSearchResponse: (input: unknown) => KeetaStorageAnchorSearchResponse = createAssert<KeetaStorageAnchorSearchResponse>();
export const assertKeetaStorageAnchorQuotaRequest: (input: unknown) => KeetaStorageAnchorQuotaRequest = createAssert<KeetaStorageAnchorQuotaRequest>();
export const assertKeetaStorageAnchorQuotaResponse: (input: unknown) => KeetaStorageAnchorQuotaResponse = createAssert<KeetaStorageAnchorQuotaResponse>();

// #endregion

// #region Error Classes

class KeetaStorageAnchorDocumentNotFoundError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorDocumentNotFoundError';
	private readonly KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID = 'ac137e18-2827-4542-a852-c650610899b5';

	constructor(message?: string) {
		super(message ?? 'Document not found');
		this.statusCode = 404;

		Object.defineProperty(this, 'KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID', {
			value: KeetaStorageAnchorDocumentNotFoundError.KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorDocumentNotFoundError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID', KeetaStorageAnchorDocumentNotFoundError.KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorDocumentNotFoundError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorAccessDeniedError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorAccessDeniedError';
	private readonly KeetaStorageAnchorAccessDeniedErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorAccessDeniedErrorObjectTypeID = 'fb75fa8c-6ef0-47cb-b767-3c2cfbb73617';

	constructor(message?: string) {
		super(message ?? 'Access denied');
		this.statusCode = 403;

		Object.defineProperty(this, 'KeetaStorageAnchorAccessDeniedErrorObjectTypeID', {
			value: KeetaStorageAnchorAccessDeniedError.KeetaStorageAnchorAccessDeniedErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorAccessDeniedError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorAccessDeniedErrorObjectTypeID', KeetaStorageAnchorAccessDeniedError.KeetaStorageAnchorAccessDeniedErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorAccessDeniedError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvalidPathError extends KeetaAnchorUserValidationError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidPathError';
	private readonly KeetaStorageAnchorInvalidPathErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidPathErrorObjectTypeID = 'eb0e1c0d-2281-4b93-9f78-87bf166a4829';

	constructor(message?: string) {
		super({ fields: [{ path: 'path', message: message ?? 'Invalid path format' }] }, message ?? 'Invalid path format');

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidPathErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidPathError.KeetaStorageAnchorInvalidPathErrorObjectTypeID,
			enumerable: false
		});
	}

	static override isInstance(input: unknown): input is KeetaStorageAnchorInvalidPathError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidPathErrorObjectTypeID', KeetaStorageAnchorInvalidPathError.KeetaStorageAnchorInvalidPathErrorObjectTypeID));
	}

	static override async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidPathError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

type QuotaExceededType = 'maxObjectSize' | 'maxObjectsPerUser' | 'maxStoragePerUser';

class KeetaStorageAnchorQuotaExceededError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorQuotaExceededError';
	private readonly KeetaStorageAnchorQuotaExceededErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorQuotaExceededErrorObjectTypeID = 'c0b75028-644a-472b-8df4-b0a856814f99';

	/** Which quota limit was exceeded */
	readonly quotaType: QuotaExceededType;

	/** The configured maximum for the exceeded quota */
	readonly limit: number;

	/** The current or attempted value that exceeded the limit */
	readonly current: number;

	constructor(options: { quotaType: QuotaExceededType; limit: number; current: number; message?: string }) {
		super(options.message ?? `Quota exceeded: ${options.quotaType} (${options.current} exceeds limit of ${options.limit})`);
		this.statusCode = 413;
		this.quotaType = options.quotaType;
		this.limit = options.limit;
		this.current = options.current;

		Object.defineProperty(this, 'KeetaStorageAnchorQuotaExceededErrorObjectTypeID', {
			value: KeetaStorageAnchorQuotaExceededError.KeetaStorageAnchorQuotaExceededErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorQuotaExceededError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorQuotaExceededErrorObjectTypeID', KeetaStorageAnchorQuotaExceededError.KeetaStorageAnchorQuotaExceededErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorQuotaExceededError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this({ quotaType: 'maxObjectSize', limit: 0, current: 0, message });
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorPrincipalRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorPrincipalRequiredError';
	private readonly KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID = '12e42092-d4db-435e-8a01-798e26f653b4';

	constructor(message?: string) {
		super(message ?? 'Validated path requires anchor as principal');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID', {
			value: KeetaStorageAnchorPrincipalRequiredError.KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorPrincipalRequiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID', KeetaStorageAnchorPrincipalRequiredError.KeetaStorageAnchorPrincipalRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorPrincipalRequiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorValidationFailedError extends KeetaAnchorUserValidationError {
	static override readonly name: string = 'KeetaStorageAnchorValidationFailedError';
	private readonly KeetaStorageAnchorValidationFailedErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorValidationFailedErrorObjectTypeID = '73cadd95-cf39-466b-b9b6-484e1ae1ca9c';

	constructor(message?: string) {
		const msg = message ?? 'Content validation failed';
		super({ fields: [{ path: 'content', message: msg }] }, msg);

		Object.defineProperty(this, 'KeetaStorageAnchorValidationFailedErrorObjectTypeID', {
			value: KeetaStorageAnchorValidationFailedError.KeetaStorageAnchorValidationFailedErrorObjectTypeID,
			enumerable: false
		});
	}

	override get statusCode() {
		return(422);
	}

	static override isInstance(input: unknown): input is KeetaStorageAnchorValidationFailedError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorValidationFailedErrorObjectTypeID', KeetaStorageAnchorValidationFailedError.KeetaStorageAnchorValidationFailedErrorObjectTypeID));
	}

	static override async fromJSON(input: unknown): Promise<KeetaStorageAnchorValidationFailedError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorSignatureExpiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorSignatureExpiredError';
	private readonly KeetaStorageAnchorSignatureExpiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorSignatureExpiredErrorObjectTypeID = '3a676e44-882b-4925-bf5f-bc5123cc0b20';

	constructor(message?: string) {
		super(message ?? 'Pre-signed URL has expired');
		this.statusCode = 401;

		Object.defineProperty(this, 'KeetaStorageAnchorSignatureExpiredErrorObjectTypeID', {
			value: KeetaStorageAnchorSignatureExpiredError.KeetaStorageAnchorSignatureExpiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorSignatureExpiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorSignatureExpiredErrorObjectTypeID', KeetaStorageAnchorSignatureExpiredError.KeetaStorageAnchorSignatureExpiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorSignatureExpiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorSignatureInvalidError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorSignatureInvalidError';
	private readonly KeetaStorageAnchorSignatureInvalidErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorSignatureInvalidErrorObjectTypeID = '91831c73-31e2-4f27-a9d1-4ab9a5ed5663';

	constructor(message?: string) {
		super(message ?? 'Pre-signed URL signature verification failed');
		this.statusCode = 401;

		Object.defineProperty(this, 'KeetaStorageAnchorSignatureInvalidErrorObjectTypeID', {
			value: KeetaStorageAnchorSignatureInvalidError.KeetaStorageAnchorSignatureInvalidErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorSignatureInvalidError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorSignatureInvalidErrorObjectTypeID', KeetaStorageAnchorSignatureInvalidError.KeetaStorageAnchorSignatureInvalidErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorSignatureInvalidError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorPrivateKeyRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorPrivateKeyRequiredError';
	private readonly KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID = '36eaae98-1b1e-412b-ba5b-b9293cc37156';

	constructor(message?: string) {
		super(message ?? 'Account with private key required for this operation');
		this.statusCode = 401;

		Object.defineProperty(this, 'KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID', {
			value: KeetaStorageAnchorPrivateKeyRequiredError.KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorPrivateKeyRequiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID', KeetaStorageAnchorPrivateKeyRequiredError.KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorPrivateKeyRequiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorServiceUnavailableError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorServiceUnavailableError';
	private readonly KeetaStorageAnchorServiceUnavailableErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorServiceUnavailableErrorObjectTypeID = 'b2671cd1-6abb-4bd4-9be2-d8d111c17bcf';

	constructor(message?: string) {
		super(message ?? 'Storage service not available');
		this.statusCode = 503;

		Object.defineProperty(this, 'KeetaStorageAnchorServiceUnavailableErrorObjectTypeID', {
			value: KeetaStorageAnchorServiceUnavailableError.KeetaStorageAnchorServiceUnavailableErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorServiceUnavailableError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorServiceUnavailableErrorObjectTypeID', KeetaStorageAnchorServiceUnavailableError.KeetaStorageAnchorServiceUnavailableErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorServiceUnavailableError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorSignerRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorSignerRequiredError';
	private readonly KeetaStorageAnchorSignerRequiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorSignerRequiredErrorObjectTypeID = 'ce4a5581-1869-4656-88c6-63f0a29b46ca';

	constructor(message?: string) {
		super(message ?? 'A Signer or UserClient with an associated Signer is required');
		this.statusCode = 401;

		Object.defineProperty(this, 'KeetaStorageAnchorSignerRequiredErrorObjectTypeID', {
			value: KeetaStorageAnchorSignerRequiredError.KeetaStorageAnchorSignerRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorSignerRequiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorSignerRequiredErrorObjectTypeID', KeetaStorageAnchorSignerRequiredError.KeetaStorageAnchorSignerRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorSignerRequiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorAccountRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorAccountRequiredError';
	private readonly KeetaStorageAnchorAccountRequiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorAccountRequiredErrorObjectTypeID = '496e5dbe-535f-4f24-acf4-a44d9d93fb75';

	constructor(message?: string) {
		super(message ?? 'An Account or UserClient with an associated Account is required');
		this.statusCode = 401;

		Object.defineProperty(this, 'KeetaStorageAnchorAccountRequiredErrorObjectTypeID', {
			value: KeetaStorageAnchorAccountRequiredError.KeetaStorageAnchorAccountRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorAccountRequiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorAccountRequiredErrorObjectTypeID', KeetaStorageAnchorAccountRequiredError.KeetaStorageAnchorAccountRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorAccountRequiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorOperationNotSupportedError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorOperationNotSupportedError';
	private readonly KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID = 'ac491ea6-f656-4eab-a430-051a0f201fff';

	constructor(operation?: string) {
		super(operation ? `Storage service does not support '${operation}' operation` : 'Operation not supported');
		this.statusCode = 501;

		Object.defineProperty(this, 'KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID', {
			value: KeetaStorageAnchorOperationNotSupportedError.KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorOperationNotSupportedError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID', KeetaStorageAnchorOperationNotSupportedError.KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorOperationNotSupportedError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorUnsupportedAuthMethodError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorUnsupportedAuthMethodError';
	private readonly KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID = '46cfbab9-934f-44b0-9216-03d397fdd6b6';

	constructor(method?: string) {
		super(method ? `Unsupported authentication method: ${method}` : 'Unsupported authentication method');
		this.statusCode = 501;

		Object.defineProperty(this, 'KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID', {
			value: KeetaStorageAnchorUnsupportedAuthMethodError.KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorUnsupportedAuthMethodError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID', KeetaStorageAnchorUnsupportedAuthMethodError.KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorUnsupportedAuthMethodError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvalidResponseError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidResponseError';
	private readonly KeetaStorageAnchorInvalidResponseErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidResponseErrorObjectTypeID = '02480186-7bc3-4a80-b6a9-23c3a9f606c9';

	constructor(details?: string) {
		super(details ? `Invalid response from storage service: ${details}` : 'Invalid response from storage service');
		this.statusCode = 502;

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidResponseErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidResponseError.KeetaStorageAnchorInvalidResponseErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorInvalidResponseError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidResponseErrorObjectTypeID', KeetaStorageAnchorInvalidResponseError.KeetaStorageAnchorInvalidResponseErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidResponseError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvalidAnchorAccountError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidAnchorAccountError';
	private readonly KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID = '82bb0a94-0a5e-4e0a-b5c1-7532bbe09cd6';

	constructor(publicKey?: string) {
		super(publicKey ? `Invalid anchor account public key: ${publicKey}` : 'Invalid anchor account public key');
		this.statusCode = 502;

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidAnchorAccountError.KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorInvalidAnchorAccountError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID', KeetaStorageAnchorInvalidAnchorAccountError.KeetaStorageAnchorInvalidAnchorAccountErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidAnchorAccountError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvariantViolationError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorInvariantViolationError';
	private readonly KeetaStorageAnchorInvariantViolationErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvariantViolationErrorObjectTypeID = 'a7c5d3e1-8b9f-4c2a-b3d4-e5f6a7b8c9d0';

	constructor(message?: string) {
		super(message ?? 'Internal invariant violation');
		this.statusCode = 500;

		Object.defineProperty(this, 'KeetaStorageAnchorInvariantViolationErrorObjectTypeID', {
			value: KeetaStorageAnchorInvariantViolationError.KeetaStorageAnchorInvariantViolationErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorInvariantViolationError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvariantViolationErrorObjectTypeID', KeetaStorageAnchorInvariantViolationError.KeetaStorageAnchorInvariantViolationErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvariantViolationError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvalidTagError extends KeetaAnchorUserValidationError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidTagError';
	private readonly KeetaStorageAnchorInvalidTagErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidTagErrorObjectTypeID = 'b8d6e4f2-9c0a-5d3b-c4e5-f6a7b8c9d0e1';

	constructor(message?: string) {
		super({ fields: [{ path: 'tags', message: message ?? 'Invalid tag' }] }, message ?? 'Invalid tag');

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidTagErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidTagError.KeetaStorageAnchorInvalidTagErrorObjectTypeID,
			enumerable: false
		});
	}

	static override isInstance(input: unknown): input is KeetaStorageAnchorInvalidTagError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidTagErrorObjectTypeID', KeetaStorageAnchorInvalidTagError.KeetaStorageAnchorInvalidTagErrorObjectTypeID));
	}

	static override async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidTagError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorInvalidMetadataError extends KeetaAnchorUserValidationError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidMetadataError';
	private readonly KeetaStorageAnchorInvalidMetadataErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidMetadataErrorObjectTypeID = 'c9e7f5a3-0d1b-6e4c-d5f6-a7b8c9d0e1f2';

	constructor(reason?: string) {
		const message = reason ? `Invalid metadata: ${reason}` : 'Invalid metadata';
		super({ fields: [{ path: 'metadata', message }] }, message);

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidMetadataErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidMetadataError.KeetaStorageAnchorInvalidMetadataErrorObjectTypeID,
			enumerable: false
		});
	}

	static override isInstance(input: unknown): input is KeetaStorageAnchorInvalidMetadataError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidMetadataErrorObjectTypeID', KeetaStorageAnchorInvalidMetadataError.KeetaStorageAnchorInvalidMetadataErrorObjectTypeID));
	}

	static override async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidMetadataError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	DocumentNotFound: typeof KeetaStorageAnchorDocumentNotFoundError;
	AccessDenied: typeof KeetaStorageAnchorAccessDeniedError;
	InvalidPath: typeof KeetaStorageAnchorInvalidPathError;
	QuotaExceeded: typeof KeetaStorageAnchorQuotaExceededError;
	AnchorPrincipalRequired: typeof KeetaStorageAnchorPrincipalRequiredError;
	ValidationFailed: typeof KeetaStorageAnchorValidationFailedError;
	SignatureExpired: typeof KeetaStorageAnchorSignatureExpiredError;
	SignatureInvalid: typeof KeetaStorageAnchorSignatureInvalidError;
	PrivateKeyRequired: typeof KeetaStorageAnchorPrivateKeyRequiredError;
	ServiceUnavailable: typeof KeetaStorageAnchorServiceUnavailableError;
	SignerRequired: typeof KeetaStorageAnchorSignerRequiredError;
	AccountRequired: typeof KeetaStorageAnchorAccountRequiredError;
	OperationNotSupported: typeof KeetaStorageAnchorOperationNotSupportedError;
	UnsupportedAuthMethod: typeof KeetaStorageAnchorUnsupportedAuthMethodError;
	InvalidResponse: typeof KeetaStorageAnchorInvalidResponseError;
	InvalidAnchorAccount: typeof KeetaStorageAnchorInvalidAnchorAccountError;
	InvariantViolation: typeof KeetaStorageAnchorInvariantViolationError;
	InvalidTag: typeof KeetaStorageAnchorInvalidTagError;
	InvalidMetadata: typeof KeetaStorageAnchorInvalidMetadataError;
} = {
	/**
	 * The requested document/object was not found
	 */
	DocumentNotFound: KeetaStorageAnchorDocumentNotFoundError,

	/**
	 * Access to the document/object was denied
	 */
	AccessDenied: KeetaStorageAnchorAccessDeniedError,

	/**
	 * Path doesn't match /user/<pubkey>/... format
	 */
	InvalidPath: KeetaStorageAnchorInvalidPathError,

	/**
	 * Object size, count, or total storage limit exceeded
	 */
	QuotaExceeded: KeetaStorageAnchorQuotaExceededError,

	/**
	 * Validated path requires anchor as principal
	 */
	AnchorPrincipalRequired: KeetaStorageAnchorPrincipalRequiredError,

	/**
	 * Namespace validator rejected content
	 */
	ValidationFailed: KeetaStorageAnchorValidationFailedError,

	/**
	 * Pre-signed URL has expired
	 */
	SignatureExpired: KeetaStorageAnchorSignatureExpiredError,

	/**
	 * Pre-signed URL signature verification failed
	 */
	SignatureInvalid: KeetaStorageAnchorSignatureInvalidError,

	/**
	 * Account with private key required for this operation
	 */
	PrivateKeyRequired: KeetaStorageAnchorPrivateKeyRequiredError,

	/**
	 * Storage service is not available
	 */
	ServiceUnavailable: KeetaStorageAnchorServiceUnavailableError,

	/**
	 * A Signer or UserClient with an associated Signer is required
	 */
	SignerRequired: KeetaStorageAnchorSignerRequiredError,

	/**
	 * An Account or UserClient with an associated Account is required
	 */
	AccountRequired: KeetaStorageAnchorAccountRequiredError,

	/**
	 * The requested operation is not supported by this storage service
	 */
	OperationNotSupported: KeetaStorageAnchorOperationNotSupportedError,

	/**
	 * The authentication method is not supported
	 */
	UnsupportedAuthMethod: KeetaStorageAnchorUnsupportedAuthMethodError,

	/**
	 * Invalid response received from storage service
	 */
	InvalidResponse: KeetaStorageAnchorInvalidResponseError,

	/**
	 * Anchor account public key from service metadata is invalid
	 */
	InvalidAnchorAccount: KeetaStorageAnchorInvalidAnchorAccountError,

	/**
	 * Internal invariant violation - indicates a bug in the code
	 */
	InvariantViolation: KeetaStorageAnchorInvariantViolationError,

	/**
	 * Tag validation failed (invalid format, too long, or too many tags)
	 */
	InvalidTag: KeetaStorageAnchorInvalidTagError,

	/**
	 * Metadata validation failed against path policy constraints
	 */
	InvalidMetadata: KeetaStorageAnchorInvalidMetadataError
};

// #endregion

// #region Storage Backend Interface

/**
 * Metadata input for put operations.
 * Provided by the client when storing an object.
 */
export type StoragePutMetadata = {
	/** Owner's identifier */
	owner: string;
	/** Tags for categorization and search */
	tags: string[];
	/** Access visibility setting */
	visibility: StorageObjectVisibility;
};

/**
 * Result of a get operation.
 * Contains both the raw encrypted data and the object metadata.
 */
export type StorageGetResult = {
	/** Raw encrypted data (EncryptedContainer) */
	data: Buffer;
	/** Object metadata */
	metadata: StorageObjectMetadata;
};

/**
 * Represents a pending upload quota reservation.
 * Used to reserve quota before an upload and track in-flight uploads.
 */
export interface UploadReservation {
	/** Unique identifier for this reservation */
	id: string;
	/** Owner's identifier */
	owner: string;
	/** Target path for the upload */
	path: string;
	/** Reserved size in bytes */
	size: number;
	/** When the reservation was created */
	createdAt: string;
	/** When the reservation expires - hint for stale cleanup */
	expiresAt: string;
}

/**
 * Core CRUD operations for storage.
 * All backends must implement these operations.
 */
export interface StorageBackend {
	/**
	 * Store/update an object at the given path
	 */
	put(path: string, data: Buffer, metadata: StoragePutMetadata): Promise<StorageObjectMetadata>;

	/**
	 * Retrieve an object by path
	 */
	get(path: string): Promise<StorageGetResult | null>;

	/**
	 * Delete an object by path
	 */
	delete(path: string): Promise<boolean>;
}

/**
 * Search capability interface.
 * Optional for backends that don't support indexing (e.g., simple S3-only backends).
 */
export interface SearchableStorage {
	/**
	 * Search for objects matching criteria
	 */
	search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults>;
}

/**
 * Quota management with upload reservations.
 * Handles quota tracking and reservation-based upload flow.
 */
export interface QuotaManagedStorage {
	/**
	 * Get quota status for a user.
	 * Includes both actual usage and pending reservations.
	 */
	getQuotaStatus(owner: string): Promise<QuotaStatus>;

	/**
	 * Get per-user quota limits.
	 * Return null to use global defaults.
	 * @param owner - Owner's identifier
	 */
	getQuotaLimits?(owner: string): Promise<QuotaLimits | null>;

	/**
	 * Reserve quota for an upcoming upload.
	 *
	 * @param owner - Owner's identifier
	 * @param path - Target path for the upload
	 * @param size - Size in bytes to reserve
	 * @param options.ttlMs - Optional TTL in milliseconds for the reservation
	 * @param options.quotaLimits - Optional quota limits to enforce (overrides backend defaults)
	 *
	 * @returns Reservation that must be committed or released
	 *
	 * @throws QuotaExceeded if reservation would exceed limits
	 */
	reserveUpload(owner: string, path: string, size: number, options?: {
		ttlMs?: number;
		quotaLimits?: Pick<QuotaConfig, 'maxObjectsPerUser' | 'maxStoragePerUser'>;
	}): Promise<UploadReservation>;

	/**
	 * Commit a reservation after successful upload.
	 * Call after put() succeeds to finalize the quota usage.
	 * @param reservationId - ID of the reservation to commit
	 */
	commitUpload(reservationId: string): Promise<void>;

	/**
	 * Release a reservation (upload failed or cancelled).
	 * Frees the reserved quota.
	 * @param reservationId - ID of the reservation to release
	 */
	releaseUpload(reservationId: string): Promise<void>;
}

/**
 * Full storage backend combining all capabilities.
 * Use this type when a backend supports CRUD, search, and quota management.
 */
export type FullStorageBackend = StorageBackend & SearchableStorage & QuotaManagedStorage;

// #endregion

// #region Path Policy

/**
 * Generic interface for path policies.
 * Each implementation defines its own parsed type and access control logic.
 * Storage Anchors are free to implement whatever pathname structure they wish.
 */
export interface PathPolicy<TPathInfo> {
	/**
	 * Parse a path into its components.
	 * @returns TPathInfo if valid, null otherwise
	 */
	parse(path: string): TPathInfo | null;

	/**
	 * Validate a path and return its components.
	 * @throws Errors.InvalidPath if the path is invalid
	 */
	validate(path: string): TPathInfo;

	/**
	 * Check if a path is valid.
	 */
	isValid(path: string): boolean;

	/**
	 * Check if the account has access to perform the operation on the parsed path.
	 * @returns true if access is allowed, false otherwise
	 */
	checkAccess(account: KeetaNetAccount, parsed: TPathInfo, operation: 'get' | 'put' | 'delete' | 'search' | 'metadata'): boolean;

	/**
	 * Get the public key of the account authorized to sign pre-signed URLs for this path.
	 * Used for public object access verification.
	 *
	 * @returns The public key string if only that account can sign (owner-restricted), or `null` if any account can sign
	 */
	getAuthorizedSigner(parsed: TPathInfo): string | null;

	/**
	 * Validate metadata for a path.
	 * Called during PUT and metadata update operations.
	 * @param parsed - The parsed path info
	 * @param metadata - The metadata to validate
	 * @throws Errors.InvalidMetadata if metadata violates path constraints
	 */
	validateMetadata?(parsed: TPathInfo, metadata: StoragePutMetadata): void;
}

// #endregion

// #region Container Payload Utilities

/**
 * Parse the decrypted plaintext from an EncryptedContainer.
 * The payload is expected to be JSON with mimeType and base64-encoded data,
 * keeping the mimeType encrypted along with the content.
 *
 * @param plaintext - The decrypted plaintext from an EncryptedContainer
 *
 * @returns Object containing mimeType and content Buffer
 */
export function parseContainerPayload(plaintext: ArrayBuffer): { mimeType: string; content: Buffer } {
	const payloadStr = Buffer.from(plaintext).toString('utf-8');
	try {
		const payload: unknown = JSON.parse(payloadStr);
		let mimeType = CONTENT_TYPE_OCTET_STREAM;
		let content: Buffer;
		if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
			const payloadMime = 'mimeType' in payload ? payload.mimeType : undefined;
			const payloadData = 'data' in payload ? payload.data : undefined;
			if (typeof payloadMime === 'string') {
				mimeType = payloadMime;
			}
			if (typeof payloadData === 'string') {
				content = arrayBufferLikeToBuffer(Buffer.from(payloadData, 'base64'));
			} else {
				content = arrayBufferLikeToBuffer(plaintext);
			}
		} else {
			content = arrayBufferLikeToBuffer(plaintext);
		}
		return({ mimeType, content });
	} catch {
		return({
			mimeType: CONTENT_TYPE_OCTET_STREAM,
			content: arrayBufferLikeToBuffer(plaintext)
		});
	}
}

// #endregion
