import { test, expect, describe } from 'vitest';
import type {
	StorageBackend,
	StorageObjectMetadata,
	StoragePath,
	StorageObjectVisibility,
	SearchCriteria,
	SearchPagination,
	SearchResults,
	QuotaStatus
} from './common.js';
import { parseStoragePath, validateStoragePath, isValidStoragePath, makeStoragePath, parseContainerPayload, Errors } from './common.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';

/**
 * In-memory storage backend for testing
 */
export class MemoryStorageBackend implements StorageBackend {
	private readonly storage = new Map<StoragePath, {
		data: Buffer;
		metadata: StorageObjectMetadata;
	}>();

	private readonly quotaConfig = {
		maxObjectSize: 10 * 1024 * 1024, // 10MB
		maxObjectsPerUser: 1000,
		maxStoragePerUser: 100 * 1024 * 1024 // 100MB
	};

	async put(path: StoragePath, data: Buffer, metadata: {
		owner: string;
		tags: string[];
		visibility: StorageObjectVisibility;
	}): Promise<StorageObjectMetadata> {
		const now = new Date().toISOString();
		const existing = this.storage.get(path);

		const objectMetadata: StorageObjectMetadata = {
			path,
			owner: metadata.owner,
			tags: metadata.tags,
			visibility: metadata.visibility,
			size: String(data.length),
			createdAt: existing?.metadata.createdAt ?? now,
			...(existing ? { updatedAt: now } : {})
		};

		this.storage.set(path, { data, metadata: objectMetadata });
		return(objectMetadata);
	}

	async get(path: StoragePath): Promise<{
		data: Buffer;
		metadata: StorageObjectMetadata;
	} | null> {
		const entry = this.storage.get(path);
		if (!entry) {
			return(null);
		}

		return({
			data: entry.data,
			metadata: entry.metadata
		});
	}

	async delete(path: StoragePath): Promise<boolean> {
		return(this.storage.delete(path));
	}

	async search(criteria: SearchCriteria, pagination: SearchPagination): Promise<SearchResults> {
		const results: StorageObjectMetadata[] = [];
		const limit = pagination.limit ?? 100;
		const startAfter = pagination.cursor;
		let foundCursor = !startAfter;

		for (const [path, entry] of this.storage.entries()) {
			// Handle cursor pagination
			if (!foundCursor) {
				if (path === startAfter) {
					foundCursor = true;
				}
				continue;
			}

			const metadata = entry.metadata;

			// Filter by pathPrefix
			if (criteria.pathPrefix) {
				const prefix = criteria.pathPrefix.endsWith('/')
					? criteria.pathPrefix
					: criteria.pathPrefix + '/';
				if (!path.startsWith(prefix) && path !== criteria.pathPrefix) {
					continue;
				}

				// Handle recursive flag
				if (!criteria.recursive) {
					const remainder = path.slice(prefix.length);
					if (remainder.includes('/')) {
						continue;
					}
				}
			}

			// Filter by owner
			if (criteria.owner && metadata.owner !== criteria.owner) {
				continue;
			}

			// Filter by tags (match any)
			if (criteria.tags && criteria.tags.length > 0) {
				const hasMatchingTag = criteria.tags.some(tag => metadata.tags.includes(tag));
				if (!hasMatchingTag) {
					continue;
				}
			}

			// Filter by name (filename portion)
			if (criteria.name) {
				const filename = path.split('/').pop();
				if (!filename?.includes(criteria.name)) {
					continue;
				}
			}

			results.push(metadata);

			if (results.length >= limit) {
				return({
					results,
					nextCursor: path
				});
			}
		}

		return({ results });
	}

	async getQuotaStatus(owner: string): Promise<QuotaStatus> {
		let objectCount = 0;
		let totalSize = 0;

		for (const entry of this.storage.values()) {
			if (entry.metadata.owner === owner) {
				objectCount++;
				totalSize += parseInt(entry.metadata.size, 10);
			}
		}

		return({
			objectCount,
			totalSize,
			remainingObjects: this.quotaConfig.maxObjectsPerUser - objectCount,
			remainingSize: this.quotaConfig.maxStoragePerUser - totalSize
		});
	}

	clear(): void {
		this.storage.clear();
	}

	get size(): number {
		return(this.storage.size);
	}
}

// #region Storage Path Utilities Tests

const validPaths = [
	{ input: '/user/abc123/file.txt', path: '/user/abc123/file.txt', owner: 'abc123', relativePath: 'file.txt' },
	{ input: '/user/abc123/docs/sub/file.txt', path: '/user/abc123/docs/sub/file.txt', owner: 'abc123', relativePath: 'docs/sub/file.txt' },
	{ input: '/user/key/icon', path: '/user/key/icon', owner: 'key', relativePath: 'icon' }
] as const;

const invalidPaths = [
	'/invalid',
	'/user/',
	'/user/abc123',
	'/user/abc123/',
	'user/abc123/file.txt',
	''
] as const;

describe('Storage Path Utilities', () => {
	describe.each(validPaths)('parseStoragePath($input)', ({ input, path, owner, relativePath }) => {
		test('returns parsed path', () => {
			expect(parseStoragePath(input)).toEqual({ path, owner, relativePath });
		});

		test('isValidStoragePath returns true', () => {
			expect(isValidStoragePath(input)).toBe(true);
		});

		test('validateStoragePath returns parsed path', () => {
			expect(validateStoragePath(input)).toEqual({ path, owner, relativePath });
		});
	});

	describe.each(invalidPaths)('invalid path: %s', (input) => {
		test('parseStoragePath returns null', () => {
			expect(parseStoragePath(input)).toBeNull();
		});

		test('isValidStoragePath returns false', () => {
			expect(isValidStoragePath(input)).toBe(false);
		});

		test('validateStoragePath throws InvalidPath', () => {
			expect(() => validateStoragePath(input)).toThrow(Errors.InvalidPath);
		});
	});

	const makePathCases = [
		{ owner: 'abc123', relativePath: 'file.txt', expected: '/user/abc123/file.txt' },
		{ owner: 'abc123', relativePath: 'docs/file.txt', expected: '/user/abc123/docs/file.txt' }
	] as const;

	describe.each(makePathCases)('makeStoragePath($owner, $relativePath)', ({ owner, relativePath, expected }) => {
		test(`returns ${expected}`, () => {
			expect(makeStoragePath(owner, relativePath)).toBe(expected);
		});
	});
});

// #endregion

// #region Container Payload Parsing Tests

const parseContainerPayloadCases: {
	name: string;
	input: string | { mimeType?: string; data?: string };
	expectedMimeType: string;
	expectedContent: string | number[];
}[] = [
	{
		name: 'valid JSON with mimeType and base64 data',
		input: { mimeType: 'text/plain', data: Buffer.from('Hello, World!').toString('base64') },
		expectedMimeType: 'text/plain',
		expectedContent: 'Hello, World!'
	},
	{
		name: 'missing mimeType defaults to octet-stream',
		input: { data: Buffer.from('Some data').toString('base64') },
		expectedMimeType: 'application/octet-stream',
		expectedContent: 'Some data'
	},
	{
		name: 'missing data returns raw plaintext',
		input: { mimeType: 'text/plain' },
		expectedMimeType: 'text/plain',
		expectedContent: '{"mimeType":"text/plain"}'
	},
	{
		name: 'non-object JSON returns raw plaintext',
		input: '["array","values"]',
		expectedMimeType: 'application/octet-stream',
		expectedContent: '["array","values"]'
	},
	{
		name: 'invalid JSON returns raw plaintext',
		input: 'not valid json',
		expectedMimeType: 'application/octet-stream',
		expectedContent: 'not valid json'
	},
	{
		name: 'binary data',
		input: { mimeType: 'application/octet-stream', data: Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]).toString('base64') },
		expectedMimeType: 'application/octet-stream',
		expectedContent: [0x00, 0x01, 0x02, 0xFF, 0xFE]
	}
];

describe('parseContainerPayload', () => {
	parseContainerPayloadCases.forEach(({ name, input, expectedMimeType, expectedContent }) => {
		test(name, () => {
			const plaintext = Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
			const result = parseContainerPayload(bufferToArrayBuffer(plaintext));
			expect(result.mimeType).toBe(expectedMimeType);

			if (Array.isArray(expectedContent)) {
				expect(result.content).toEqual(Buffer.from(expectedContent));
			} else {
				expect(result.content.toString()).toBe(expectedContent);
			}
		});
	});
});

// #endregion
