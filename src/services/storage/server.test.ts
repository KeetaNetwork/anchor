import { expect, test, describe } from 'vitest';
import type { UserPath, KeetaStorageAnchorSearchRequest } from './common.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import { MemoryStorageBackend } from './drivers/memory.js';
import { KeetaNet } from '../../client/index.js';
import { SignData, FormatData } from '../../lib/utils/signing.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import { getKeetaStorageAnchorGetRequestSigningData, getKeetaStorageAnchorSearchRequestSigningData, getKeetaStorageAnchorPutRequestSigningData } from './common.js';
import { EncryptedContainer } from '../../lib/encrypted-container.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';

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

function expectOk(json: unknown): void {
	return(expectOkStatus(json, true));
}

function expectNotOk(json: unknown): void {
	return(expectOkStatus(json, false));
}

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
	await using server = new KeetaNetStorageAnchorHTTPServer({ backend, validators: [] });
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

describe('Storage Server', function() {
	describe('Service Metadata', function() {
		test('exposes all operations with valid URLs', function() {
			return(withServer(async function({ server, url }) {
				const metadata = await server.serviceMetadata();

				/* eslint-disable @typescript-eslint/no-unsafe-assignment */
				const expectedShape = {
					operations: {
						put: expect.objectContaining({ url: expect.stringContaining(url) }),
						get: expect.objectContaining({ url: expect.stringContaining(url) }),
						delete: expect.objectContaining({ url: expect.stringContaining(url) }),
						search: expect.objectContaining({ url: expect.stringContaining(url) }),
						public: expect.stringContaining(url),
						quota: expect.objectContaining({ url: expect.stringContaining(url) })
					},
					quotas: expect.objectContaining({
						maxObjectSize: expect.any(Number),
						maxObjectsPerUser: expect.any(Number),
						maxStoragePerUser: expect.any(Number)
					})
				};
				/* eslint-enable @typescript-eslint/no-unsafe-assignment */
				expect(metadata).toMatchObject(expectedShape);
			}));
		});
	});

	describe('HTTP Error Handling', function() {
		const cases = [
			{
				name: 'SEARCH endpoint rejects malformed requests',
				path: '/api/search',
				method: 'POST' as const,
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({}),
				expectedStatus: 500,
				verifyOkIsFalse: true
			},
			{
				name: 'invalid JSON body returns error',
				path: '/api/search',
				method: 'POST' as const,
				headers: { 'Content-Type': 'application/json' },
				body: 'not valid json',
				expectedStatus: 500,
				verifyOkIsFalse: false
			},
			{
				name: 'non-existent endpoint returns 404',
				path: '/api/nonexistent',
				method: 'GET' as const,
				headers: {},
				body: undefined,
				expectedStatus: 404,
				verifyOkIsFalse: false
			},
			{
				name: 'quota endpoint rejects unsigned requests',
				path: '/api/quota',
				method: 'GET' as const,
				headers: { 'Accept': 'application/json' },
				body: undefined,
				expectedStatus: { min: 400 },
				verifyOkIsFalse: false
			}
		] as const;

		for (const testCase of cases) {
			test(testCase.name, function() {
				return(withServer(async function({ url }) {
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

					if (testCase.verifyOkIsFalse) {
						const json: unknown = await response.json();
						if (typeof json === 'object' && json !== null && 'ok' in json) {
							expect(json.ok).toBe(false);
						}
					}
				}));
			});
		}
	});

	describe('GET Authorization', function() {
		const cases = [
			{
				name: 'rejects cross-user read attempts',
				expectedStatus: 403,
				expectedError: 'namespace'
			}
			// Add more GET authorization cases here
		];

		for (const testCase of cases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const seed = KeetaNet.lib.Account.generateRandomSeed();
					const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
					const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

					const ownerPubKey = ownerAccount.publicKeyString.get();
					const objectPath: UserPath = `/user/${ownerPubKey}/secret.txt`;

					await backend.put(objectPath, Buffer.from('secret data'), {
						owner: ownerPubKey,
						tags: ['private'],
						visibility: 'private'
					});

					const signedField = await SignData(
						attackerAccount,
						getKeetaStorageAnchorGetRequestSigningData({ path: objectPath, account: attackerAccount.publicKeyString.get() })
					);

					const requestUrl = addSignatureToURL(
						`${url}/api/object${objectPath}`,
						{ signedField, account: attackerAccount }
					);

					const response = await fetch(requestUrl.toString(), {
						method: 'GET',
						headers: { 'Accept': 'application/json' }
					});
					expect(response.status).toBe(testCase.expectedStatus);

					const json: unknown = await response.json();
					expectNotOk(json);
					expectErrorContains(json, testCase.expectedError);
				}));
			});
		}
	});

	describe('SEARCH Authorization', function() {
		const rejectionCases = [
			{
				name: 'rejects mismatched criteria.owner',
				makeCriteria: function(ownerPubKey: string) { return({ owner: ownerPubKey }); },
				expectedStatus: 403,
				expectedError: 'namespace'
			},
			{
				name: 'rejects mismatched criteria.pathPrefix',
				makeCriteria: function(ownerPubKey: string) { return({ pathPrefix: `/user/${ownerPubKey}/` }); },
				expectedStatus: 403,
				expectedError: 'namespace'
			}
			// Add more SEARCH rejection cases here
		];

		for (const testCase of rejectionCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
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
					expect(response.status).toBe(testCase.expectedStatus);

					const json: unknown = await response.json();
					expectNotOk(json);
					expectErrorContains(json, testCase.expectedError);
				}));
			});
		}

		test('omitted owner defaults to authenticated user', function() {
			return(withServer(async function({ backend, url }) {
				const seed = KeetaNet.lib.Account.generateRandomSeed();
				const userAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
				const otherAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

				const userPubKey = userAccount.publicKeyString.get();
				const otherPubKey = otherAccount.publicKeyString.get();

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

				if (isJsonObject(json) && Array.isArray(json.results)) {
					expect(json.results).toHaveLength(1);
					const firstResult: unknown = json.results[0];
					if (isJsonObject(firstResult)) {
						expect(firstResult.owner).toBe(userPubKey);
					}
				}
			}));
		});

		test('visibility:public finds public objects from any namespace', function() {
			return(withServer(async function({ backend, url }) {
				const seed = KeetaNet.lib.Account.generateRandomSeed();
				const userAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
				const otherAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

				const userPubKey = userAccount.publicKeyString.get();
				const otherPubKey = otherAccount.publicKeyString.get();

				await backend.put(`/user/${userPubKey}/private.txt`, Buffer.from('private'), {
					owner: userPubKey,
					tags: [],
					visibility: 'private'
				});
				await backend.put(`/user/${userPubKey}/public.txt`, Buffer.from('public'), {
					owner: userPubKey,
					tags: [],
					visibility: 'public'
				});
				await backend.put(`/user/${otherPubKey}/other-public.txt`, Buffer.from('other'), {
					owner: otherPubKey,
					tags: [],
					visibility: 'public'
				});

				const searchRequest: KeetaStorageAnchorSearchRequest = {
					account: userPubKey,
					criteria: { visibility: 'public' }
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

				if (isJsonObject(json) && Array.isArray(json.results)) {
					expect(json.results).toHaveLength(2);
					const paths = json.results.map(function(r: unknown) {
						return(isJsonObject(r) ? r.path : null);
					});
					expect(paths).toContain(`/user/${userPubKey}/public.txt`);
					expect(paths).toContain(`/user/${otherPubKey}/other-public.txt`);
				}
			}));
		});
	});

	describe('PUT Validation', function() {
		const cases = [
			{
				name: 'rejects public object when anchor is not a principal',
				visibility: 'public' as const,
				includeAnchorAsPrincipal: false,
				expectedStatus: 400,
				expectedError: 'principal'
			}
			// Add more PUT validation cases here (e.g., size limits, path validation)
		];

		for (const testCase of cases) {
			test(testCase.name, function() {
				return(withServerAndAnchor(async function({ url, anchorAccount }) {
					const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
					const userPubKey = userAccount.publicKeyString.get();
					const objectPath: UserPath = `/user/${userPubKey}/test-file.txt`;

					const payload = { mimeType: 'text/plain', data: Buffer.from('test data').toString('base64') };
					const principals = testCase.includeAnchorAsPrincipal
						? [userAccount, anchorAccount]
						: [userAccount];
					const container = EncryptedContainer.fromPlaintext(
						JSON.stringify(payload),
						principals,
						{ signer: userAccount }
					);
					const binaryData = Buffer.from(await container.getEncodedBuffer());

					const signedField = await SignData(userAccount, getKeetaStorageAnchorPutRequestSigningData({
						path: objectPath,
						visibility: testCase.visibility
					}));

					const baseUrl = new URL(`/api/object${objectPath}`, url);
					const requestUrl = addSignatureToURL(baseUrl, { signedField, account: userAccount });
					requestUrl.searchParams.set('visibility', testCase.visibility);

					const response = await fetch(requestUrl, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
						body: bufferToArrayBuffer(binaryData)
					});
					expect(response.status).toBe(testCase.expectedStatus);

					const json: unknown = await response.json();
					expectNotOk(json);
					expectErrorContains(json, testCase.expectedError);
				}));
			});
		}
	});

	describe('Signed URL (Public Access)', function() {
		const validationCases = [
			{
				name: 'rejects non-numeric expires',
				getExpires: function() { return('abc'); },
				expectedStatus: 401,
				expectedError: 'invalid'
			},
			{
				name: 'rejects expired signature',
				getExpires: function() { return(String(Math.floor(Date.now() / 1000) - 100)); },
				expectedStatus: 401,
				expectedError: 'expired'
			},
			{
				name: 'rejects TTL exceeding maximum',
				getExpires: function() { return(String(Math.floor(Date.now() / 1000) + 200000)); },
				expectedStatus: 401,
				expectedError: 'ttl exceeds'
			}
			// Add more signed URL validation cases here
		];

		for (const testCase of validationCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const ownerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
					const ownerPubKey = ownerAccount.publicKeyString.get();
					const objectPath: UserPath = `/user/${ownerPubKey}/public.txt`;

					await backend.put(objectPath, Buffer.from('test'), {
						owner: ownerPubKey,
						tags: [],
						visibility: 'public'
					});

					const expires = testCase.getExpires();
					const expiresNum = parseInt(expires, 10) || 0;
					const { nonce, timestamp, verificationData } = FormatData(ownerAccount, [objectPath, expiresNum]);
					const signatureResult = await ownerAccount.sign(bufferToArrayBuffer(verificationData));
					const signature = signatureResult.getBuffer().toString('base64');

					const requestUrl = new URL(`/api/public${objectPath}`, url);
					requestUrl.searchParams.set('expires', expires);
					requestUrl.searchParams.set('nonce', nonce);
					requestUrl.searchParams.set('timestamp', timestamp);
					requestUrl.searchParams.set('signature', signature);

					const response = await fetch(requestUrl);
					expect(response.status).toBe(testCase.expectedStatus);

					const json: unknown = await response.json();
					expectNotOk(json);
					expectErrorContains(json, testCase.expectedError);
				}));
			});
		}
	});
});

describe('MemoryStorageBackend', function() {
	test('CRUD operations', async function() {
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

	test('search by path prefix', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'test-owner';

		await backend.put(`/user/${owner}/a.txt`, Buffer.from('a'), { owner, tags: [], visibility: 'private' });
		await backend.put(`/user/${owner}/b.txt`, Buffer.from('b'), { owner, tags: [], visibility: 'private' });
		await backend.put('/user/other/c.txt', Buffer.from('c'), { owner: 'other', tags: [], visibility: 'private' });

		const results = await backend.search({ pathPrefix: `/user/${owner}/` }, { limit: 10 });
		expect(results.results).toHaveLength(2);
	});

	test('search by tags', async function() {
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

	test('quota tracking', async function() {
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

	test('atomic operations', async function() {
		const backend = new MemoryStorageBackend();
		const owner = 'atomic-test-owner';
		const path = `/user/${owner}/file.txt`;

		// Commit applies changes
		await backend.withAtomic(async function(atomic) {
			await atomic.put(path, Buffer.from('committed'), { owner, tags: [], visibility: 'private' });
		});
		expect((await backend.get(path))?.data.toString()).toBe('committed');

		// Rollback discards changes
		const path2 = `/user/${owner}/file2.txt`;
		try {
			await backend.withAtomic(async function(atomic) {
				await atomic.put(path2, Buffer.from('should-not-exist'), { owner, tags: [], visibility: 'private' });
				throw(new Error('intentional'));
			});
		} catch {
			// Expected
		}
		expect(await backend.get(path2)).toBeNull();

		// Atomic reads see uncommitted writes within same scope
		await backend.withAtomic(async function(atomic) {
			await atomic.put(path, Buffer.from('updated'), { owner, tags: [], visibility: 'private' });
			const read = await atomic.get(path);
			expect(read?.data.toString()).toBe('updated');
		});
	});
});
