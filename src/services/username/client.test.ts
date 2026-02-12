import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import KeetaUsernameAnchorClient from './client.js';
import { KeetaNetUsernameAnchorHTTPServer } from './server.js';
import { formatGloballyIdentifiableUsername, Errors, USERNAME_MAX_LENGTH } from './common.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';
import { KeetaAnchorUserValidationError } from '../../lib/error.js';
import type { GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('username client resolves accounts through resolver', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'username-provider-1';
	const secondaryProviderID = 'username-provider-2';
	const mappedAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const secondaryMappedAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const aliceUsername = formatGloballyIdentifiableUsername('alice', providerID);
	const bobUsername = formatGloballyIdentifiableUsername('bob', providerID);
	const claimantAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const assignedAccounts = new Map<string, GenericAccount>();
	assignedAccounts.set('alice', mappedAccount);
	const secondaryAssignedAccounts = new Map<string, GenericAccount>();
	secondaryAssignedAccounts.set('eve', secondaryMappedAccount);

	await using primaryServer = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID,
		usernamePattern: '^[a-z]+$',
		usernames: {
			async resolveUsername({ username }) {
				const account = assignedAccounts.get(username);
				if (account) {
					return({ account });
				}

				return(null);
			},
			async resolveAccount({ account }) {
				for (const [username, assignedAccount] of assignedAccounts.entries()) {
					if (assignedAccount.comparePublicKey(account)) {
						return({ username });
					}
				}

				return(null);
			},
			async claim({ username, account }) {
				if (assignedAccounts.has(username)) {
					return({ ok: false, taken: true });
				}
				assignedAccounts.set(username, account);
				return({ ok: true });
			}
		}
	});

	await using secondaryServer = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID: secondaryProviderID,
		usernamePattern: '^[a-z]+$',
		usernames: {
			async resolveUsername({ username }) {
				const account = secondaryAssignedAccounts.get(username);
				if (account) {
					return({ account });
				}

				return(null);
			},
			async resolveAccount({ account }) {
				for (const [username, assignedAccount] of secondaryAssignedAccounts.entries()) {
					if (assignedAccount.comparePublicKey(account)) {
						return({ username });
					}
				}

				return(null);
			}
		}
	});

	await primaryServer.start();
	await secondaryServer.start();

	const metadata = Resolver.Metadata.formatMetadata({
		version: 1,
		currencyMap: {},
		services: {
			username: {
				[providerID]: await primaryServer.serviceMetadata(),
				[secondaryProviderID]: await secondaryServer.serviceMetadata()
			}
		}
	});

	await client.setInfo({
		description: 'Username Provider',
		name: 'USER',
		metadata
	});

	const usernameClient = new KeetaUsernameAnchorClient(client, {
		root: providerAccount,
		signer: claimantAccount,
		account: claimantAccount,
		logger: logger
	});

	const provider = await usernameClient.getProvider(providerID);
	expect(provider).not.toBeNull();
	if (!provider) {
		throw(new Error('primary provider not found'));
	}
	const secondaryProvider = await usernameClient.getProvider(secondaryProviderID);
	expect(secondaryProvider).not.toBeNull();
	if (!secondaryProvider) {
		throw(new Error('secondary provider not found'));
	}

	expect(provider.isUsernameValid('alice')).toBe(true);
	expect(provider.isUsernameValid('Alice')).toBe(false);
	expect(provider.isUsernameValid('漢')).toBe(false);
	expect(provider.isUsernameValid('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);

	expect(secondaryProvider.isUsernameValid('eve')).toBe(true);

	const resolvedAccount = await usernameClient.resolve(aliceUsername);
	expect(resolvedAccount).not.toBeNull();
	if (!resolvedAccount) {
		throw(new Error('expected alice to resolve'));
	}
	expect(resolvedAccount.account.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());
	expect(resolvedAccount.username).toBe('alice');

	const providerAccountResolution = await provider.resolve(mappedAccount);
	expect(providerAccountResolution).not.toBeNull();
	if (!providerAccountResolution) {
		throw(new Error('expected account resolution for alice'));
	}
	expect(providerAccountResolution.account.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());
	expect(providerAccountResolution.username).toBe('alice');

	const secondaryAccountResolution = await secondaryProvider.resolve(secondaryMappedAccount);
	expect(secondaryAccountResolution).not.toBeNull();
	if (!secondaryAccountResolution) {
		throw(new Error('expected account resolution for eve'));
	}
	expect(secondaryAccountResolution.account.publicKeyString.get()).toBe(secondaryMappedAccount.publicKeyString.get());
	expect(secondaryAccountResolution.username).toBe('eve');

	await expect(async () => {
		await usernameClient.resolve(formatGloballyIdentifiableUsername('Alice', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.resolve(formatGloballyIdentifiableUsername('漢', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.resolve(formatGloballyIdentifiableUsername('a'.repeat(USERNAME_MAX_LENGTH + 1), providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	const globalSearchAlice = await usernameClient.search('alice');
	expect(globalSearchAlice).not.toBeNull();
	if (!globalSearchAlice) {
		throw(new Error('expected global search to find alice'));
	}
	const globalSearchAliceResult = globalSearchAlice[provider.providerID];
	expect(globalSearchAliceResult).toBeDefined();
	if (!globalSearchAliceResult) {
		throw(new Error('expected provider result for alice'));
	}
	expect(globalSearchAliceResult.account.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());
	expect(globalSearchAliceResult.username).toBe('alice');

	const globalSearchAliceIdentifier = await usernameClient.search(aliceUsername);
	expect(globalSearchAliceIdentifier).not.toBeNull();
	if (!globalSearchAliceIdentifier) {
		throw(new Error('expected global search to find alice by identifier'));
	}
	const globalSearchAliceIdentifierResult = globalSearchAliceIdentifier[provider.providerID];
	expect(globalSearchAliceIdentifierResult).toBeDefined();
	if (!globalSearchAliceIdentifierResult) {
		throw(new Error('expected provider result for alice identifier'));
	}
	expect(globalSearchAliceIdentifierResult.account.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());
	expect(globalSearchAliceIdentifierResult.username).toBe('alice');

	const accountSearchExisting = await usernameClient.search(secondaryMappedAccount);
	expect(accountSearchExisting).not.toBeNull();
	if (!accountSearchExisting) {
		throw(new Error('expected account search to find eve'));
	}
	const accountSearchExistingResult = accountSearchExisting[secondaryProvider.providerID];
	expect(accountSearchExistingResult).toBeDefined();
	if (!accountSearchExistingResult) {
		throw(new Error('expected secondary provider result for eve account'));
	}
	expect(accountSearchExistingResult.account.publicKeyString.get()).toBe(secondaryMappedAccount.publicKeyString.get());
	expect(accountSearchExistingResult.username).toBe('eve');

	const randomAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	expect(await usernameClient.search('unknown-user')).toBeNull();
	expect(await usernameClient.search(randomAccount)).toBeNull();
	expect(await usernameClient.search(claimantAccount)).toBeNull();
	expect(await usernameClient.search('alice', { providerIDs: ['invalid-provider'] })).toBeNull();

	const missingAccount = await usernameClient.resolve(bobUsername);
	expect(missingAccount).toBeNull();
	expect(await usernameClient.search('bob')).toBeNull();

	expect(await usernameClient.claimUsername(bobUsername)).toBe(true);

	const charlieUsername = formatGloballyIdentifiableUsername('charlie', providerID);
	expect(await usernameClient.claimUsername(charlieUsername)).toBe(true);

	const charlieResolution = await usernameClient.resolve(charlieUsername);
	expect(charlieResolution).not.toBeNull();
	if (!charlieResolution) {
		throw(new Error('expected charlie to resolve after claim'));
	}
	expect(charlieResolution.account.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());
	expect(charlieResolution.username).toBe('charlie');

	const searchAfterCharlieClaim = await usernameClient.search(charlieUsername);
	expect(searchAfterCharlieClaim).not.toBeNull();
	if (!searchAfterCharlieClaim) {
		throw(new Error('expected search to find charlie after claim'));
	}
	const searchAfterCharlieClaimResult = searchAfterCharlieClaim[provider.providerID];
	expect(searchAfterCharlieClaimResult).toBeDefined();
	if (!searchAfterCharlieClaimResult) {
		throw(new Error('expected provider result for charlie after claim'));
	}
	expect(searchAfterCharlieClaimResult.account.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());
	expect(searchAfterCharlieClaimResult.username).toBe('charlie');

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('Invalid123', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('漢', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('a'.repeat(USERNAME_MAX_LENGTH + 1), providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	const resolvedAfterClaim = await usernameClient.resolve(bobUsername);
	expect(resolvedAfterClaim).not.toBeNull();
	if (!resolvedAfterClaim) {
		throw(new Error('expected bob to resolve after claim'));
	}
	expect(resolvedAfterClaim.account.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());
	expect(resolvedAfterClaim.username).toBe('bob');

	const searchAfterClaim = await usernameClient.search('bob');
	expect(searchAfterClaim).not.toBeNull();
	if (!searchAfterClaim) {
		throw(new Error('expected search to find bob after claim'));
	}
	const searchAfterClaimResult = searchAfterClaim[provider.providerID];
	expect(searchAfterClaimResult).toBeDefined();
	if (!searchAfterClaimResult) {
		throw(new Error('expected provider result for bob after claim'));
	}
	expect(searchAfterClaimResult.account.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());
	expect(searchAfterClaimResult.username).toBe('bob');

	const accountSearchAfterClaim = await usernameClient.search(claimantAccount);
	expect(accountSearchAfterClaim).not.toBeNull();
	if (!accountSearchAfterClaim) {
		throw(new Error('expected account search to find bob after claim'));
	}
	const accountSearchAfterClaimResult = accountSearchAfterClaim[provider.providerID];
	expect(accountSearchAfterClaimResult).toBeDefined();
	if (!accountSearchAfterClaimResult) {
		throw(new Error('expected provider result when searching by claimed account'));
	}
	expect(accountSearchAfterClaimResult.account.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());
	expect(accountSearchAfterClaimResult.username).toBe('bob');

	await expect(async () => {
		await usernameClient.resolve(formatGloballyIdentifiableUsername('carol', 'unknown-provider'));
	}).rejects.toThrow(/not found/);

	const error = await usernameClient.claimUsername(aliceUsername).catch((err: unknown) => err);
	if (!(error instanceof Errors.UsernameAlreadyTaken)) {
		expect(error).toBeInstanceOf(Errors.UsernameAlreadyTaken);
		throw(new Error('invalid error type'));
	}
	expect(error.username).toBe('alice');
}, 20_000);
