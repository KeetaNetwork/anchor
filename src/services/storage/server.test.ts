import { expect, test, describe } from 'vitest';
import type { KeetaStorageAnchorSearchRequest } from './common.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import { MemoryStorageBackend } from './test-utils.js';
import { KeetaNet } from '../../client/index.js';
import { SignData, FormatData } from '../../lib/utils/signing.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import { getKeetaStorageAnchorGetRequestSigningData, getKeetaStorageAnchorSearchRequestSigningData, getKeetaStorageAnchorPutRequestSigningData, getKeetaStorageAnchorDeleteRequestSigningData } from './common.js';
import { EncryptedContainer } from '../../lib/encrypted-container.js';
import { Buffer, bufferToArrayBuffer } from '../../lib/utils/buffer.js';
import { testPathPolicy } from './test-utils.js';

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

type ServerTestContext = {
	server: KeetaNetStorageAnchorHTTPServer;
	backend: MemoryStorageBackend;
	url: string;
	anchorAccount: InstanceType<typeof KeetaNet.lib.Account>;
};

/**
 * Helper to run a test with a fresh server instance
 */
async function withServer(fn: (ctx: ServerTestContext) => Promise<void>): Promise<void> {
	const backend = new MemoryStorageBackend();
	const anchorAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const pathPolicies = [testPathPolicy];

	await using server = new KeetaNetStorageAnchorHTTPServer({ backend, anchorAccount, pathPolicies });
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

	describe('Cross-User Access Authorization', function() {
		const cases = [
			{
				name: 'GET rejects cross-user read',
				method: 'GET',
				endpoint: '/api/object',
				getSigningData: getKeetaStorageAnchorGetRequestSigningData,
				expectedStatus: 403,
				expectedError: 'namespace'
			},
			{
				name: 'DELETE rejects cross-user delete',
				method: 'DELETE',
				endpoint: '/api/object',
				getSigningData: getKeetaStorageAnchorDeleteRequestSigningData,
				expectedStatus: 403,
				expectedError: 'namespace'
			},
			{
				name: 'GET /metadata rejects cross-user access',
				method: 'GET',
				endpoint: '/api/metadata',
				getSigningData: getKeetaStorageAnchorGetRequestSigningData,
				expectedStatus: 403,
				expectedError: 'namespace'
			}
		];

		for (const testCase of cases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const seed = KeetaNet.lib.Account.generateRandomSeed();
					const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
					const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

					const ownerPubKey = ownerAccount.publicKeyString.get();
					const objectPath = `/user/${ownerPubKey}/secret.txt`;

					await backend.put(objectPath, Buffer.from('secret data'), {
						owner: ownerPubKey,
						tags: ['private'],
						visibility: 'private'
					});

					const signedField = await SignData(
						attackerAccount,
						testCase.getSigningData({ path: objectPath, account: attackerAccount.publicKeyString.get() })
					);

					const requestUrl = addSignatureToURL(
						`${url}${testCase.endpoint}${objectPath}`,
						{ signedField, account: attackerAccount }
					);

					const response = await fetch(requestUrl.toString(), {
						method: testCase.method,
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

	describe('Cross-User PUT Authorization', function() {
		test('PUT rejects cross-user overwrite', function() {
			return(withServer(async function({ backend, url }) {
				const seed = KeetaNet.lib.Account.generateRandomSeed();
				const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
				const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

				const ownerPubKey = ownerAccount.publicKeyString.get();
				const objectPath = `/user/${ownerPubKey}/secret.txt`;

				// Owner creates an object
				await backend.put(objectPath, Buffer.from('original data'), {
					owner: ownerPubKey,
					tags: ['private'],
					visibility: 'private'
				});

				// Attacker tries to overwrite it
				const visibility = 'private';
				const tags: string[] = [];
				const signedField = await SignData(
					attackerAccount,
					getKeetaStorageAnchorPutRequestSigningData({ path: objectPath, visibility, tags })
				);

				const requestUrl = addSignatureToURL(
					`${url}/api/object${objectPath}?visibility=${visibility}`,
					{ signedField, account: attackerAccount }
				);

				const response = await fetch(requestUrl.toString(), {
					method: 'PUT',
					headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
					body: bufferToArrayBuffer(Buffer.from('malicious data'))
				});
				expect(response.status).toBe(403);

				const json: unknown = await response.json();
				expectNotOk(json);
				expectErrorContains(json, 'namespace');

				// Verify original data is unchanged
				const stored = await backend.get(objectPath);
				expect(stored?.data.toString()).toBe('original data');
			}));
		});
	});

	describe('SEARCH Authorization', function() {
		// Mismatched owner/pathPrefix returns empty results (no info leakage)
		const emptyResultCases = [
			{
				name: 'mismatched criteria.owner returns empty results',
				makeCriteria: function(ownerPubKey: string) { return({ owner: ownerPubKey }); }
			},
			{
				name: 'mismatched criteria.pathPrefix returns empty results',
				makeCriteria: function(ownerPubKey: string) { return({ pathPrefix: `/user/${ownerPubKey}/` }); }
			},
			{
				name: 'mismatched owner AND pathPrefix returns empty results',
				makeCriteria: function(ownerPubKey: string) { return({ owner: ownerPubKey, pathPrefix: `/user/${ownerPubKey}/` }); }
			},
			{
				name: 'tag search scoped to authenticated user namespace',
				makeCriteria: function(_ignoreOwnerPubKey: string) { return({ tags: ['private'] }); }
			}
		];

		for (const testCase of emptyResultCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const seed = KeetaNet.lib.Account.generateRandomSeed();
					const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
					const attackerAccount = KeetaNet.lib.Account.fromSeed(seed, 1);

					const ownerPubKey = ownerAccount.publicKeyString.get();
					const attackerPubKey = attackerAccount.publicKeyString.get();
					const objectPath = `/user/${ownerPubKey}/secret.txt`;

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
					expect(response.status).toBe(200);

					const json: unknown = await response.json();
					expectOk(json);

					if (isJsonObject(json) && 'results' in json && Array.isArray(json.results)) {
						expect(json.results).toHaveLength(0);
					}
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
		];

		for (const testCase of cases) {
			test(testCase.name, function() {
				return(withServer(async function({ url, anchorAccount }) {
					const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
					const userPubKey = userAccount.publicKeyString.get();
					const objectPath = `/user/${userPubKey}/test-file.txt`;

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
		type SignedUrlTestCase = {
			name: string;
			getExpires?: () => string;
			signatureOverride?: string;
			useWrongSigner?: boolean;
			expectedStatus: number;
			expectedError: string;
		};

		const validationCases: SignedUrlTestCase[] = [
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
			},
			{
				name: 'rejects malformed signature',
				signatureOverride: 'not-valid-base64!@#$',
				expectedStatus: 401,
				expectedError: 'invalid'
			},
			{
				name: 'rejects signature from wrong account',
				useWrongSigner: true,
				expectedStatus: 401,
				expectedError: 'verification failed'
			}
		];

		for (const testCase of validationCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const seed = KeetaNet.lib.Account.generateRandomSeed();
					const ownerAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
					const wrongAccount = KeetaNet.lib.Account.fromSeed(seed, 1);
					const ownerPubKey = ownerAccount.publicKeyString.get();
					const objectPath = `/user/${ownerPubKey}/public.txt`;

					await backend.put(objectPath, Buffer.from('test'), {
						owner: ownerPubKey,
						tags: [],
						visibility: 'public'
					});

					const expires = testCase.getExpires?.() ?? String(Math.floor(Date.now() / 1000) + 3600);
					const expiresNum = parseInt(expires, 10) || 0;

					// Use wrong signer if specified, otherwise use owner
					const signerAccount = testCase.useWrongSigner ? wrongAccount : ownerAccount;
					const { nonce, timestamp, verificationData } = FormatData(signerAccount, [objectPath, expiresNum]);
					const signatureResult = await signerAccount.sign(bufferToArrayBuffer(verificationData));
					const signature = testCase.signatureOverride ?? signatureResult.getBuffer().toString('base64');

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

	describe('Replay Attack Prevention', function() {
		const replayCases = [
			{
				name: 'rejects request with stale timestamp (too old)',
				getTimestamp: function() {
					// 10 minutes in the past (beyond default 5 min skew)
					return(new Date(Date.now() - 10 * 60 * 1000).toISOString());
				}
			},
			{
				name: 'rejects request with future timestamp (too far ahead)',
				getTimestamp: function() {
					// 10 minutes in the future (beyond default 5 min skew)
					return(new Date(Date.now() + 10 * 60 * 1000).toISOString());
				}
			}
		];

		for (const testCase of replayCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
					const userPubKey = userAccount.publicKeyString.get();
					const objectPath = `/user/${userPubKey}/test.txt`;

					await backend.put(objectPath, Buffer.from('test data'), {
						owner: userPubKey,
						tags: [],
						visibility: 'private'
					});

					// Create signed data with manipulated timestamp
					const nonce = crypto.randomUUID();
					const timestamp = testCase.getTimestamp();
					const { verificationData } = FormatData(userAccount,
						getKeetaStorageAnchorGetRequestSigningData({ path: objectPath, account: userPubKey }),
						nonce,
						timestamp
					);
					const signatureResult = await userAccount.sign(bufferToArrayBuffer(verificationData));
					const signature = signatureResult.getBuffer().toString('base64');

					const requestUrl = addSignatureToURL(
						`${url}/api/object${objectPath}`,
						{
							signedField: { nonce, timestamp, signature },
							account: userAccount
						}
					);

					const response = await fetch(requestUrl.toString(), {
						method: 'GET',
						headers: { 'Accept': 'application/json' }
					});

					// Request should be rejected (4xx error)
					expect(response.status).toBeGreaterThanOrEqual(400);
					expect(response.status).toBeLessThan(500);
				}));
			});
		}
	});

	describe('Public Endpoint Access Control', function() {
		const accessControlCases = [
			{
				name: 'private object returns 403 on public endpoint',
				visibility: 'private' as const,
				objectExists: true,
				expectedStatus: 403,
				expectedError: 'not public'
			},
			{
				name: 'non-existent object returns 404',
				visibility: 'public' as const,
				objectExists: false,
				expectedStatus: 404,
				expectedError: 'not found'
			}
		];

		for (const testCase of accessControlCases) {
			test(testCase.name, function() {
				return(withServer(async function({ backend, url }) {
					const ownerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
					const ownerPubKey = ownerAccount.publicKeyString.get();
					const objectPath = `/user/${ownerPubKey}/test-file.txt`;

					if (testCase.objectExists) {
						await backend.put(objectPath, Buffer.from('test content'), {
							owner: ownerPubKey,
							tags: [],
							visibility: testCase.visibility
						});
					}

					// Create a valid signed URL
					const expires = String(Math.floor(Date.now() / 1000) + 3600);
					const expiresNum = parseInt(expires, 10);
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

	describe('Path Traversal Prevention', function() {
		const traversalCases = [
			{ name: 'rejects ../ traversal', path: '/user/abc/../other/file.txt' },
			{ name: 'rejects /../ in middle', path: '/user/abc/docs/../../../etc/passwd' },
			{ name: 'rejects /. prefix', path: '/./user/abc/file.txt' },
			{ name: 'rejects // normalization', path: '/user//abc//file.txt' },
			{ name: 'rejects trailing /..', path: '/user/abc/..' }
		];

		for (const testCase of traversalCases) {
			test(testCase.name, function() {
				return(withServer(async function({ url }) {
					const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

					const signedField = await SignData(
						userAccount,
						getKeetaStorageAnchorGetRequestSigningData({ path: testCase.path, account: userAccount.publicKeyString.get() })
					);

					const requestUrl = addSignatureToURL(
						`${url}/api/object${testCase.path}`,
						{ signedField, account: userAccount }
					);

					const response = await fetch(requestUrl.toString(), {
						method: 'GET',
						headers: { 'Accept': 'application/json' }
					});

					// Should reject with 400 (invalid path) or 403 (access denied)
					expect(response.status).toBeGreaterThanOrEqual(400);
					expect(response.status).toBeLessThan(500);
				}));
			});
		}
	});

	describe('Metadata and Quota Operations', function() {
		test('GET /api/metadata returns 404 for non-existent object', function() {
			return(withServer(async function({ url }) {
				const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
				const path = `/user/${account.publicKeyString.get()}/nonexistent.txt`;

				const signable = getKeetaStorageAnchorGetRequestSigningData({ path, account: account.publicKeyString.get() });
				const signed = await SignData(account.assertAccount(), signable);
				const signedUrl = addSignatureToURL(new URL(`${url}/api/metadata${path}`), { signedField: signed, account: account.assertAccount() });

				const response = await fetch(signedUrl, {
					method: 'GET',
					headers: { 'Accept': 'application/json' }
				});

				expect(response.status).toBe(404);
			}));
		});

	});
});
