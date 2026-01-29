import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createIs, createAssert } from 'typia';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { Buffer, arrayBufferLikeToBuffer } from '../../lib/utils/buffer.js';

export type KeetaNetAccount = InstanceType<typeof KeetaNetLib.Account>;

// #region Path Types

/**
 * User path format: /user/<keeta_publicKey>/<...path>
 * The full path (including filename) is the unique ID, like S3.
 */
export type UserPath = `/user/${string}/${string}`;

/**
 * All storage paths (currently only user paths are supported)
 */
export type StoragePath = UserPath;

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
	path: StoragePath;

	/**
	 * Owner's public key string (extracted from path)
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
	 * Size in bytes (string for JSON serialization of large values)
	 */
	size: string;

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
 * Current quota status for a user
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
	 * Remaining objects allowed
	 */
	remainingObjects: number;

	/**
	 * Remaining storage in bytes
	 */
	remainingSize: number;
};

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

export type KeetaStorageAnchorPutResponse = {
	ok: true;
	object: StorageObjectMetadata;
} | {
	ok: false;
	error: string;
};

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

export type KeetaStorageAnchorGetResponse = {
	ok: true;
	data: string;  // Base64-encoded EncryptedContainer
	object: StorageObjectMetadata;
} | {
	ok: false;
	error: string;
};

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

export type KeetaStorageAnchorDeleteResponse = {
	ok: true;
	deleted: boolean;
} | {
	ok: false;
	error: string;
};

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

export type KeetaStorageAnchorSearchResponse = {
	ok: true;
	results: StorageObjectMetadata[];
	nextCursor?: string;
} | {
	ok: false;
	error: string;
};

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

export type KeetaStorageAnchorQuotaResponse = {
	ok: true;
	quota: QuotaStatus;
} | {
	ok: false;
	error: string;
};

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

class KeetaStorageAnchorInvalidPathError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorInvalidPathError';
	private readonly KeetaStorageAnchorInvalidPathErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorInvalidPathErrorObjectTypeID = 'eb0e1c0d-2281-4b93-9f78-87bf166a4829';

	constructor(message?: string) {
		super(message ?? 'Invalid path format');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaStorageAnchorInvalidPathErrorObjectTypeID', {
			value: KeetaStorageAnchorInvalidPathError.KeetaStorageAnchorInvalidPathErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorInvalidPathError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorInvalidPathErrorObjectTypeID', KeetaStorageAnchorInvalidPathError.KeetaStorageAnchorInvalidPathErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorInvalidPathError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorQuotaExceededError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorQuotaExceededError';
	private readonly KeetaStorageAnchorQuotaExceededErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorQuotaExceededErrorObjectTypeID = 'c0b75028-644a-472b-8df4-b0a856814f99';

	constructor(message?: string) {
		super(message ?? 'Quota exceeded');
		this.statusCode = 413;

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
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorAnchorPrincipalRequiredError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorAnchorPrincipalRequiredError';
	private readonly KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID = '12e42092-d4db-435e-8a01-798e26f653b4';

	constructor(message?: string) {
		super(message ?? 'Validated path requires anchor as principal');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID', {
			value: KeetaStorageAnchorAnchorPrincipalRequiredError.KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorAnchorPrincipalRequiredError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID', KeetaStorageAnchorAnchorPrincipalRequiredError.KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorAnchorPrincipalRequiredError> {
		const { message, other } = this.extractErrorProperties(input, this);
		const error = new this(message);
		error.restoreFromJSON(other);
		return(error);
	}
}

class KeetaStorageAnchorValidationFailedError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaStorageAnchorValidationFailedError';
	private readonly KeetaStorageAnchorValidationFailedErrorObjectTypeID!: string;
	private static readonly KeetaStorageAnchorValidationFailedErrorObjectTypeID = '73cadd95-cf39-466b-b9b6-484e1ae1ca9c';

	constructor(message?: string) {
		super(message ?? 'Content validation failed');
		this.statusCode = 422;

		Object.defineProperty(this, 'KeetaStorageAnchorValidationFailedErrorObjectTypeID', {
			value: KeetaStorageAnchorValidationFailedError.KeetaStorageAnchorValidationFailedErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaStorageAnchorValidationFailedError {
		return(this.hasPropWithValue(input, 'KeetaStorageAnchorValidationFailedErrorObjectTypeID', KeetaStorageAnchorValidationFailedError.KeetaStorageAnchorValidationFailedErrorObjectTypeID));
	}

	static async fromJSON(input: unknown): Promise<KeetaStorageAnchorValidationFailedError> {
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

export const Errors: {
	DocumentNotFound: typeof KeetaStorageAnchorDocumentNotFoundError;
	AccessDenied: typeof KeetaStorageAnchorAccessDeniedError;
	InvalidPath: typeof KeetaStorageAnchorInvalidPathError;
	QuotaExceeded: typeof KeetaStorageAnchorQuotaExceededError;
	AnchorPrincipalRequired: typeof KeetaStorageAnchorAnchorPrincipalRequiredError;
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
	AnchorPrincipalRequired: KeetaStorageAnchorAnchorPrincipalRequiredError,

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
	InvalidAnchorAccount: KeetaStorageAnchorInvalidAnchorAccountError
};

// #endregion

// #region Storage Backend Interface

/**
 * Metadata input for put operations
 */
export type StoragePutMetadata = {
	owner: string;
	tags: string[];
	visibility: StorageObjectVisibility;
};

/**
 * Result of a get operation
 */
export type StorageGetResult = {
	data: Buffer;
	metadata: StorageObjectMetadata;
};

/**
 * Interface for atomic storage operations.
 * Provides the same operations as StorageBackend but within an atomic scope.
 */
export interface StorageAtomicInterface {
	/**
	 * Store/update an object at the given path
	 */
	put(path: StoragePath, data: Buffer, metadata: StoragePutMetadata): Promise<StorageObjectMetadata>;

	/**
	 * Retrieve an object by path
	 */
	get(path: StoragePath): Promise<StorageGetResult | null>;

	/**
	 * Delete an object by path
	 */
	delete(path: StoragePath): Promise<boolean>;

	/**
	 * Search for objects matching criteria
	 */
	search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults>;

	/**
	 * Get quota status for a user
	 */
	getQuotaStatus(owner: string): Promise<QuotaStatus>;

	/**
	 * Commit the atomic operation - applies all changes
	 */
	commit(): Promise<void>;

	/**
	 * Rollback the atomic operation - discards all changes
	 */
	rollback(): Promise<void>;
}

/**
 * Storage backend interface for the path-based API.
 */
export interface StorageBackend {
	/**
	 * Store/update an object at the given path
	 */
	put(path: StoragePath, data: Buffer, metadata: StoragePutMetadata): Promise<StorageObjectMetadata>;

	/**
	 * Retrieve an object by path
	 */
	get(path: StoragePath): Promise<StorageGetResult | null>;

	/**
	 * Delete an object by path
	 */
	delete(path: StoragePath): Promise<boolean>;

	/**
	 * Search for objects matching criteria
	 */
	search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults>;

	/**
	 * Get quota status for a user
	 */
	getQuotaStatus(owner: string): Promise<QuotaStatus>;

	/**
	 * Begin an atomic operation scope.
	 * All operations within the scope are isolated until commit() is called.
	 */
	beginAtomic(): Promise<StorageAtomicInterface>;

	/**
	 * Execute a function within an atomic scope.
	 * Auto-commits on success, auto-rollbacks on error.
	 */
	withAtomic<T>(fn: (atomic: StorageAtomicInterface) => Promise<T>): Promise<T>;
}

// #endregion

// #region Path Policy

/**
 * Parsed components of a storage path
 */
export type ParsedStoragePath = {
	path: StoragePath;
	owner: string;
	relativePath: string;
};

/**
 * Access event for audit logging
 */
export interface AccessEvent {
	operation: 'get' | 'put' | 'delete' | 'search' | 'metadata';
	account: string;
	path: string;
	allowed: boolean;
	timestamp: number;
}

/**
 * Configuration for PathPolicy
 */
export interface PathPolicyConfig {
	/**
	 * Pattern for valid storage paths.
	 * Default: /^\/user\/([^/]+)\/(.+)$/ (matches /user/<pubkey>/<path>)
	 */
	pattern?: RegExp;

	/**
	 * Extract owner from regex match.
	 * Default: match[1]
	 */
	extractOwner?: (match: RegExpMatchArray) => string;

	/**
	 * Extract relative path from regex match.
	 * Default: match[2]
	 */
	extractRelativePath?: (match: RegExpMatchArray) => string;

	/**
	 * Get namespace prefix for an owner.
	 * Default: `/user/${owner}/`
	 */
	namespacePrefix?: (owner: string) => string;

	/**
	 * Optional logger for access events
	 */
	logger?: (event: AccessEvent) => void;
}

/**
 * PathPolicy handles path parsing, validation, access control, and optional audit logging.
 * Replaces standalone parseStoragePath, validateStoragePath, isValidStoragePath functions.
 */
export class PathPolicy {
	readonly #pattern: RegExp;
	readonly #extractOwner: (match: RegExpMatchArray) => string;
	readonly #extractRelativePath: (match: RegExpMatchArray) => string;
	readonly #namespacePrefix: (owner: string) => string;
	readonly #logger: ((event: AccessEvent) => void) | undefined;

	constructor(config?: PathPolicyConfig) {
		this.#pattern = config?.pattern ?? /^\/user\/([^/]+)\/(.+)$/;
		this.#extractOwner = config?.extractOwner ?? function(match) { return(match[1] ?? ''); };
		this.#extractRelativePath = config?.extractRelativePath ?? function(match) { return(match[2] ?? ''); };
		this.#namespacePrefix = config?.namespacePrefix ?? function(owner) { return(`/user/${owner}/`); };
		this.#logger = config?.logger;
	}

	/**
	 * Parse a path into its components.
	 * @returns ParsedStoragePath if valid, null otherwise
	 */
	parse(path: string): ParsedStoragePath | null {
		const match = path.match(this.#pattern);
		if (!match) {
			return(null);
		}

		const owner = this.#extractOwner(match);
		const relativePath = this.#extractRelativePath(match);
		if (!owner || !relativePath) {
			return(null);
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return({ path: path as StoragePath, owner, relativePath });
	}

	/**
	 * Validate a path and return its components.
	 * @throws Errors.InvalidPath if the path is invalid
	 */
	validate(path: string): ParsedStoragePath {
		const parsed = this.parse(path);
		if (!parsed) {
			throw(new Errors.InvalidPath('Path must match the required format'));
		}

		return(parsed);
	}

	/**
	 * Check if a path is valid.
	 */
	isValid(path: string): path is StoragePath {
		return(this.parse(path) !== null);
	}

	/**
	 * Get the namespace prefix for an owner.
	 */
	getNamespacePrefix(owner: string): string {
		return(this.#namespacePrefix(owner));
	}

	/**
	 * Validate path and check that the account owns the namespace.
	 * Logs the access event if a logger is configured.
	 * @throws Errors.InvalidPath if path is invalid
	 * @throws Errors.AccessDenied if account doesn't own the namespace
	 */
	assertAccess(account: KeetaNetAccount, path: string, operation?: AccessEvent['operation']): ParsedStoragePath {
		const parsed = this.validate(path);
		const accountPubKey = account.publicKeyString.get();
		const allowed = parsed.owner === accountPubKey;

		if (this.#logger && operation) {
			this.#logger({
				operation,
				account: accountPubKey,
				path,
				allowed,
				timestamp: Date.now()
			});
		}

		if (!allowed) {
			throw(new Errors.AccessDenied('Can only access your own namespace'));
		}

		return(parsed);
	}

	/**
	 * Validate that search criteria is within the account's namespace.
	 * Logs the access event if a logger is configured.
	 * @throws Errors.AccessDenied if criteria targets another user's namespace
	 */
	assertSearchAccess(account: KeetaNetAccount, criteria: SearchCriteria): void {
		const accountPubKey = account.publicKeyString.get();
		const namespacePrefix = this.getNamespacePrefix(accountPubKey);

		// Determine if access is allowed
		const ownerMismatch = criteria.owner !== undefined && criteria.owner !== accountPubKey;
		const prefixMismatch = criteria.pathPrefix !== undefined && !criteria.pathPrefix.startsWith(namespacePrefix);
		const allowed = !ownerMismatch && !prefixMismatch;

		// Log before throwing (so denied attempts are also logged)
		if (this.#logger) {
			this.#logger({
				operation: 'search',
				account: accountPubKey,
				path: criteria.pathPrefix ?? namespacePrefix,
				allowed,
				timestamp: Date.now()
			});
		}

		// Throw if denied
		if (ownerMismatch) {
			throw(new Errors.AccessDenied('Can only search your own namespace'));
		}
		if (prefixMismatch) {
			throw(new Errors.AccessDenied('Can only search within your own namespace'));
		}
	}

	/**
	 * Constructs a StoragePath from owner and relative path
	 */
	makePath(owner: string, relativePath: string): StoragePath {
		return(`/user/${owner}/${relativePath}`);
	}
}

/**
 * Default PathPolicy instance with standard /user/<pubkey>/<path> format
 */
export const defaultPathPolicy: PathPolicy = new PathPolicy();

// #endregion

// #region Container Payload Utilities

/**
 * Parse an encrypted container payload to extract mime-type and content.
 * The expected payload structure is: { mimeType: string, data: base64 string }
 * Falls back to raw plaintext with application/octet-stream if not valid JSON.
 *
 * @param plaintext - The decrypted plaintext from an EncryptedContainer
 * @returns The parsed mimeType and content
 */
export function parseContainerPayload(plaintext: ArrayBuffer): { mimeType: string; content: Buffer } {
	const payloadStr = Buffer.from(plaintext).toString('utf-8');
	try {
		const payload: unknown = JSON.parse(payloadStr);
		let mimeType = 'application/octet-stream';
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
		// If not JSON, return raw plaintext as content
		return({
			mimeType: 'application/octet-stream',
			content: arrayBufferLikeToBuffer(plaintext)
		});
	}
}

// #endregion
