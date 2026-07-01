import { test, expect, describe } from 'vitest';

import type { Profile } from './profile.js';
import type { Account } from '../test-utils.js';
import type { KeetaStorageAnchorProvider } from '../client.js';
import type { StorageProfileClient } from './profile.js';
import { randomSeed, withStorageProvider } from '../test-utils.js';

// #region Test Harness

interface ProfileTestContext {
	profileClient: StorageProfileClient;
	provider: KeetaStorageAnchorProvider;
	account: Account;
}

async function withProfile(
	seed: string | ArrayBuffer,
	testFunction: (ctx: ProfileTestContext) => Promise<void>
): Promise<void> {
	await withStorageProvider(seed, async function({ provider, account }) {
		const pubkey = account.publicKeyString.get();
		const profileClient = provider.getProfileClient({ account, basePath: `/user/${pubkey}/profile/` });
		await testFunction({ profileClient, provider, account });
	});
}

function privatePath(account: Account): string {
	return(`/user/${account.publicKeyString.get()}/profile/private`);
}

function publicPath(account: Account): string {
	return(`/user/${account.publicKeyString.get()}/profile/public`);
}

// #endregion

// #region Test Fixtures

const personalProfile: Profile = {
	accountType: 'personal',
	displayName: 'Alice',
	firstName: 'Alice',
	lastName: 'Smith'
};

const businessProfile: Profile = {
	accountType: 'business',
	displayName: 'Acme Corp',
	companyName: 'Acme Corporation Ltd',
	country: 'US'
};

const invalidProfiles: { name: string; profile: unknown }[] = [
	{ name: 'business missing country', profile: { accountType: 'business', displayName: 'Acme', companyName: 'Acme Corporation Ltd' }},
	{ name: 'business with invalid country code', profile: { accountType: 'business', displayName: 'Acme', companyName: 'Acme Corporation Ltd', country: 'XX' }},
	{ name: 'unknown account type', profile: { accountType: 'enterprise', displayName: 'Acme' }},
	{ name: 'personal missing name fields', profile: { accountType: 'personal', displayName: 'Alice' }},
	{ name: 'personal missing lastName', profile: { accountType: 'personal', displayName: 'Alice', firstName: 'Alice' }}
];

// #endregion

describe('Storage Profile Client', function() {
	test('set and get a personal profile', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(personalProfile);

			const result = await profileClient.get();
			expect(result).toEqual(personalProfile);
		}));
	});

	test('set and get a business profile', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(businessProfile);

			const result = await profileClient.get();
			expect(result).toEqual(businessProfile);
		}));
	});

	test('getPublic returns only the public projection', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(personalProfile);

			const result = await profileClient.getPublic();
			expect(result).toEqual({ accountType: 'personal', displayName: 'Alice' });
		}));
	});

	test('getPublic returns the projection for a business profile', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(businessProfile);

			const result = await profileClient.getPublic();
			expect(result).toEqual({ accountType: 'business', displayName: 'Acme Corp' });
		}));
	});

	test('stores the full profile privately and the projection publicly', function() {
		return(withProfile(randomSeed(), async function({ profileClient, provider, account }) {
			await profileClient.set(personalProfile);

			const [ privateMeta, publicMeta ] = await Promise.all([
				provider.getMetadata({ path: privatePath(account), account }),
				provider.getMetadata({ path: publicPath(account), account })
			]);

			expect(privateMeta?.visibility).toBe('private');
			expect(publicMeta?.visibility).toBe('public');
		}));
	});

	test('the private object is not readable via a public URL', function() {
		return(withProfile(randomSeed(), async function({ profileClient, provider, account }) {
			await profileClient.set(personalProfile);

			const url = await provider.getPublicUrl({ path: privatePath(account), account });
			const response = await fetch(url);

			expect(response.status).toBe(403);
		}));
	});

	test('get and getPublic return null when no profile is set', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			expect(await profileClient.get()).toBeNull();
			expect(await profileClient.getPublic()).toBeNull();
		}));
	});

	test('set overwrites an existing profile and can switch account type', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(personalProfile);
			await profileClient.set(businessProfile);

			expect(await profileClient.get()).toEqual(businessProfile);
			expect(await profileClient.getPublic()).toEqual({ accountType: 'business', displayName: 'Acme Corp' });
		}));
	});

	test('delete removes both objects', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			await profileClient.set(personalProfile);

			expect(await profileClient.delete()).toBe(true);
			expect(await profileClient.get()).toBeNull();
			expect(await profileClient.getPublic()).toBeNull();
		}));
	});

	test('delete returns false when no profile exists', function() {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			expect(await profileClient.delete()).toBe(false);
		}));
	});

	test.each(invalidProfiles)('set rejects invalid input: $name', function({ profile }) {
		return(withProfile(randomSeed(), async function({ profileClient }) {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			await expect(profileClient.set(profile as Profile)).rejects.toThrow();
		}));
	});
});
