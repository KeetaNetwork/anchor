import type {
	StorageBackend,
	StorageAtomicInterface,
	StorageObjectMetadata,
	StoragePutMetadata,
	StorageGetResult,
	SearchCriteria,
	SearchPagination,
	SearchResults,
	QuotaStatus
} from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';

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

// #region Atomic Scope

/**
 * Cow Atomic scope for MemoryStorageBackend
 */
class MemoryAtomicScope implements StorageAtomicInterface {
	private readonly snapshot: Map<string, StorageEntry>;
	private committed = false;
	private rolledBack = false;

	constructor(
		private readonly backend: MemoryStorageBackend,
		private readonly quotaConfig: QuotaConfig
	) {
		this.snapshot = new Map(backend.getStorageSnapshot());
	}

	async put(path: string, data: Buffer, metadata: StoragePutMetadata): Promise<StorageObjectMetadata> {
		this.ensureActive();
		return(putToStorage(this.snapshot, path, data, metadata));
	}

	async get(path: string): Promise<StorageGetResult | null> {
		this.ensureActive();
		return(getFromStorage(this.snapshot, path));
	}

	async delete(path: string): Promise<boolean> {
		this.ensureActive();
		return(this.snapshot.delete(path));
	}

	async search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults> {
		this.ensureActive();
		return(searchStorage(this.snapshot, criteria, pagination));
	}

	async getQuotaStatus(owner: string): Promise<QuotaStatus> {
		this.ensureActive();
		return(computeQuotaStatus(this.snapshot, owner, this.quotaConfig));
	}

	async commit(): Promise<void> {
		this.ensureActive();
		this.backend.replaceStorage(this.snapshot);
		this.committed = true;
	}

	async rollback(): Promise<void> {
		this.ensureActive();
		this.rolledBack = true;
	}

	private ensureActive(): void {
		if (this.committed) {
			throw(new Error('invariant: atomic scope already committed'));
		}
		if (this.rolledBack) {
			throw(new Error('invariant: atomic scope already rolled back'));
		}
	}
}

// #endregion

// #region Memory Storage Backend

/**
 * In-memory storage backend
 */
export class MemoryStorageBackend implements StorageBackend {
	private storage = new Map<string, StorageEntry>();

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
		return(computeQuotaStatus(this.storage, owner, this.quotaConfig));
	}

	async beginAtomic(): Promise<StorageAtomicInterface> {
		return(new MemoryAtomicScope(this, this.quotaConfig));
	}

	async withAtomic<T>(fn: (atomic: StorageAtomicInterface) => Promise<T>): Promise<T> {
		const atomic = await this.beginAtomic();
		try {
			const result = await fn(atomic);
			await atomic.commit();
			return(result);
		} catch (e) {
			await atomic.rollback();
			throw(e);
		}
	}

	getStorageSnapshot(): Map<string, StorageEntry> {
		return(new Map(this.storage));
	}

	replaceStorage(newStorage: Map<string, StorageEntry>): void {
		this.storage = new Map(newStorage);
	}

	clear(): void {
		this.storage.clear();
	}

	get size(): number {
		return(this.storage.size);
	}
}

// #endregion
