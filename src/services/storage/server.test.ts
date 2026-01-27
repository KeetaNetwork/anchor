import { expect, test, describe } from 'vitest';
import type { UserPath, KeetaStorageAnchorPutRequest } from './common.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import { MemoryStorageBackend } from './drivers/memory.js';
import { KeetaNet } from '../../client/index.js';
import { SignData } from '../../lib/utils/signing.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import { getKeetaStorageAnchorGetRequestSigningData, getKeetaStorageAnchorSearchRequestSigningData, getKeetaStorageAnchorPutRequestSigningData } from './common.js';
import { EncryptedContainer } from '../../lib/encrypted-container.js';
import { Buffer } from '../../lib/utils/buffer.js';

// #region Test Harness

/** Type guard for JSON response objects */
function isJsonObject(val: unknown): val is { [key: string]: unknown } {
	return(typeof val === 'object' && val !== null && !Array.isArray(val));
}

/** Assert response has expected ok value */
function expectOkStatus(json: unknown, expected: boolean): void {
	expect(isJsonObject(json)).toBe(true);
	if (!isJsonObject(json)) {
		return;
	}
	expect(json.ok).toBe(expected);
}

const expectOk = (json: unknown): void => expectOkStatus(json, true);
const expectNotOk = (json: unknown): void => expectOkStatus(json, false);

/** Assert response error contains substring (case-insensitive) */
function expectErrorContains(json: unknown, substring: string): void {
	expect(isJsonObject(json)).toBe(true);
	if (!isJsonObject(json)) {
		return;
	}
	expect(typeof json.error).toBe('string');
	const error = json.error;
	if (typeof error === 'string') {
		expect(error.toLowerCase()).toContain(substring.toLowerCase());
	}
}

type ServerTestFn = (ctx: { server: KeetaNetStorageAnchorHTTPServer; backend: MemoryStorageBackend; url: string }) => Promise<void>;

/**
 * Helper to run a test with a fresh server instance
 */
async function withServer(fn: ServerTestFn): Promise<void> {
	const backend = new MemoryStorageBackend();
	await using server = new KeetaNetStorageAnchorHTTPServer({ backend });
	await server.start();
	await fn({ server, backend, url: server.url });
}

type ServerWithAnchorTestFn = (ctx: {
	server: KeetaNetStorageAnchorHTTPServer;
	backend: MemoryStorageBackend;
	url: string;
	anchorAccount: InstanceType<typeof KeetaNet.lib.Account>;
}) => Promise<void>;

/**
 * Helper to run a test with a fresh server instance that has an anchor account
 */
async function withServerAndAnchor(fn: ServerWithAnchorTestFn): Promise<void> {
	const backend = new MemoryStorageBackend();
	const anchorAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using server = new KeetaNetStorageAnchorHTTPServer({ backend, anchorAccount });
	await server.start();
	await fn({ server, backend, url: server.url, anchorAccount });
}

// #endregion

describe('Storage Server', () => {
	test('serviceMetadata exposes all operations with valid URLs', () => withServer(async ({ server, url }) => {
		const metadata = await server.serviceMetadata();
		expect(metadata).toBeDefined();
		expect(metadata.operations).toBeDefined();

		const expectedOps = ['put', 'get', 'delete', 'search', 'public', 'quota'] as const;
		for (const op of expectedOps) {
			const operation = metadata.operations[op];
			expect(operation).toBeDefined();

			// Operation can be a string or an object with url property
			const opUrl = typeof operation === 'string' ? operation : operation?.url;
			expect(opUrl).toContain(url);
		}

		expect(metadata.quotas).toBeDefined();
	}));

	// HTTP error tests
	const httpErrorCases = [
		{
			name: 'SEARCH endpoint rejects malformed requests',
			path: '/api/search',
			method: 'POST' as const,
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({}),
			expectedStatus: 500,
			checkOk: true
		},
		{
			name: 'invalid JSON body returns error',
			path: '/api/search',
			method: 'POST' as const,
			headers: { 'Content-Type': 'application/json' },
			body: 'not valid json',
			expectedStatus: 500,
			checkOk: false
		},
		{
			name: 'non-existent endpoint returns 404',
			path: '/api/nonexistent',
			method: 'GET' as const,
			headers: {},
			body: undefined,
			expectedStatus: 404,
			checkOk: false
		},
		{
			name: 'quota endpoint rejects unsigned requests',
			path: '/api/quota',
			method: 'GET' as const,
			headers: { 'Accept': 'application/json' },
			body: undefined,
			expectedStatus: { min: 400 },
			checkOk: false
		}
	] as const;

	for (const testCase of httpErrorCases) {
		test(testCase.name, () => withServer(async ({ url }) => {
			const response = await fetch(`${url}${testCase.path}`, {
				method: testCase.method,
				headers: testCase.headers,
				...(testCase.body !== undefined && { body: testCase.body })
			});

			if (typeof testCase.expectedStatus === 'number') {
				expect(response.status).toBe(testCase.expectedStatus);
			} else {
				expect(response.status).toBeGreaterThanOrEqual(testCase.expectedStatus.min);
			}

			if (testCase.checkOk) {
				const json: unknown = await response.json();
				if (typeof json === 'object' && json !== null && 'ok' in json) {
					expect(json.ok).toBe(false);
				}
			}
		}));
	}

	test('GET rejects cross-user read attempts', () => withServer(async ({ backend, url }) => {
		// Create two accounts
		const seed = KeetaNet.lib.Account.generateRandomSeed();
		const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
		const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

		const ownerPubKey = ownerAccount.publicKeyString.get();
		const objectPath: UserPath = `/user/${ownerPubKey}/secret.txt`;

		// Store an object for the owner directly in backend
		await backend.put(objectPath, Buffer.from('secret data'), {
			owner: ownerPubKey,
			tags: ['private'],
			visibility: 'private'
		});

		// Sign a GET request as the attacker for the owner's object
		const signedField = await SignData(
			attackerAccount,
			getKeetaStorageAnchorGetRequestSigningData({ path: objectPath, account: attackerAccount.publicKeyString.get() })
		);

		const requestUrl = addSignatureToURL(
			`${url}/api/object?path=${encodeURIComponent(objectPath)}`,
			{ signedField, account: attackerAccount }
		);

		const response = await fetch(requestUrl.toString(), {
			method: 'GET',
			headers: { 'Accept': 'application/json' }
		});
		expect(response.status).toBe(403);

		const json: unknown = await response.json();
		expectNotOk(json);
		expectErrorContains(json, 'namespace');
	}));

	// Data-driven SEARCH authorization rejection tests
	const searchAuthzRejectionCases = [
		{
			name: 'rejects mismatched criteria.owner',
			makeCriteria: (ownerPubKey: string) => ({ owner: ownerPubKey })
		},
		{
			name: 'rejects mismatched criteria.pathPrefix',
			makeCriteria: (ownerPubKey: string) => ({ pathPrefix: `/user/${ownerPubKey}/` })
		}
	] as const;

	for (const testCase of searchAuthzRejectionCases) {
		test(`SEARCH ${testCase.name}`, () => withServer(async ({ backend, url }) => {
			const seed = KeetaNet.lib.Account.generateRandomSeed();
			const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
			const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

			const ownerPubKey = ownerAccount.publicKeyString.get();
			const attackerPubKey = attackerAccount.publicKeyString.get();
			const objectPath: UserPath = `/user/${ownerPubKey}/secret.txt`;

			await backend.put(objectPath, Buffer.from('secret data'), {
				owner: ownerPubKey,
				tags: ['private'],
				visibility: 'private'
			});

			const searchRequest = {
				account: attackerPubKey,
				criteria: testCase.makeCriteria(ownerPubKey)
			};

			const signedField = await SignData(
				attackerAccount,
				getKeetaStorageAnchorSearchRequestSigningData(searchRequest)
			);

			const response = await fetch(`${url}/api/search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({ ...searchRequest, signed: signedField })
			});
			expect(response.status).toBe(403);

			const json: unknown = await response.json();
			expectNotOk(json);
			expectErrorContains(json, 'namespace');
		}));
	}

	test('SEARCH with omitted owner defaults to authenticated user', () => withServer(async ({ backend, url }) => {
		const seed = KeetaNet.lib.Account.generateRandomSeed();
		const userAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
		const otherAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

		const userPubKey = userAccount.publicKeyString.get();
		const otherPubKey = otherAccount.publicKeyString.get();

		// Store objects for both users
		await backend.put(`/user/${userPubKey}/my-file.txt`, Buffer.from('my data'), {
			owner: userPubKey,
			tags: ['mine'],
			visibility: 'private'
		});
		await backend.put(`/user/${otherPubKey}/other-file.txt`, Buffer.from('other data'), {
			owner: otherPubKey,
			tags: ['theirs'],
			visibility: 'private'
		});

		// User searches without specifying owner
		const searchRequest = {
			account: userPubKey,
			criteria: {}
		};

		const signedField = await SignData(
			userAccount,
			getKeetaStorageAnchorSearchRequestSigningData(searchRequest)
		);

		const response = await fetch(`${url}/api/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ ...searchRequest, signed: signedField })
		});
		expect(response.status).toBe(200);

		const json: unknown = await response.json();
		expectOk(json);

		// Should only find user's own file, not other user's file
		if (isJsonObject(json) && Array.isArray(json.results)) {
			expect(json.results).toHaveLength(1);
			const firstResult: unknown = json.results[0];
			if (isJsonObject(firstResult)) {
				expect(firstResult.owner).toBe(userPubKey);
			}
		}
	}));

	test('PUT rejects public object when anchor is not a principal', () => withServerAndAnchor(async ({ url }) => {
		const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		const userPubKey = userAccount.publicKeyString.get();
		const objectPath: UserPath = `/user/${userPubKey}/public-file.txt`;

		// Create encrypted container with ONLY the user as principal (NOT the anchor)
		const payload = { mimeType: 'text/plain', data: Buffer.from('public data').toString('base64') };
		const container = EncryptedContainer.fromPlaintext(
			JSON.stringify(payload),
			[userAccount], // Missing anchorAccount as principal
			{ signer: userAccount }
		);
		const encodedData = Buffer.from(await container.getEncodedBuffer()).toString('base64');
		const putRequest: KeetaStorageAnchorPutRequest = {
			path: objectPath,
			data: encodedData,
			visibility: 'public',
			account: userPubKey
		};

		const signedField = await SignData(userAccount, getKeetaStorageAnchorPutRequestSigningData(putRequest));
		const response = await fetch(`${url}/api/object`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ ...putRequest, signed: signedField })
		});
		expect(response.status).toBe(400);

		const json: unknown = await response.json();
		expectNotOk(json);
		expectErrorContains(json, 'principal');
	}));
});

describe('MemoryStorageBackend', () => {
	test('CRUD operations', async () => {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner-pubkey';
		const path = `/user/${owner}/test.txt`;

		// Initially empty
		expect(backend.size).toBe(0);

		// PUT
		const putResult = await backend.put(path, Buffer.from('hello world'), {
			owner,
			tags: ['test', 'example'],
			visibility: 'private'
		});
		expect(putResult.path).toBe(path);
		expect(putResult.owner).toBe(owner);
		expect(putResult.tags).toEqual(['test', 'example']);
		expect(putResult.size).toBe('11');
		expect(backend.size).toBe(1);

		// GET
		const getResult = await backend.get(path);
		expect(getResult).not.toBeNull();
		expect(getResult?.data.toString()).toBe('hello world');
		expect(getResult?.metadata.path).toBe(path);

		// GET non-existent
		expect(await backend.get('/user/other/missing.txt')).toBeNull();

		// DELETE
		expect(await backend.delete(path)).toBe(true);
		expect(backend.size).toBe(0);
		expect(await backend.delete(path)).toBe(false);
	});

	test('search by path prefix', async () => {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner';

		await backend.put(`/user/${owner}/a.txt`, Buffer.from('a'), { owner, tags: [], visibility: 'private' });
		await backend.put(`/user/${owner}/b.txt`, Buffer.from('b'), { owner, tags: [], visibility: 'private' });
		await backend.put('/user/other/c.txt', Buffer.from('c'), { owner: 'other', tags: [], visibility: 'private' });

		const results = await backend.search({ pathPrefix: `/user/${owner}/` }, { limit: 10 });
		expect(results.results).toHaveLength(2);
	});

	test('search by tags', async () => {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner';

		await backend.put('/user/x/a.txt', Buffer.from('a'), { owner, tags: ['foo'], visibility: 'private' });
		await backend.put('/user/x/b.txt', Buffer.from('b'), { owner, tags: ['bar'], visibility: 'private' });
		await backend.put('/user/x/c.txt', Buffer.from('c'), { owner, tags: ['foo', 'bar'], visibility: 'private' });

		const fooResults = await backend.search({ tags: ['foo'] }, { limit: 10 });
		expect(fooResults.results).toHaveLength(2);

		const barResults = await backend.search({ tags: ['bar'] }, { limit: 10 });
		expect(barResults.results).toHaveLength(2);
	});

	test('quota tracking', async () => {
		const backend = new MemoryStorageBackend();
		const owner = 'quota-test-owner';
		const path = `/user/${owner}/file.txt`;

		// Initial state
		const initialQuota = await backend.getQuotaStatus(owner);
		expect(initialQuota.objectCount).toBe(0);
		expect(initialQuota.totalSize).toBe(0);

		// After first put
		await backend.put(path, Buffer.from('12345'), { owner, tags: [], visibility: 'private' });
		const afterPut = await backend.getQuotaStatus(owner);
		expect(afterPut.objectCount).toBe(1);
		expect(afterPut.totalSize).toBe(5);

		// Update same path - object count stays same, size changes
		await backend.put(path, Buffer.from('1234567890'), { owner, tags: [], visibility: 'private' });
		const afterUpdate = await backend.getQuotaStatus(owner);
		expect(afterUpdate.objectCount).toBe(1);
		expect(afterUpdate.totalSize).toBe(10);

		// Shrink object - size decreases
		await backend.put(path, Buffer.from('xy'), { owner, tags: [], visibility: 'private' });
		const afterShrink = await backend.getQuotaStatus(owner);
		expect(afterShrink.objectCount).toBe(1);
		expect(afterShrink.totalSize).toBe(2);
	});

	test('atomic operations', async () => {
		const backend = new MemoryStorageBackend();
		const owner = 'atomic-test-owner';
		const path = `/user/${owner}/file.txt`;

		// Commit applies changes
		await backend.withAtomic(async (atomic) => {
			await atomic.put(path, Buffer.from('committed'), { owner, tags: [], visibility: 'private' });
		});
		expect((await backend.get(path))?.data.toString()).toBe('committed');

		// Rollback discards changes
		const path2 = `/user/${owner}/file2.txt`;
		try {
			await backend.withAtomic(async (atomic) => {
				await atomic.put(path2, Buffer.from('should-not-exist'), { owner, tags: [], visibility: 'private' });
				throw(new Error('intentional'));
			});
		} catch {
			// Expected
		}
		expect(await backend.get(path2)).toBeNull();

		// Atomic reads see uncommitted writes within same scope
		await backend.withAtomic(async (atomic) => {
			await atomic.put(path, Buffer.from('updated'), { owner, tags: [], visibility: 'private' });
			const read = await atomic.get(path);
			expect(read?.data.toString()).toBe('updated');
		});
	});
});
