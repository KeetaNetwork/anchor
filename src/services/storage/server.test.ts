import { expect, test, describe } from 'vitest';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import { MemoryStorageBackend } from './common.test.js';

// #region Test Harness

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

		const initialQuota = await backend.getQuotaStatus(owner);
		expect(initialQuota.objectCount).toBe(0);
		expect(initialQuota.totalSize).toBe(0);

		await backend.put(`/user/${owner}/file.txt`, Buffer.from('12345'), { owner, tags: [], visibility: 'private' });

		const afterPut = await backend.getQuotaStatus(owner);
		expect(afterPut.objectCount).toBe(1);
		expect(afterPut.totalSize).toBe(5);
	});
});
