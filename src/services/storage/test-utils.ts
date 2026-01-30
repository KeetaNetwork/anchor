import type { KeetaNet } from '../../client/index.js';
import type {
	PathPolicy,
	FullStorageBackend,
	StorageObjectMetadata,
	StoragePutMetadata,
	StorageGetResult,
	SearchCriteria,
	SearchPagination,
	SearchResults,
	QuotaStatus,
	UploadReservation
} from './common.js';
import { Errors } from './common.js';
import { Buffer } from '../../lib/utils/buffer.js';

// #region Test Path Policy

/**
 * Parsed path for the test path policy: /user/<pubkey>/<relativePath>
 */
export type TestParsedPath = {
	path: string;
	owner: string;
	relativePath: string;
};

/**
 * Test path policy implementing the /user/<pubkey>/<path> pattern.
 * Owner-based access control: only the owner can access their namespace.
 */
export class TestPathPolicy implements PathPolicy<TestParsedPath> {
	// Matches /user/<owner> or /user/<owner>/ or /user/<owner>/<path>
	readonly #pattern = /^\/user\/([^/]+)(\/(.*))?$/;

	parse(path: string): TestParsedPath | null {
		const match = path.match(this.#pattern);
		if (!match?.[1]) {
			return(null);
		}
		return({ path, owner: match[1], relativePath: match[3] ?? '' });
	}

	validate(path: string): TestParsedPath {
		const parsed = this.parse(path);
		if (!parsed) {
			throw(new Errors.InvalidPath('Path must match /user/<pubkey>/<path>'));
		}
		return(parsed);
	}

	isValid(path: string): boolean {
		return(this.parse(path) !== null);
	}

	checkAccess(
		account: InstanceType<typeof KeetaNet.lib.Account>,
		parsed: TestParsedPath,
		_ignoreOperation: 'get' | 'put' | 'delete' | 'search' | 'metadata'
	): boolean {
		// Owner-based access: account must match the path owner
		return(parsed.owner === account.publicKeyString.get());
	}

	getAuthorizedSigner(parsed: TestParsedPath): string | null {
		// The owner is the authorized signer for pre-signed URLs
		return(parsed.owner);
	}

	/**
	 * Helper to construct a path for a given owner and relative path.
	 */
	makePath(owner: string, relativePath: string): string {
		return(`/user/${owner}/${relativePath}`);
	}

	/**
	 * Helper to get the namespace prefix for an owner.
	 */
	getNamespacePrefix(owner: string): string {
		return(`/user/${owner}/`);
	}
}

/**
 * Shared instance of TestPathPolicy for use in tests.
 */
export const testPathPolicy: TestPathPolicy = new TestPathPolicy();

// #endregion

// #region Types

type StorageEntry = {
	data: Buffer;
	metadata: StorageObjectMetadata;
};

type QuotaConfig = {
	maxObjectsPerUser: number;
	maxStoragePerUser: number;
};

// #endregion

// #region Shared Storage Operations

function putToStorage(
	storage: Map<string, StorageEntry>,
	path: string,
	data: Buffer,
	metadata: StoragePutMetadata
): StorageObjectMetadata {
	const now = new Date().toISOString();
	const existing = storage.get(path);
	const objectMetadata: StorageObjectMetadata = {
		path,
		owner: metadata.owner,
		tags: metadata.tags,
		visibility: metadata.visibility,
		size: String(data.length),
		createdAt: existing?.metadata.createdAt ?? now,
		...(existing ? { updatedAt: now } : {})
	};

	storage.set(path, { data, metadata: objectMetadata });
	return(objectMetadata);
}

function getFromStorage(
	storage: Map<string, StorageEntry>,
	path: string
): StorageGetResult | null {
	const entry = storage.get(path);
	if (!entry) {
		return(null);
	}

	return({
		data: Buffer.from(entry.data),
		metadata: { ...entry.metadata }
	});
}

function searchStorage(
	storage: Map<string, StorageEntry>,
	criteria: SearchCriteria,
	pagination: SearchPagination
): SearchResults {
	const results: StorageObjectMetadata[] = [];
	const limit = pagination.limit ?? 100;
	const startAfter = pagination.cursor;
	let foundCursor = !startAfter;

	for (const [path, entry] of storage.entries()) {
		if (!foundCursor) {
			if (path === startAfter) {
				foundCursor = true;
			}
			continue;
		}

		const metadata = entry.metadata;

		if (criteria.pathPrefix) {
			const prefix = criteria.pathPrefix.endsWith('/')
				? criteria.pathPrefix
				: criteria.pathPrefix + '/';
			if (!path.startsWith(prefix) && path !== criteria.pathPrefix) {
				continue;
			}
			if (!criteria.recursive) {
				const remainder = path.slice(prefix.length);
				if (remainder.includes('/')) {
					continue;
				}
			}
		}

		if (criteria.owner && metadata.owner !== criteria.owner) {
			continue;
		}

		if (criteria.tags && criteria.tags.length > 0) {
			const hasMatchingTag = criteria.tags.some(function(tag) {
				return(metadata.tags.includes(tag));
			});
			if (!hasMatchingTag) {
				continue;
			}
		}

		if (criteria.name) {
			const filename = path.split('/').pop();
			if (!filename?.includes(criteria.name)) {
				continue;
			}
		}

		if (criteria.visibility && metadata.visibility !== criteria.visibility) {
			continue;
		}

		results.push(metadata);

		if (results.length >= limit) {
			return({ results, nextCursor: path });
		}
	}

	return({ results });
}

function computeQuotaStatus(
	storage: Map<string, StorageEntry>,
	owner: string,
	quotaConfig: QuotaConfig
): QuotaStatus {
	let objectCount = 0;
	let totalSize = 0;
	for (const entry of storage.values()) {
		if (entry.metadata.owner === owner) {
			objectCount++;
			totalSize += parseInt(entry.metadata.size, 10);
		}
	}

	return({
		objectCount,
		totalSize,
		remainingObjects: Math.max(0, quotaConfig.maxObjectsPerUser - objectCount),
		remainingSize: Math.max(0, quotaConfig.maxStoragePerUser - totalSize)
	});
}

// #endregion

// #region Memory Storage Backend

/**
 * In-memory storage backend with full capabilities: CRUD, search, and quota management.
 * Intended for testing and development purposes.
 */
export class MemoryStorageBackend implements FullStorageBackend {
	private storage = new Map<string, StorageEntry>();
	private reservations = new Map<string, UploadReservation>();
	private reservationCounter = 0;

	private readonly quotaConfig: QuotaConfig = {
		maxObjectsPerUser: 1000,
		maxStoragePerUser: 100 * 1024 * 1024 // 100MB
	};

	async put(path: string, data: Buffer, metadata: StoragePutMetadata): Promise<StorageObjectMetadata> {
		return(putToStorage(this.storage, path, data, metadata));
	}

	async get(path: string): Promise<StorageGetResult | null> {
		return(getFromStorage(this.storage, path));
	}

	async delete(path: string): Promise<boolean> {
		return(this.storage.delete(path));
	}

	async search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults> {
		return(searchStorage(this.storage, criteria, pagination));
	}

	async getQuotaStatus(owner: string): Promise<QuotaStatus> {
		// Get base quota from actual storage
		const baseQuota = computeQuotaStatus(this.storage, owner, this.quotaConfig);

		// Add pending reservations for this owner
		let reservedObjects = 0;
		let reservedSize = 0;
		for (const reservation of this.reservations.values()) {
			if (reservation.owner === owner) {
				// Only count as new object if path doesn't exist
				if (!this.storage.has(reservation.path)) {
					reservedObjects++;
				}

				reservedSize += reservation.size;
			}
		}

		return({
			objectCount: baseQuota.objectCount + reservedObjects,
			totalSize: baseQuota.totalSize + reservedSize,
			remainingObjects: Math.max(0, baseQuota.remainingObjects - reservedObjects),
			remainingSize: Math.max(0, baseQuota.remainingSize - reservedSize)
		});
	}

	async reserveUpload(owner: string, path: string, size: number, ttlMs?: number): Promise<UploadReservation> {
		// Default TTL: 5 minutes
		const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
		const ttl = ttlMs ?? DEFAULT_RESERVATION_TTL_MS;

		// Check if this would exceed quota
		const quotaStatus = await this.getQuotaStatus(owner);
		const isNewObject = !this.storage.has(path);
		const existingSize = this.storage.get(path)?.data.length ?? 0;
		const sizeDelta = size - existingSize;

		if (isNewObject && quotaStatus.remainingObjects <= 0) {
			throw(new Errors.QuotaExceeded('Maximum number of objects reached'));
		}

		if (sizeDelta > 0 && quotaStatus.remainingSize < sizeDelta) {
			throw(new Errors.QuotaExceeded('Storage quota exceeded'));
		}

		const now = new Date();
		const reservation: UploadReservation = {
			id: `res_${++this.reservationCounter}`,
			owner,
			path,
			size: Math.max(0, sizeDelta),
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + ttl).toISOString()
		};

		this.reservations.set(reservation.id, reservation);
		return(reservation);
	}

	async commitUpload(reservationId: string): Promise<void> {
		// Simply remove the reservation - the actual storage was already updated via put()
		this.reservations.delete(reservationId);
	}

	async releaseUpload(reservationId: string): Promise<void> {
		// Remove the reservation, freeing the reserved quota
		this.reservations.delete(reservationId);
	}

	clear(): void {
		this.storage.clear();
		this.reservations.clear();
	}

	get size(): number {
		return(this.storage.size);
	}
}

// #endregion
