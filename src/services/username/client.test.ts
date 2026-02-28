import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import type { KeetaUsernameAnchorUsernameWithAccountAndProvider } from './client.js';
import KeetaUsernameAnchorClient from './client.js';
import { KeetaNetUsernameAnchorHTTPServer } from './server.js';
import type { KeetaUsernameAnchorUsernameWithAccount, KeetaUsernameAnchorSearchRequestParameters } from './common.js';
import { formatGloballyIdentifiableUsername, Errors, USERNAME_MAX_LENGTH } from './common.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import Resolver from '../../lib/resolver.js';
import { KeetaAnchorUserValidationError } from '../../lib/error.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;
type AccountInstance = InstanceType<typeof KeetaNet.lib.Account>;

function asNonNull<T>(value: T): NonNullable<T> {
	if (value === null || value === undefined) {
		throw(new Error('Value is null or undefined'));
	}

	return(value);
}

function compareResolveResult(result: { account: string | AccountInstance; username: string; }, expected: KeetaUsernameAnchorUsernameWithAccount) {
	return(result.username === expected.username && KeetaNet.lib.Account.toAccount(result.account).comparePublicKey(expected.account));
}

function sortSerializeUsernameResultArray(arr: KeetaUsernameAnchorUsernameWithAccountAndProvider[]) {
	const retval = [...arr]
		.sort(function(a, b) {
			return(a.username.localeCompare(b.username));
		})
		.map(function(item) {
			return({
				...item,
				account: KeetaNet.lib.Account.toPublicKeyString(item.account)
			})
		});

	return(retval);
}

test('username client resolves accounts through resolver', async () => {
	const providerAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(providerAccount);
	const client = nodeAndClient.userClient;

	const providerID = 'username-provider-1';
	const secondaryProviderID = 'username-provider-2';
	const mappedAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const secondaryMappedAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const aliceUsername = 'alice';
	const davidUsername = 'david';
	const transferUsernameKey = 'dave';
	const transferUsername = formatGloballyIdentifiableUsername(transferUsernameKey, providerID);
	const claimantAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const charlieAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const transferFromAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const transferRecipientAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const assignedAccounts = new Map<string, AccountInstance>();
	let transferClaimUsername: string | null = null;
	let transferClaimAccountMatched = false;
	let transferClaimFromUserMatched = false;
	let releaseInvocations = 0;
	let releaseMatchedAccount = false;
	const secondaryAssignedAccounts = new Map<string, AccountInstance>();
	secondaryAssignedAccounts.set('eve', secondaryMappedAccount);

	function sharedSearchHandler(request: KeetaUsernameAnchorSearchRequestParameters, accountsMap: Map<string, AccountInstance>) {
		const results: KeetaUsernameAnchorUsernameWithAccount[] = [];
		for (const [username, account] of accountsMap.entries()) {
			if (username.toLowerCase().includes(request.search.toLowerCase())) {
				results.push({ username, account });
			}
		}

		return({ results });
	}

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
			async claim({ username, account, fromUser }) {
				const existing = assignedAccounts.get(username);
				if (existing) {
					if (!fromUser || !existing.comparePublicKey(fromUser)) {
						return({ ok: false, taken: true });
					}
				}

				assignedAccounts.set(username, account);
				if (username === transferUsernameKey) {
					transferClaimUsername = username;
					transferClaimAccountMatched = account.comparePublicKey(transferRecipientAccount);
					transferClaimFromUserMatched = !!fromUser && fromUser.comparePublicKey(transferFromAccount);
				}
				return({ ok: true });
			},
			async releaseUsername({ account }) {
				releaseInvocations += 1;
				releaseMatchedAccount = account.comparePublicKey(charlieAccount);
				let removed = false;
				for (const [username, assignedAccount] of assignedAccounts.entries()) {
					if (assignedAccount.comparePublicKey(account)) {
						assignedAccounts.delete(username);
						removed = true;
					}
				}

				if (!removed) {
					return({ ok: false });
				}

				return({ ok: true });
			},
			async search(request) {
				return(sharedSearchHandler(request, assignedAccounts));
			}
		}
	});

	await using secondaryServer = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID: secondaryProviderID,
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
			},
			async search(request) {
				return(sharedSearchHandler(request, secondaryAssignedAccounts));
			}
		}
	});

	await primaryServer.start();
	await secondaryServer.start();

	await client.setInfo({
		description: 'Username Provider',
		name: 'USER',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				username: {
					[providerID]: await primaryServer.serviceMetadata(),
					[secondaryProviderID]: await secondaryServer.serviceMetadata()
				}
			}
		})
	});

	const usernameClient = new KeetaUsernameAnchorClient(client, {
		root: providerAccount,
		signer: claimantAccount,
		account: claimantAccount,
		logger: logger
	});

	const provider = asNonNull(await usernameClient.getProvider(providerID));
	const secondaryProvider = asNonNull(await usernameClient.getProvider(secondaryProviderID));

	for (const username of [aliceUsername, davidUsername, transferUsername]) {
		expect(await usernameClient.search({ search: username })).toEqual({ results: [] });

		for (const usingProvider of [provider, secondaryProvider]) {
			expect(await usingProvider.resolve(aliceUsername)).toBeNull();
			expect(await usingProvider.resolve(aliceUsername)).toBeNull();
		}
	}

	await provider.claimUsername(aliceUsername, { account: mappedAccount });
	await provider.claimUsername(transferUsernameKey, { account: transferFromAccount });

	const resolvedAccount = asNonNull(await usernameClient.resolve(formatGloballyIdentifiableUsername(aliceUsername, providerID)));
	expect(compareResolveResult(resolvedAccount, { account: mappedAccount, username: 'alice' })).toBe(true);

	const providerAccountResolution = asNonNull(await provider.resolve(mappedAccount));
	expect(compareResolveResult(providerAccountResolution, { account: mappedAccount, username: 'alice' })).toBe(true);

	const secondaryAccountResolution = asNonNull(await secondaryProvider.resolve(secondaryMappedAccount));
	expect(compareResolveResult(secondaryAccountResolution, { account: secondaryMappedAccount, username: 'eve' })).toBe(true);

	expect(provider.isUsernameValid('alice')).toBe(true);
	expect(secondaryProvider.isUsernameValid('alice')).toBe(true);

	for (const [username, shouldFailBoth] of [
		['Alice', false],
		['漢', true],
		['a'.repeat(USERNAME_MAX_LENGTH + 1), true]
	] as const) {
		for (const [usingProvider, isStrictProvider] of [[provider, true], [secondaryProvider, false]] as const) {
			const globallyIdentifiableUsername = formatGloballyIdentifiableUsername(username, String(usingProvider.providerID));
			const incorrectGloballyIdentifiableUsername = formatGloballyIdentifiableUsername(username, 'invalid');

			const isValid = usingProvider.isUsernameValid(username);

			let shouldPass;
			if (isStrictProvider) {
				shouldPass = false;
			} else {
				shouldPass = !shouldFailBoth;
			}
			expect(isValid).toBe(shouldPass);

			await expect(async () => {
				await usingProvider.claimUsername(incorrectGloballyIdentifiableUsername);
			}).rejects.toThrow();

			if (isValid) {
				expect(await usingProvider.resolve(username)).toEqual(null);
				expect(await usingProvider.search({ search: username })).toEqual({ results: [] });
			} else {
				await expect(async () => {
					await usingProvider.resolve(globallyIdentifiableUsername);
				}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

				await expect(async () => {
					await usingProvider.search({ search: username });
				}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

				await expect(async () => {
					await usingProvider.claimUsername(globallyIdentifiableUsername);
				}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);
			}
		}
	}

	const globalSearchAlice = asNonNull(await usernameClient.resolveMulti('alice'));
	const globalSearchAliceResult = asNonNull(globalSearchAlice[provider.providerID]);
	expect(globalSearchAliceResult.account.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());
	expect(globalSearchAliceResult.username).toBe('alice');

	const globalSearchAliceIdentifier = await usernameClient.resolveMulti(aliceUsername);
	expect(globalSearchAliceIdentifier).not.toBeNull();
	if (!globalSearchAliceIdentifier) {
		throw(new Error('expected global search to find alice by identifier'));
	}
	const globalSearchAliceIdentifierResult = asNonNull(globalSearchAliceIdentifier[provider.providerID]);
	expect(compareResolveResult(globalSearchAliceIdentifierResult, { account: mappedAccount, username: aliceUsername })).toBe(true);

	const accountSearchExisting = asNonNull(await usernameClient.resolveMulti(secondaryMappedAccount));
	const accountSearchExistingResult = asNonNull(accountSearchExisting[secondaryProvider.providerID]);
	expect(compareResolveResult(accountSearchExistingResult, { account: secondaryMappedAccount, username: 'eve' })).toBe(true);

	const randomAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	expect(await usernameClient.resolveMulti('unknown-user')).toBeNull();
	expect(await usernameClient.resolveMulti(randomAccount)).toBeNull();
	expect(await usernameClient.resolveMulti(claimantAccount)).toBeNull();
	expect(await usernameClient.resolveMulti('alice', { providerIDs: ['invalid-provider'] })).toBeNull();

	expect(await usernameClient.resolve(formatGloballyIdentifiableUsername(davidUsername, providerID))).toBeNull();
	expect(await usernameClient.resolveMulti(davidUsername)).toBeNull();

	expect(await usernameClient.claimUsername(formatGloballyIdentifiableUsername(davidUsername, providerID))).toBe(true);

	const transferSignedField = await usernameClient.signUsernameTransfer({
		username: transferUsernameKey,
		to: transferRecipientAccount
	}, transferFromAccount);

	expect(await usernameClient.claimUsername(transferUsername, {
		account: transferRecipientAccount,
		transfer: {
			from: transferFromAccount,
			signed: transferSignedField
		}
	})).toBe(true);

	expect(transferClaimUsername).toBe(transferUsernameKey);
	expect(transferClaimAccountMatched).toBe(true);
	expect(transferClaimFromUserMatched).toBe(true);

	const transferResolution = asNonNull(await usernameClient.resolve(transferUsername));
	expect(compareResolveResult(transferResolution, { account: transferRecipientAccount, username: transferUsernameKey })).toBe(true);

	const transferSearch = asNonNull(await usernameClient.resolveMulti(transferRecipientAccount));
	const transferSearchResult = asNonNull(transferSearch[provider.providerID]);
	expect(compareResolveResult(transferSearchResult, { account: transferRecipientAccount, username: transferUsernameKey })).toBe(true);

	const charlieUsername = formatGloballyIdentifiableUsername('charlie', providerID);
	expect(await usernameClient.claimUsername(charlieUsername, { account: charlieAccount })).toBe(true);

	const charlieResolution = asNonNull(await usernameClient.resolve(charlieUsername));
	expect(compareResolveResult(charlieResolution, { account: charlieAccount, username: 'charlie' })).toBe(true);

	const searchAfterCharlieClaim = asNonNull(await usernameClient.resolveMulti(charlieUsername));
	const searchAfterCharlieClaimResult = asNonNull(searchAfterCharlieClaim[provider.providerID]);
	expect(compareResolveResult(searchAfterCharlieClaimResult, { account: charlieAccount, username: 'charlie' })).toBe(true);

	expect(await provider.releaseUsername({ account: charlieAccount })).toBe(true);
	expect(releaseInvocations).toBe(1);
	expect(releaseMatchedAccount).toBe(true);

	expect(await usernameClient.resolve(charlieUsername)).toBeNull();
	expect(await usernameClient.resolveMulti(charlieUsername)).toBeNull();
	expect(await usernameClient.resolveMulti(charlieAccount)).toBeNull();
	expect(assignedAccounts.has('charlie')).toBe(false);

	const resolvedAfterClaim = asNonNull(await usernameClient.resolve(formatGloballyIdentifiableUsername(davidUsername, providerID)));
	expect(compareResolveResult(resolvedAfterClaim, { account: claimantAccount, username: davidUsername })).toBe(true);

	const searchAfterClaim = asNonNull(await usernameClient.resolveMulti(davidUsername));
	const searchAfterClaimResult = asNonNull(searchAfterClaim[provider.providerID]);
	expect(compareResolveResult(searchAfterClaimResult, { account: claimantAccount, username: davidUsername })).toBe(true);

	const accountSearchAfterClaim = asNonNull(await usernameClient.resolveMulti(claimantAccount));
	const accountSearchAfterClaimResult = asNonNull(accountSearchAfterClaim[provider.providerID]);
	expect(compareResolveResult(accountSearchAfterClaimResult, { account: claimantAccount, username: davidUsername })).toBe(true);

	await expect(async () => {
		await usernameClient.resolve(formatGloballyIdentifiableUsername('carol', 'unknown-provider'));
	}).rejects.toThrow(/not found/);

	const error = await usernameClient.claimUsername(formatGloballyIdentifiableUsername(aliceUsername, providerID)).catch((err: unknown) => err);
	if (!(error instanceof Errors.UsernameAlreadyTaken)) {
		expect(error).toBeInstanceOf(Errors.UsernameAlreadyTaken);
		throw(new Error('invalid error type'));
	}
	expect(error.username).toBe('alice');

	{
		// Search tests

		const tests: { search: string; resultsByProvider: [ string[], string[] ] }[] = [
			{ search: 'ryan', resultsByProvider: [ [], [] ] },
			{ search: 'al', resultsByProvider: [ [ aliceUsername ], [] ] },
			{ search: 'e', resultsByProvider: [ [ 'dave', aliceUsername ], ['eve'] ] },
			{ search: 'da', resultsByProvider: [ [ 'dave', 'david' ], [] ] }
		];

		for (const { search, resultsByProvider } of tests) {
			const provider0Results: KeetaUsernameAnchorUsernameWithAccountAndProvider[] = resultsByProvider[0].map(function(username) {
				return({
					username,
					providerID: provider.providerID,
					account: asNonNull(assignedAccounts.get(username)),
					globallyIdentifiableUsername: formatGloballyIdentifiableUsername(username, String(provider.providerID))
				});
			})

			const provider1Results: KeetaUsernameAnchorUsernameWithAccountAndProvider[] = resultsByProvider[1].map(function(username) {
				return({
					username,
					providerID: secondaryProvider.providerID,
					account: asNonNull(secondaryAssignedAccounts.get(username)),
					globallyIdentifiableUsername: formatGloballyIdentifiableUsername(username, String(secondaryProvider.providerID))
				});
			});

			// Joined search
			const joinedGlobalSearch = asNonNull(await usernameClient.search({ search }, 'joined'));

			// Ensure joined is the default return type
			expect(await usernameClient.search({ search })).toEqual(joinedGlobalSearch);

			expect(sortSerializeUsernameResultArray(joinedGlobalSearch.results)).toEqual(sortSerializeUsernameResultArray([ ...provider0Results, ...provider1Results ]));

			// separate search
			const searchWithSeparateField = asNonNull(await usernameClient.search({ search }, 'separate'));
			for (const [ usingProvider, expectedResults ] of [[ provider, provider0Results ], [ secondaryProvider, provider1Results ]] as const) {
				const rootClientResult = asNonNull(await usernameClient.search({ search }, 'joined', { providerIDs: [ String(usingProvider.providerID) ] }));
				const rootClientSerialized = sortSerializeUsernameResultArray(rootClientResult.results);

				expect(rootClientSerialized).toEqual(sortSerializeUsernameResultArray(expectedResults));

				expect(sortSerializeUsernameResultArray(asNonNull(await usingProvider.search({ search })).results)).toEqual(rootClientSerialized);

				const providerResult = sortSerializeUsernameResultArray(asNonNull(searchWithSeparateField[usingProvider.providerID]).results);
				expect(providerResult).toEqual(rootClientSerialized);

			}
		}
	}
}, 20_000);
