import { test, expect, describe } from 'vitest';

import type { IconData } from './icon.js';
import type { Account } from '../test-utils.js';
import type KeetaStorageAnchorClient from '../client.js';
import { StorageIconsClient } from './icon.js';
import { Errors } from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';
import { KeetaNet } from '../../../client/index.js';
import { randomSeed, withStorageProvider, withAnySignerStorageProvider } from '../test-utils.js';

// #region Test Harness

interface IconsTestContext {
	iconsClient: StorageIconsClient;
	account: Account;
	storageClient: KeetaStorageAnchorClient;
}

async function withIcons(
	seed: string | ArrayBuffer,
	testFunction: (ctx: IconsTestContext) => Promise<void>
): Promise<void> {
	await withStorageProvider(seed, async function({ provider, account, storageClient }) {
		const pubkey = account.publicKeyString.get();
		const iconsClient = provider.getIconsClient({ account, basePath: `/user/${pubkey}/` });
		await testFunction({ iconsClient, account, storageClient });
	});
}

// #endregion

// #region Test Fixtures

const pngIcon: IconData = {
	data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
	mimeType: 'image/png'
};

const jpegIcon: IconData = {
	data: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
	mimeType: 'image/jpeg'
};

const webpIcon: IconData = {
	data: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
	mimeType: 'image/webp'
};

const sampleIcons: { name: string; icon: IconData }[] = [
	{ name: 'png', icon: pngIcon },
	{ name: 'jpeg', icon: jpegIcon },
	{ name: 'webp', icon: webpIcon }
];

// #endregion

// #region Tests

describe('Icons Client - Set and Get', function() {
	test.each(sampleIcons)('set and get icon: $name', function({ icon }) {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(icon);

			const retrieved = await iconsClient.get();
			expect(retrieved).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.mimeType).toBe(icon.mimeType);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.data).toEqual(icon.data);
		}));
	});

	test('get nonexistent icon returns null', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			const result = await iconsClient.get();
			expect(result).toBeNull();
		}));
	});

	test('set replaces existing icon', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(pngIcon);
			await iconsClient.set(jpegIcon);

			const retrieved = await iconsClient.get();
			expect(retrieved).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.mimeType).toBe(jpegIcon.mimeType);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.data).toEqual(jpegIcon.data);
		}));
	});
});

describe('Icons Client - Delete', function() {
	test('delete existing icon returns true', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(pngIcon);

			const deleted = await iconsClient.delete();
			expect(deleted).toBe(true);

			const retrieved = await iconsClient.get();
			expect(retrieved).toBeNull();
		}));
	});

	test('delete nonexistent icon returns false', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			const deleted = await iconsClient.delete();
			expect(deleted).toBe(false);
		}));
	});
});

describe('Icons Client - MIME Type Validation', function() {
	const invalidMimeTypes = [
		{ mimeType: 'text/plain', name: 'text/plain' },
		{ mimeType: 'application/json', name: 'application/json' },
		{ mimeType: 'video/mp4', name: 'video/mp4' }
	];

	test.each(invalidMimeTypes)('rejects invalid MIME type: $name', function({ mimeType }) {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			const invalidIcon: IconData = { data: Buffer.from('not an image'), mimeType };
			await expect(iconsClient.set(invalidIcon))
				.rejects.toSatisfy(function(e: unknown) { return(Errors.ValidationFailed.isInstance(e)); });
		}));
	});
});

describe('Icons Client - Get Public (own icon)', function() {
	test.each(sampleIcons)('set and getPublic icon: $name', function({ icon }) {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(icon);

			const retrieved = await iconsClient.getPublic();
			expect(retrieved).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.mimeType).toBe(icon.mimeType);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(retrieved!.data).toEqual(icon.data);
		}));
	});

	test('getPublic nonexistent icon returns null', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			const result = await iconsClient.getPublic();
			expect(result).toBeNull();
		}));
	});

	test('getPublic matches get() for the same icon', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(jpegIcon);

			const viaGet = await iconsClient.get();
			const viaPublic = await iconsClient.getPublic();
			expect(viaGet).not.toBeNull();
			expect(viaPublic).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(viaPublic!.mimeType).toBe(viaGet!.mimeType);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(viaPublic!.data).toEqual(viaGet!.data);
		}));
	});

	test('getPublic after delete returns null', function() {
		return(withIcons(randomSeed(), async function({ iconsClient }) {
			await iconsClient.set(pngIcon);
			await iconsClient.delete();

			const result = await iconsClient.getPublic();
			expect(result).toBeNull();
		}));
	});
});

describe('Icons Client - Get Public (cross-account)', function() {
	test("reads another account's public icon when the signer is authorized", function() {
		return(withAnySignerStorageProvider(randomSeed(), async function({ provider, account }) {
			// Some other account uploads an icon to its own namespace.
			const owner = KeetaNet.lib.Account.fromSeed(randomSeed(), 0);
			const ownerKey = owner.publicKeyString.get();
			expect(ownerKey).not.toBe(account.publicKeyString.get());
			const basePath = `/user/${ownerKey}/`;

			await provider.getIconsClient({ account: owner, basePath }).set(pngIcon);

			// Now we (the client account, not the owner) pull it down. getPublic
			// signs as the client, so we never touch the owner's private key.
			const readerIcons = provider.getIconsClient({ account: owner, basePath });
			const result = await readerIcons.getPublic();
			expect(result).not.toBeNull();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(result!.mimeType).toBe(pngIcon.mimeType);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(result!.data).toEqual(pngIcon.data);
		}));
	});

	test('rejects a foreign signer when the policy pins the signer to the owner', function() {
		return(withStorageProvider(randomSeed(), async function({ provider, account }) {
			const owner = KeetaNet.lib.Account.fromSeed(randomSeed(), 0);
			const ownerKey = owner.publicKeyString.get();
			expect(ownerKey).not.toBe(account.publicKeyString.get());
			const basePath = `/user/${ownerKey}/`;

			await provider.getIconsClient({ account: owner, basePath }).set(pngIcon);

			// This policy only trusts the owner's signature, so our client-signed read
			// should be turned away. The point is it errors rather than quietly returning null.
			const readerIcons = provider.getIconsClient({ account: owner, basePath });
			await expect(readerIcons.getPublic()).rejects.toSatisfy(function(e: unknown) {
				return(!Errors.DocumentNotFound.isInstance(e));
			});
		}));
	});
});

describe('Icons Client - Factory Methods', function() {
	test('getIconsClient via storage client resolves provider', function() {
		return(withIcons(randomSeed(), async function({ storageClient, account }) {
			const pubkey = account.publicKeyString.get();
			const iconsClient = await storageClient.getIconsClient({ account, basePath: `/user/${pubkey}/` });
			expect(iconsClient).toBeInstanceOf(StorageIconsClient);
		}));
	});
});

// #endregion
