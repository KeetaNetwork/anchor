import { test, expect, describe } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient, setResolverInfo } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import KeetaStorageAnchorClient, { type KeetaStorageAnchorProvider } from './client.js';
import { MemoryStorageBackend } from './drivers/memory.js';
import type { StorageObjectMetadata, StorageObjectVisibility, PathPolicy } from './common.js';
import { Errors } from './common.js';
import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';

// #region Test Path Policy

/**
 * Parsed path for the test path policy: /user/<pubkey>/<relativePath>
 */
type TestParsedPath = {
	path: string;
	owner: string;
	relativePath: string;
};

/**
 * Test path policy implementing the /user/<pubkey>/<path> pattern.
 */
class TestPathPolicy implements PathPolicy<TestParsedPath> {
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
		return(parsed.owner === account.publicKeyString.get());
	}

	getAuthorizedSigner(parsed: TestParsedPath): string | null {
		return(parsed.owner);
	}

	makePath(owner: string, relativePath: string): string {
		return(`/user/${owner}/${relativePath}`);
	}

	getNamespacePrefix(owner: string): string {
		return(`/user/${owner}/`);
	}
}

const testPathPolicy = new TestPathPolicy();

// #endregion

// #region Test Harness

type Account = InstanceType<typeof KeetaNet.lib.Account>;

/** Generate a random seed for test isolation */
function randomSeed() {
	return(KeetaNet.lib.Account.generateRandomSeed());
}

interface ClientTestContext {
	provider: KeetaStorageAnchorProvider;
	account: Account;
	anchorAccount: Account;
	userClient: KeetaNetUserClient;
	backend: MemoryStorageBackend;
	storageClient: KeetaStorageAnchorClient;
	/** Create a storage path from a relative path */
	makePath: (relativePath: string) => string;
	/** Put a text file with sensible defaults */
	putText: (relativePath: string, content: string, options?: {
		tags?: string[];
		visibility?: StorageObjectVisibility;
	}) => Promise<StorageObjectMetadata>;
}

type ClientTestFunction = (context: ClientTestContext) => Promise<void>;

interface WithClientOptions {
	providerName?: string;
}

/**
 * Helper to run a test with a fully configured client and provider.
 */
async function withClient(seed: string | ArrayBuffer, testFunction: ClientTestFunction, options: WithClientOptions = {}): Promise<void> {
	const providerName = options.providerName ?? 'test-provider';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const anchorAccount = KeetaNet.lib.Account.fromSeed(seed, 50);

	await using nodeAndClient = await createNodeAndClient(account);
	const userClient = nodeAndClient.userClient;
	nodeAndClient.fees.disable();

	const backend = new MemoryStorageBackend();

	await using server = new KeetaNetStorageAnchorHTTPServer({
		backend,
		anchorAccount,
		pathPolicies: [testPathPolicy]
	});

	await server.start();

	const rootAccount = KeetaNet.lib.Account.fromSeed(seed, 100);
	const serviceMetadata = await server.serviceMetadata();

	await setResolverInfo(rootAccount, userClient, {
		version: 1,
		currencyMap: {},
		services: {
			storage: {
				[providerName]: serviceMetadata
			}
		}
	});

	const resolver = new KeetaAnchorResolver({
		root: rootAccount,
		client: userClient,
		trustedCAs: []
	});

	const storageClient = new KeetaStorageAnchorClient(userClient, { resolver });
	const maybeProvider = await storageClient.getProviderByID(providerName);
	if (!maybeProvider) {
		throw(new Error('Provider not found'));
	}
	const provider = maybeProvider;

	// Helper to create paths from relative paths
	function makePath(relativePath: string): string {
		return(testPathPolicy.makePath(account.publicKeyString.get(), relativePath));
	}

	// Helper to put text files with defaults
	function putText(relativePath: string, content: string, opts?: {
		tags?: string[];
		visibility?: StorageObjectVisibility;
	}): Promise<StorageObjectMetadata> {
		return(provider.put(makePath(relativePath), Buffer.from(content), {
			mimeType: 'text/plain',
			...opts
		}, account));
	}

	await testFunction({ provider, account, anchorAccount, userClient, backend, storageClient, makePath, putText });
}

// #endregion

describe('Storage Client - Provider Discovery', function() {
	test('getProviders returns available providers', function() {
		return(withClient(randomSeed(), async function({ provider }) {
			expect(provider).toBeDefined();
			expect(provider.providerID).toBe('test-provider');
		}));
	});

	test('getProviderByID returns null for non-existent provider', function() {
		return(withClient(
			randomSeed(),
			async function({ storageClient }) {
				const nonExistent = await storageClient.getProviderByID('non-existent');
				expect(nonExistent).toBeNull();
			},
			{ providerName: 'my-provider' }
		));
	});
});

describe('Storage Client - Private Object CRUD', function() {
	test('put and get private object with encrypted container', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const testData = Buffer.from('Hello, World!');
			const path = makePath('test.txt');

			// PUT
			const putResult = await provider.put(path, testData, {
				mimeType: 'text/plain',
				tags: ['test', 'hello'],
				visibility: 'private'
			}, account);

			expect(putResult.path).toBe(path);
			expect(putResult.visibility).toBe('private');
			expect(putResult.tags).toEqual(['test', 'hello']);

			// GET
			const getResult = await provider.get(path, account);
			expect(getResult).not.toBeNull();
			expect(getResult?.data.toString()).toBe('Hello, World!');
			expect(getResult?.mimeType).toBe('text/plain');
		}));
	});

	test('delete removes object', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath, putText }) {
			const path = makePath('to-delete.txt');

			// PUT
			await putText('to-delete.txt', 'delete me');

			// Verify exists
			const before = await provider.get(path, account);
			expect(before).not.toBeNull();

			// DELETE
			const deleted = await provider.delete({ path, account });
			expect(deleted).toBe(true);

			// Verify gone
			const after = await provider.get(path, account);
			expect(after).toBeNull();
		}));
	});
});

describe('Storage Client - Public Objects', function() {
	test('put and get public object', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const testData = Buffer.from('Public content');
			const path = makePath('public.txt');

			// PUT with visibility: public and anchor account
			const putResult = await provider.put(path, testData, {
				mimeType: 'text/plain',
				visibility: 'public'
			}, account, anchorAccount);

			expect(putResult.visibility).toBe('public');

			// GET still works for owner
			const getResult = await provider.get(path, account);
			expect(getResult).not.toBeNull();
			expect(getResult?.data.toString()).toBe('Public content');
		}));
	});

	test('pre-signed URL allows anonymous access', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const testData = Buffer.from('Publicly accessible');
			const path = makePath('signed-url.txt');

			// PUT public object
			await provider.put(path, testData, {
				mimeType: 'text/plain',
				visibility: 'public'
			}, account, anchorAccount);

			// Generate pre-signed URL
			const publicUrl = await provider.getPublicUrl(path, { ttl: 3600 }, account);
			expect(publicUrl).toContain('/api/public');
			expect(publicUrl).toContain('signature=');
			expect(publicUrl).toContain('expires=');
			expect(publicUrl).toContain('nonce=');
			expect(publicUrl).toContain('timestamp=');

			// Fetch via pre-signed URL (no auth headers)
			const response = await fetch(publicUrl);
			expect(response.status).toBe(200);
			const responseText = await response.text();
			expect(responseText).toBe('Publicly accessible');
		}));
	});
});

describe('Storage Client - Search', function() {
	test('search by path prefix', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath, putText }) {
			// Create multiple objects
			await putText('docs/a.txt', 'a');
			await putText('docs/b.txt', 'b');
			await putText('other/c.txt', 'c');

			// Search by prefix
			const results = await provider.search({
				pathPrefix: makePath('docs/')
			}, undefined, account);

			expect(results.results).toHaveLength(2);
		}));
	});

	test('search by tags', function() {
		return(withClient(randomSeed(), async function({ provider, account, putText }) {
			await putText('tagged1.txt', '1', { tags: ['important'] });
			await putText('tagged2.txt', '2', { tags: ['important', 'urgent'] });
			await putText('tagged3.txt', '3', { tags: ['other'] });

			const results = await provider.search({ tags: ['important'] }, undefined, account);
			expect(results.results).toHaveLength(2);
		}));
	});
});

describe('Storage Client - Quota', function() {
	test('quota tracking updates after put', function() {
		return(withClient(randomSeed(), async function({ provider, account, putText }) {
			// Check initial quota
			const before = await provider.getQuotaStatus(account);
			expect(before.objectCount).toBe(0);
			expect(before.totalSize).toBe(0);

			// Add an object
			await putText('quota-test.txt', '12345');

			// Check updated quota
			const after = await provider.getQuotaStatus(account);
			expect(after.objectCount).toBe(1);
			expect(after.totalSize).toBeGreaterThan(0);
		}));
	});
});

describe('Storage Client - Error Cases', function() {
	test('get non-existent object returns null', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const path = makePath('does-not-exist.txt');
			const result = await provider.get(path, account);
			expect(result).toBeNull();
		}));
	});
});

describe('Storage Client - Session API', function() {
	test('beginSession creates session with working directory', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory });

			expect(session.account).toBe(account);
			expect(session.provider).toBe(provider);
			expect(session.workingDirectory).toBe(workingDirectory);
		}));
	});

	test('session put/get with relative paths', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory });

			// Put using relative path
			const metadata = await session.put('session-test.txt', Buffer.from('session content'), {
				mimeType: 'text/plain'
			});
			expect(metadata.path).toBe(`${workingDirectory}session-test.txt`);

			// Get using relative path
			const result = await session.get('session-test.txt');
			expect(result).not.toBeNull();
			expect(result?.data.toString()).toBe('session content');
			expect(result?.mimeType).toBe('text/plain');
		}));
	});

	test('session delete with relative paths', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory });

			// Create file
			await session.put('to-delete.txt', Buffer.from('delete me'), { mimeType: 'text/plain' });

			// Delete using relative path
			const deleted = await session.delete('to-delete.txt');
			expect(deleted).toBe(true);

			// Verify deleted
			const result = await session.get('to-delete.txt');
			expect(result).toBeNull();
		}));
	});

	test('session search scopes to account', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory });

			// Create files with tags
			await session.put('tagged.txt', Buffer.from('tagged'), { mimeType: 'text/plain', tags: ['searchable'] });

			// Search using session (owner is automatic)
			const results = await session.search({ tags: ['searchable'] });
			expect(results.results).toHaveLength(1);
			expect(results.results[0]?.tags).toContain('searchable');
		}));
	});

	test('session with custom working directory', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const pubKey = account.publicKeyString.get();
			const session = provider.beginSession({
				account,
				workingDirectory: `/user/${pubKey}/docs/`
			});

			expect(session.workingDirectory).toBe(`/user/${pubKey}/docs/`);

			// Put using relative path
			const metadata = await session.put('nested.txt', Buffer.from('nested'), { mimeType: 'text/plain' });
			expect(metadata.path).toBe(`/user/${pubKey}/docs/nested.txt`);
		}));
	});

	test('session respects absolute paths', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const pubKey = account.publicKeyString.get();
			const session = provider.beginSession({
				account,
				workingDirectory: `/user/${pubKey}/docs/`
			});

			// Using absolute path ignores working directory
			const absolutePath = `/user/${pubKey}/absolute.txt`;
			const metadata = await session.put(absolutePath, Buffer.from('absolute'), { mimeType: 'text/plain' });
			expect(metadata.path).toBe(absolutePath);
		}));
	});

	test('session default visibility', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDir = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({
				account,
				workingDirectory: workingDir,
				defaultVisibility: 'public'
			});

			// Anchor account is automatically fetched from provider for public objects
			const metadata = await session.put('default-public.txt', Buffer.from('public'), { mimeType: 'text/plain' });
			expect(metadata.visibility).toBe('public');
		}));
	});

	test('withSession helper', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDir = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const result = await provider.withSession({ account, workingDirectory: workingDir }, async function(session) {
				await session.put('with-session.txt', Buffer.from('via withSession'), { mimeType: 'text/plain' });
				const data = await session.get('with-session.txt');
				return(data?.data.toString());
			});

			expect(result).toBe('via withSession');
		}));
	});
});
