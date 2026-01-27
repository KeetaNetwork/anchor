import { test, expect, describe } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient, setResolverInfo } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import KeetaStorageAnchorClient, { type KeetaStorageAnchorProvider } from './client.js';
import { MemoryStorageBackend } from './drivers/memory.js';
import { makeStoragePath, type StoragePath, type StorageObjectMetadata, type StorageObjectVisibility } from './common.js';
import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';

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
	makePath: (relativePath: string) => StoragePath;
	/** Put a text file with sensible defaults */
	putText: (relativePath: string, content: string, options?: {
		tags?: string[];
		visibility?: StorageObjectVisibility;
	}) => Promise<StorageObjectMetadata>;
}

type ClientTestFn = (ctx: ClientTestContext) => Promise<void>;

interface WithClientOptions {
	providerName?: string;
}

/**
 * Helper to run a test with a fully configured client and provider.
 */
async function withClient(seed: string | ArrayBuffer, fn: ClientTestFn, options: WithClientOptions = {}): Promise<void> {
	const providerName = options.providerName ?? 'test-provider';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const anchorAccount = KeetaNet.lib.Account.fromSeed(seed, 50);

	await using nodeAndClient = await createNodeAndClient(account);
	const userClient = nodeAndClient.userClient;
	nodeAndClient.fees.disable();

	const backend = new MemoryStorageBackend();

	await using server = new KeetaNetStorageAnchorHTTPServer({
		backend,
		anchorAccount
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
	const provider = await storageClient.getProviderByID(providerName);
	if (!provider) {
		throw(new Error('Provider not found'));
	}

	// Helper to create paths from relative paths
	const makePath = (relativePath: string): StoragePath =>
		makeStoragePath(account.publicKeyString.get(), relativePath);

	// Helper to put text files with defaults
	const putText = (relativePath: string, content: string, opts?: {
		tags?: string[];
		visibility?: StorageObjectVisibility;
	}): Promise<StorageObjectMetadata> =>
		provider.put(makePath(relativePath), Buffer.from(content), {
			mimeType: 'text/plain',
			...opts
		}, account);

	await fn({ provider, account, anchorAccount, userClient, backend, storageClient, makePath, putText });
}

// #endregion

describe('Storage Client - Provider Discovery', () => {
	test('getProviders returns available providers', () => withClient(randomSeed(), async ({ provider }) => {
		expect(provider).toBeDefined();
		expect(provider.providerID).toBe('test-provider');
	}));

	test('getProviderByID returns null for non-existent provider', () => withClient(
		randomSeed(),
		async ({ storageClient }) => {
			const nonExistent = await storageClient.getProviderByID('non-existent');
			expect(nonExistent).toBeNull();
		},
		{ providerName: 'my-provider' }
	));
});

describe('Storage Client - Private Object CRUD', () => {
	test('put and get private object with encrypted container', () => withClient(randomSeed(), async ({ provider, account, makePath }) => {
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
		expect(getResult?.metadata.path).toBe(path);
	}));

	test('putData constructs path automatically', () => withClient(randomSeed(), async ({ provider, account, makePath }) => {
		const testData = Buffer.from('putData test');

		// Use putData with relative path
		const putResult = await provider.putData('nested/file.txt', testData, {
			mimeType: 'text/plain'
		}, account);

		// Verify path was constructed correctly
		const expectedPath = makePath('nested/file.txt');
		expect(putResult.path).toBe(expectedPath);

		// Verify data can be retrieved
		const getResult = await provider.get(expectedPath, account);
		expect(getResult).not.toBeNull();
		expect(getResult?.data.toString()).toBe('putData test');
	}));

	test('delete removes object', () => withClient(randomSeed(), async ({ provider, account, makePath, putText }) => {
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

describe('Storage Client - Public Objects', () => {
	test('put and get public object', () => withClient(randomSeed(), async ({ provider, account, anchorAccount, makePath }) => {
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

	test('pre-signed URL allows anonymous access', () => withClient(randomSeed(), async ({ provider, account, anchorAccount, makePath }) => {
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

		// Fetch via pre-signed URL (no auth headers)
		const response = await fetch(publicUrl);
		expect(response.status).toBe(200);
		const responseText = await response.text();
		expect(responseText).toBe('Publicly accessible');
	}));
});

describe('Storage Client - Search', () => {
	test('search by path prefix', () => withClient(randomSeed(), async ({ provider, account, makePath, putText }) => {
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

	test('search by tags', () => withClient(randomSeed(), async ({ provider, account, putText }) => {
		await putText('tagged1.txt', '1', { tags: ['important'] });
		await putText('tagged2.txt', '2', { tags: ['important', 'urgent'] });
		await putText('tagged3.txt', '3', { tags: ['other'] });

		const results = await provider.search({ tags: ['important'] }, undefined, account);
		expect(results.results).toHaveLength(2);
	}));
});

describe('Storage Client - Quota', () => {
	test('quota tracking updates after put', () => withClient(randomSeed(), async ({ provider, account, putText }) => {
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

describe('Storage Client - Error Cases', () => {
	test('get non-existent object returns null', () => withClient(randomSeed(), async ({ provider, account, makePath }) => {
		const path = makePath('does-not-exist.txt');
		const result = await provider.get(path, account);
		expect(result).toBeNull();
	}));
});
