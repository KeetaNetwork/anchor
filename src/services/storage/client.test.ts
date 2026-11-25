import { test, expect, describe, assert, vi } from 'vitest';

import type { KeetaAnchorStorageServerConfig } from './server.js';
import type { StorageObjectMetadata, StorageObjectVisibility } from './common.js';
import type { UserClient as KeetaNetUserClient } from '@keetanetwork/keetanet-client';
import type { KeetaStorageAnchorProvider } from './client.js';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient, setResolverInfo } from '../../lib/utils/tests/node.js';
import { buildChain } from '../../lib/utils/tests/certificates.js';
import { KeetaNetStorageAnchorHTTPServer } from './server.js';
import { MemoryStorageBackend } from './test-utils.js';
import { parseContainerPayload, Errors } from './common.js';
import { testPathPolicy } from './test-utils.js';
import { EncryptedContainer } from '../../lib/encrypted-container.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import KeetaStorageAnchorClient from './client.js';
import { Buffer } from '../../lib/utils/buffer.js';

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
	/**
	 * When true, server requires a cert chain. The harness mints
	 * `root CA -> intermediate CA -> leaf(account)` and publishes the leaf
	 * (with the intermediate as the supplied chain) on-chain for `account`.
	 * The trust set is `[rootCA]`, so verification succeeds via the
	 * supplied intermediate.
	 */
	useCertChain?: boolean;
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

	const serverConfig: KeetaAnchorStorageServerConfig = {
		backend,
		anchorAccount,
		pathPolicies: [testPathPolicy]
	};

	if (options.useCertChain) {
		const { root, intermediate, leaf } = await buildChain({
			rootIssuer: KeetaNet.lib.Account.fromSeed(seed, 200),
			intermediateIssuer: KeetaNet.lib.Account.fromSeed(seed, 201),
			leafSubject: account
		});

		const bundle = new KeetaNet.lib.Utils.Certificate.CertificateBundle([intermediate]);
		await userClient.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.ADD, leaf, bundle);

		serverConfig.requireCertificateChain = { trustedIssuers: [root], client: userClient.client };
	}

	await using server = new KeetaNetStorageAnchorHTTPServer(serverConfig);

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
		const putOpts: Parameters<typeof provider.put>[0] = {
			path: makePath(relativePath),
			data: Buffer.from(content),
			mimeType: 'text/plain',
			account
		};
		if (opts?.tags) {
			putOpts.tags = opts.tags;
		}
		if (opts?.visibility) {
			putOpts.visibility = opts.visibility;
		}
		return(provider.put(putOpts));
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
	test('put and get private object with encrypted container (cert-chain enforced)', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const testData = Buffer.from('Hello, World!');
			const path = makePath('test.txt');

			// PUT
			const putResult = await provider.put({
				path,
				data: testData,
				mimeType: 'text/plain',
				tags: ['test', 'hello'],
				visibility: 'private',
				account
			});

			expect(putResult.path).toBe(path);
			expect(putResult.visibility).toBe('private');
			expect(putResult.tags).toEqual(['test', 'hello']);

			// GET
			const getResult = await provider.get({ path, account });
			expect(getResult).not.toBeNull();
			expect(getResult?.data.toString()).toBe('Hello, World!');
			expect(getResult?.mimeType).toBe('text/plain');

			/*
			 * An account without a published cert chain is rejected with 401.
			 */
			const nonCertAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
			await expect(provider.get({ path, account: nonCertAccount }))
				.rejects.toSatisfy(function(error: unknown) {
					return(Errors.CertificateRequired.isInstance(error) && error.kind === 'missing' && error.statusCode === 401);
				});
		}, { useCertChain: true }));
	});

	test('cert-chain enforcement rejects account whose cert does not chain to a trusted issuer (403)', function() {
		return(withClient(randomSeed(), async function({ provider, userClient, makePath }) {
			const otherAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
			const untrustedRootIssuer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

			const { leaf: untrustedLeaf } = await buildChain({
				rootIssuer: untrustedRootIssuer,
				leafSubject: otherAccount
			});

			const otherUserClient = new KeetaNet.UserClient({
				client: userClient.client,
				signer: otherAccount,
				usePublishAid: false,
				network: userClient.network,
				networkAlias: 'test'
			});
			await otherUserClient.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.ADD, untrustedLeaf, null);

			/*
			 * An account with a cert chain that does not chain to a trusted issuer is rejected with 403.
			 */
			const path = makePath('any.txt');
			await expect(provider.get({ path, account: otherAccount }))
				.rejects.toSatisfy(function(error: unknown) {
					return(Errors.CertificateRequired.isInstance(error) && error.kind === 'untrusted' && error.statusCode === 403);
				});
		}, { useCertChain: true }));
	});

	test('cert-chain enforcement does not gate pre-signed public URLs (anonymous fetch)', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const path = makePath('public.txt');
			const data = Buffer.from('public via signed url under cert gate');

			await provider.put({
				path,
				data,
				mimeType: 'text/plain',
				visibility: 'public',
				account,
				anchorAccount
			});

			const publicUrl = await provider.getPublicUrl({ path, ttl: 3600, account });
			const response = await fetch(publicUrl);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe('public via signed url under cert gate');
		}, { useCertChain: true }));
	});

	test('delete removes object', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath, putText }) {
			const path = makePath('to-delete.txt');

			// PUT
			await putText('to-delete.txt', 'delete me');

			// Verify exists
			const before = await provider.get({ path, account });
			expect(before).not.toBeNull();

			// DELETE
			const deleted = await provider.delete({ path, account });
			expect(deleted).toBe(true);

			// Verify gone
			const after = await provider.get({ path, account });
			expect(after).toBeNull();
		}));
	});

	test('put with additionalPrincipals allows recipient to decrypt', function() {
		return(withClient(randomSeed(), async function({ provider, account, backend, makePath }) {
			const recipientAccount = KeetaNet.lib.Account.fromSeed(randomSeed(), 0);
			const testData = Buffer.from('shared secret');
			const path = makePath('shared.txt');

			await provider.put({
				path,
				data: testData,
				mimeType: 'text/plain',
				visibility: 'private',
				account,
				additionalPrincipals: [recipientAccount]
			});

			const rawEntry = await backend.get(path);
			assert(rawEntry);

			const container = EncryptedContainer.fromEncryptedBuffer(rawEntry.data, [recipientAccount]);
			const plaintext = await container.getPlaintext();
			const { mimeType, content } = parseContainerPayload(plaintext);
			expect(content.toString()).toBe('shared secret');
			expect(mimeType).toBe('text/plain');
		}));
	});
});

describe('Storage Client - Public Objects', function() {
	test('put and get public object', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const testData = Buffer.from('Public content');
			const path = makePath('public.txt');

			// PUT with visibility: public and anchor account
			const putResult = await provider.put({
				path,
				data: testData,
				mimeType: 'text/plain',
				visibility: 'public',
				account,
				anchorAccount
			});

			expect(putResult.visibility).toBe('public');

			// GET still works for owner
			const getResult = await provider.get({ path, account });
			expect(getResult).not.toBeNull();
			expect(getResult?.data.toString()).toBe('Public content');
		}));
	});

	test('pre-signed URL allows anonymous access', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const testData = Buffer.from('Publicly accessible');
			const path = makePath('signed-url.txt');

			// PUT public object
			await provider.put({
				path,
				data: testData,
				mimeType: 'text/plain',
				visibility: 'public',
				account,
				anchorAccount
			});

			// Generate pre-signed URL
			const publicUrl = await provider.getPublicUrl({ path, ttl: 3600, account });
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

describe('Storage Client - Get Public Content', function() {
	test('provider.getPublicContent round-trips a public object', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath }) {
			const data = Buffer.from('public bytes');
			const path = makePath('pub.bin');
			await provider.put({ path, data, mimeType: 'image/png', visibility: 'public', account, anchorAccount });

			const result = await provider.getPublicContent({ path, account });
			expect(result).not.toBeNull();
			expect(result?.mimeType).toBe('image/png');
			expect(result?.data).toEqual(data);
		}));
	});

	test('provider.getPublicContent returns null for a nonexistent object', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const result = await provider.getPublicContent({ path: makePath('missing.bin'), account });
			expect(result).toBeNull();
		}));
	});

	test('provider.getPublicContent throws for a private object (not null)', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const path = makePath('private.bin');
			await provider.put({ path, data: Buffer.from('secret'), mimeType: 'image/png', visibility: 'private', account });

			await expect(provider.getPublicContent({ path, account })).rejects.toSatisfy(function(e: unknown) {
				return(!Errors.DocumentNotFound.isInstance(e));
			});
		}));
	});

	test('session.getPublicContent resolves the working directory', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount }) {
			const ownerKey = account.publicKeyString.get();
			const data = Buffer.from('session bytes');
			await provider.put({
				path: `/user/${ownerKey}/avatar.png`,
				data,
				mimeType: 'image/png',
				visibility: 'public',
				account,
				anchorAccount
			});

			const session = provider.beginSession({
				account,
				workingDirectory: `/user/${ownerKey}/`,
				defaultVisibility: 'public'
			});
			const result = await session.getPublicContent('avatar.png');
			expect(result).not.toBeNull();
			expect(result?.mimeType).toBe('image/png');
			expect(result?.data).toEqual(data);
		}));
	});
});

describe('Storage Client - Update Metadata', function() {
	test('updateMetadata updates tags and visibility', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath, putText }) {
			await putText('meta.txt', 'content', { tags: ['old'], visibility: 'private' });
			const path = makePath('meta.txt');

			const result = await provider.updateMetadata({ path, tags: ['new', 'updated'], visibility: 'private', account });
			expect(result).not.toBeNull();
			expect(result?.tags).toEqual(['new', 'updated']);
			expect(result?.visibility).toBe('private');
		}));
	});

	test('updateMetadata returns null for non-existent object', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const result = await provider.updateMetadata({
				path: makePath('missing.txt'),
				tags: ['tag'],
				visibility: 'private',
				account
			});

			expect(result).toBeNull();
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
				criteria: { pathPrefix: makePath('docs/') },
				account
			});

			expect(results.results).toHaveLength(2);
		}));
	});

	test('search by tags', function() {
		return(withClient(randomSeed(), async function({ provider, account, putText }) {
			await putText('tagged1.txt', '1', { tags: ['important'] });
			await putText('tagged2.txt', '2', { tags: ['important', 'urgent'] });
			await putText('tagged3.txt', '3', { tags: ['other'] });

			const results = await provider.search({ criteria: { tags: ['important'] }, account });
			expect(results.results).toHaveLength(2);
		}));
	});
});

describe('Storage Client - Quota', function() {
	test('quota tracking updates after put', function() {
		return(withClient(randomSeed(), async function({ provider, account, putText }) {
			// Check initial quota
			const before = await provider.getQuotaStatus({ account });
			expect(before.objectCount).toBe(0);
			expect(before.totalSize).toBe(0);

			// Add an object
			await putText('quota-test.txt', '12345');

			// Check updated quota
			const after = await provider.getQuotaStatus({ account });
			expect(after.objectCount).toBe(1);
			expect(after.totalSize).toBeGreaterThan(0);
		}));
	});
});

describe('Storage Client - Error Cases', function() {
	test('get non-existent object returns null', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath }) {
			const path = makePath('does-not-exist.txt');
			const result = await provider.get({ path, account });
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

	test('session updateMetadata with relative path', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory });

			await session.put('update-meta.txt', Buffer.from('data'), { mimeType: 'text/plain', tags: ['original'] });

			const result = await session.updateMetadata('update-meta.txt', { tags: ['replaced'], visibility: 'private' });
			expect(result).not.toBeNull();
			expect(result?.tags).toEqual(['replaced']);
			expect(result?.path).toBe(`${workingDirectory}update-meta.txt`);
		}));
	});

	test('session updateMetadata uses default visibility', function() {
		return(withClient(randomSeed(), async function({ provider, account }) {
			const workingDirectory = testPathPolicy.getNamespacePrefix(account.publicKeyString.get());
			const session = provider.beginSession({ account, workingDirectory, defaultVisibility: 'private' });

			await session.put('vis-test.txt', Buffer.from('data'), { mimeType: 'text/plain' });

			const result = await session.updateMetadata('vis-test.txt', { tags: ['tag'] });
			expect(result).not.toBeNull();
			expect(result?.visibility).toBe('private');
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

describe('Storage Client - Signed request replay', function() {
	test('a captured put cannot write other content, here or at another storage anchor', function() {
		return(withClient(randomSeed(), async function({ provider, account, anchorAccount, makePath, backend }) {
			const path = makePath('contact.txt');

			/* Record the exact upload the client sends */
			let captured: string | undefined;
			const realFetch = globalThis.fetch;
			const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async function(input, init) {
				if (init?.method === 'PUT') {
					captured = (input instanceof Request ? input.url : input.toString());
				}
				return(await realFetch(input, init));
			});
			try {
				await provider.put({ path, data: Buffer.from('address A'), mimeType: 'text/plain', account });
			} finally {
				spy.mockRestore();
			}
			if (captured === undefined) {
				throw(new Error('No upload captured'));
			}
			const stored = await backend.get(path);

			const otherBackend = new MemoryStorageBackend();
			await using otherServer = new KeetaNetStorageAnchorHTTPServer({ backend: otherBackend, anchorAccount, pathPolicies: [testPathPolicy] });
			await otherServer.start();

			/* Well-formed content for the same owner, written by someone else */
			const attacker = KeetaNet.lib.Account.fromSeed(randomSeed(), 0);
			const forged = EncryptedContainer.fromPlaintext(JSON.stringify({ mimeType: 'text/plain', data: Buffer.from('address B').toString('base64') }), [account], { signer: attacker });
			const forgedBody = Buffer.from(await forged.getEncodedBuffer());

			async function upload(url: URL): Promise<number> {
				const response = await realFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: forgedBody });
				await response.arrayBuffer();
				return(response.status);
			}

			const original = new URL(captured);
			expect(await upload(original)).not.toBe(200);
			expect((await backend.get(path))?.data).toEqual(stored?.data);

			expect(await upload(new URL(`${original.pathname}${original.search}`, otherServer.url))).not.toBe(200);
			expect(await otherBackend.get(path)).toBeNull();
		}));
	});
});

describe('Storage Client - Content signer', function() {
	test('get returns only content signed by an accepted account', function() {
		return(withClient(randomSeed(), async function({ provider, account, makePath, backend }) {
			const path = makePath('contact.txt');
			const owner = account.publicKeyString.get();

			async function encodeSignedBy(signer: InstanceType<typeof KeetaNet.lib.Account> | undefined, text: string): Promise<Buffer> {
				const plaintext = JSON.stringify({ mimeType: 'text/plain', data: Buffer.from(text).toString('base64') });
				let container: EncryptedContainer;
				if (signer === undefined) {
					container = EncryptedContainer.fromPlaintext(plaintext, [account]);
				} else {
					container = EncryptedContainer.fromPlaintext(plaintext, [account], { signer });
				}
				return(Buffer.from(await container.getEncodedBuffer()));
			}

			async function storeSignedBy(signer: InstanceType<typeof KeetaNet.lib.Account> | undefined, text: string) {
				await backend.put(path, await encodeSignedBy(signer, text), { owner, tags: [], visibility: 'private' });
			}

			async function getError(): Promise<unknown> {
				return(await provider.get({ path, account }).then(function() {
					return(null);
				}, function(error: unknown) {
					return(error);
				}));
			}

			/* Unsigned content, the cheapest thing a storage anchor can serve */
			await storeSignedBy(undefined, 'address C');
			expect(Errors.SignatureInvalid.isInstance(await getError())).toBe(true);

			/* Content the storage anchor serves, but someone else wrote */
			const attacker = KeetaNet.lib.Account.fromSeed(randomSeed(), 0);
			await storeSignedBy(attacker, 'address B');
			expect(Errors.SignatureInvalid.isInstance(await getError())).toBe(true);

			/* Content another account wrote is returned when the caller accepts that account */
			const accepted = await provider.get({ path, account, signers: [ attacker ] });
			expect(accepted?.data.toString()).toBe('address B');

			/* A signature made with an unsupported digest cannot be checked, so it proves nothing */
			const encoded = await encodeSignedBy(account, 'address D');
			/* DER of the SHA3-256 OID (2.16.840.1.101.3.4.2.8); the last arc becomes 10, SHA3-512 */
			const sha3OID = Buffer.from('0609608648016503040208', 'hex');
			const oidOffset = encoded.indexOf(sha3OID);
			expect(oidOffset).toBeGreaterThan(-1);
			encoded[oidOffset + sha3OID.length - 1] = 0x0a;
			await backend.put(path, encoded, { owner, tags: [], visibility: 'private' });
			const unsupportedError = await getError();
			expect(Errors.SignatureInvalid.isInstance(unsupportedError)).toBe(true);

			/* The reader's own content needs no list */
			await storeSignedBy(account, 'address A');
			expect((await provider.get({ path, account }))?.data.toString()).toBe('address A');
		}));
	});
});
