import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { createIs, createAssert } from 'typia';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { KeetaAnchorUserError } from '../../lib/error.js';

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
	input: KeetaStorageAnchorPutRequest
): Signable {
	return(['put', input.path, input.data]);
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
	return(['search', JSON.stringify(input.criteria)]);
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
	private static readonly KeetaStorageAnchorDocumentNotFoundErrorObjectTypeID = 'b8f3e7a2-4d91-4c8b-9e6a-3f5d2c1b0a98';

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
	private static readonly KeetaStorageAnchorAccessDeniedErrorObjectTypeID = 'c9d4f8b3-5e02-4d9c-af7b-4g6e3d2c1b09';

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
	private static readonly KeetaStorageAnchorInvalidPathErrorObjectTypeID = 'd0e5f9c4-6f13-4e0d-b08c-5h7f4e3d2c10';

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
	private static readonly KeetaStorageAnchorQuotaExceededErrorObjectTypeID = 'e1f6g0d5-7g24-5f1e-c19d-6i8g5f4e3d21';

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
	private static readonly KeetaStorageAnchorAnchorPrincipalRequiredErrorObjectTypeID = 'f2g7h1e6-8h35-6g2f-d20e-7j9h6g5f4e32';

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
	private static readonly KeetaStorageAnchorValidationFailedErrorObjectTypeID = 'g3h8i2f7-9i46-7h3g-e31f-8k0i7h6g5f43';

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
	private static readonly KeetaStorageAnchorSignatureExpiredErrorObjectTypeID = 'h4i9j3g8-0j57-8i4h-f42g-9l1j8i7h6g54';

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
	private static readonly KeetaStorageAnchorSignatureInvalidErrorObjectTypeID = 'i5j0k4h9-1k68-9j5i-g53h-0m2k9j8i7h65';

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
	private static readonly KeetaStorageAnchorPrivateKeyRequiredErrorObjectTypeID = 'j6k1l5i0-2l79-0k6j-h64i-1n3l0k9j8i76';

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
	private static readonly KeetaStorageAnchorServiceUnavailableErrorObjectTypeID = 'a7b2c3d4-5e6f-7g8h-9i0j-1k2l3m4n5o6p';

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
	private static readonly KeetaStorageAnchorSignerRequiredErrorObjectTypeID = 'b8c3d4e5-6f7g-8h9i-0j1k-2l3m4n5o6p7q';

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
	private static readonly KeetaStorageAnchorAccountRequiredErrorObjectTypeID = 'c9d4e5f6-7g8h-9i0j-1k2l-3m4n5o6p7q8r';

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
	private static readonly KeetaStorageAnchorOperationNotSupportedErrorObjectTypeID = 'd0e1f2a3-4b5c-6d7e-8f9a-0b1c2d3e4f5a';

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
	private static readonly KeetaStorageAnchorUnsupportedAuthMethodErrorObjectTypeID = 'e1f2a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

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
	private static readonly KeetaStorageAnchorInvalidResponseErrorObjectTypeID = 'f2a3b4c5-6d7e-8f9a-0b1c-2d3e4f5a6b7c';

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
	InvalidResponse: KeetaStorageAnchorInvalidResponseError
};

// #endregion

// #region Storage Backend Interface

/**
 * Storage backend interface for the path-based API.
 */
export interface StorageBackend {
	/**
	 * Store/update an object at the given path
	 */
	put(path: StoragePath, data: Buffer, metadata: {
		owner: string;
		tags: string[];
		visibility: StorageObjectVisibility;
	}): Promise<StorageObjectMetadata>;

	/**
	 * Retrieve an object by path
	 */
	get(path: StoragePath): Promise<{
		data: Buffer;
		metadata: StorageObjectMetadata;
	} | null>;

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
}

// #endregion

// #region Path Utilities

/**
 * Pattern for valid storage paths: /user/<publicKey>/<...path>
 * - Group 1: owner's public key
 * - Group 2: relative path within user's namespace
 */
const STORAGE_PATH_PATTERN = /^\/user\/([^/]+)\/(.+)$/;

/**
 * Parsed components of a storage path
 */
export type ParsedStoragePath = {
	path: StoragePath;
	owner: string;
	relativePath: string;
};

/**
 * Parses a path into its components if valid.
 * @returns ParsedStoragePath if valid, null otherwise
 */
export function parseStoragePath(path: string): ParsedStoragePath | null {
	const match = path.match(STORAGE_PATH_PATTERN);
	if (match?.[1] === undefined || match[2] === undefined) {
		return(null);
	}
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return({ path: path as StoragePath, owner: match[1], relativePath: match[2] });
}

/**
 * Validates that a path matches the required format: /user/<publicKey>/<...path>
 * Returns the extracted owner public key if valid, throws InvalidPath error if not.
 */
export function validateStoragePath(path: string): ParsedStoragePath {
	const parsed = parseStoragePath(path);
	if (!parsed) {
		throw(new Errors.InvalidPath('Path must be /user/<publicKey>/<...path>'));
	}
	return(parsed);
}

/**
 * Checks if a path is a valid StoragePath (without throwing)
 */
export function isValidStoragePath(path: string): path is StoragePath {
	return(parseStoragePath(path) !== null);
}

/**
 * Constructs a StoragePath from owner and relative path
 */
export function makeStoragePath(owner: string, relativePath: string): StoragePath {

	return(`/user/${owner}/${relativePath}`);
}

// #endregion
