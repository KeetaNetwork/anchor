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
	const mappedAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const aliceUsername = formatGloballyIdentifiableUsername('alice', providerID);
	const claimantAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const assignedAccounts = new Map<string, GenericAccount>();
	assignedAccounts.set('alice', mappedAccount);

	await using server = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID,
		usernamePattern: '^[a-z]+$',
		usernames: {
			async resolve({ username }) {
				return(assignedAccounts.get(username) ?? null);
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

	await server.start();

	const metadata = Resolver.Metadata.formatMetadata({
		version: 1,
		currencyMap: {},
		services: {
			username: {
				[providerID]: await server.serviceMetadata()
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
	expect(provider?.isUsernameValid('alice')).toBe(true);
	expect(provider?.isUsernameValid('Alice')).toBe(false);
	expect(provider?.isUsernameValid('漢')).toBe(false);
	expect(provider?.isUsernameValid('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
	expect(provider?.isGloballyIdentifiableUsernameValid(aliceUsername)).toBe(true);
	expect(provider?.isGloballyIdentifiableUsernameValid(formatGloballyIdentifiableUsername('Alice', providerID))).toBe(false);
	expect(provider?.isGloballyIdentifiableUsernameValid(formatGloballyIdentifiableUsername('漢', providerID))).toBe(false);

	const resolvedAccount = await usernameClient.resolveAccount(aliceUsername);
	expect(resolvedAccount?.publicKeyString.get()).toBe(mappedAccount.publicKeyString.get());

	await expect(async () => {
		await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('Alice', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('漢', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('a'.repeat(USERNAME_MAX_LENGTH + 1), providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	const missingAccount = await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('bob', providerID));
	expect(missingAccount).toBeNull();

	expect(await usernameClient.claimUsername(formatGloballyIdentifiableUsername('bob', providerID))).toBe(true);

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('Invalid123', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('漢', providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	await expect(async () => {
		await usernameClient.claimUsername(formatGloballyIdentifiableUsername('a'.repeat(USERNAME_MAX_LENGTH + 1), providerID));
	}).rejects.toBeInstanceOf(KeetaAnchorUserValidationError);

	const resolvedAfterClaim = await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('bob', providerID));
	expect(resolvedAfterClaim?.publicKeyString.get()).toBe(claimantAccount.publicKeyString.get());

	await expect(async () => {
		await usernameClient.resolveAccount(formatGloballyIdentifiableUsername('carol', 'unknown-provider'));
	}).rejects.toThrow(/not found/);

	const error = await usernameClient.claimUsername(aliceUsername).catch((err: unknown) => err);
	if (!(error instanceof Errors.UsernameAlreadyTaken)) {
		expect(error).toBeInstanceOf(Errors.UsernameAlreadyTaken);
		throw(new Error('invalid error type'));
	}
	expect(error.username).toBe('alice');
}, 20_000);
