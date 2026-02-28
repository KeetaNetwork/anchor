import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetUsernameAnchorHTTPServer } from './server.js';
import { USERNAME_MAX_LENGTH, getUsernameClaimSignable, getUsernameReleaseSignable, getUsernameTransferSignable } from './common.js';
import { SignData } from '../../lib/utils/signing.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('username server resolves account and nulls', async () => {
	const providerID = 'provider-abc';
	const knownAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	await using server = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID,
		usernames: {
			async resolveUsername({ username }) {
				if (username === 'alice') {
					return({ account: knownAccount });
				}

				return(null);
			},
			async resolveAccount({ account }) {
				if (account.comparePublicKey(knownAccount)) {
					return({ username: 'alice' });
				}

				return(null);
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);

	const response = await fetch(new URL('/api/resolve/alice', baseURL));

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, account: knownAccount.publicKeyString.get(), username: 'alice' });

	const accountResolutionResponse = await fetch(new URL(`/api/resolve/${encodeURIComponent(knownAccount.publicKeyString.get())}`, baseURL));

	expect(accountResolutionResponse.status).toBe(200);
	expect(await accountResolutionResponse.json()).toEqual({ ok: true, account: knownAccount.publicKeyString.get(), username: 'alice' });

	const unknownResponse = await fetch(new URL('/api/resolve/bob', baseURL));

	expect(unknownResponse.status).toBe(404);

	const unknownAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const unknownAccountResponse = await fetch(new URL(`/api/resolve/${encodeURIComponent(unknownAccount.publicKeyString.get())}`, baseURL));

	expect(unknownAccountResponse.status).toBe(404);
}, 10_000);

test('username server enforces usernamePattern when provided', async () => {
	const providerID = 'provider-pattern';
	await using server = new KeetaNetUsernameAnchorHTTPServer({
		providerID,
		usernamePattern: '^[a-z]+$',
		usernames: {
			async resolveUsername({ username }) {
				if (username === 'valid') {
					return({
						account: KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0)
					});
				}

				return(null);
			},
			async resolveAccount() {
				return(null);
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);

	const invalidResponse = await fetch(new URL('/api/resolve/INVALID123', baseURL));

	expect(invalidResponse.status).toBe(400);
	expect(await invalidResponse.json()).toMatchObject({
		ok: false,
		name: 'KeetaAnchorUserValidationError',
		data: {
			fields: [
				{ path: 'username' }
			]
		}
	});

	const validResponse = await fetch(new URL('/api/resolve/valid', baseURL));

	expect(validResponse.status).toBe(200);
	expect(await validResponse.json()).toMatchObject({ ok: true });

	const metadata = await server.serviceMetadata();
	expect(metadata.usernamePattern).toBe('^[a-z]+$');
}, 10_000);

test('username server enforces default validation rules', async () => {
	const providerID = 'provider-default-validation';
	await using server = new KeetaNetUsernameAnchorHTTPServer({
		providerID,
		usernames: {
			async resolveAccount() { return(null); },
			async resolveUsername() { return(null); }
		}
	});

	await server.start();

	const baseURL = new URL(server.url);

	const invalidCharResponse = await fetch(new URL('/api/resolve/漢', baseURL));

	expect(invalidCharResponse.status).toBe(400);
	expect(await invalidCharResponse.json()).toMatchObject({
		ok: false,
		name: 'KeetaAnchorUserValidationError',
		data: {
			fields: [
				{ path: 'username' }
			]
		}
	});

	const longUsername = 'a'.repeat(USERNAME_MAX_LENGTH + 1);
	const invalidLengthResponse = await fetch(new URL(`/api/resolve/${longUsername}`, baseURL));

	expect(invalidLengthResponse.status).toBe(400);
	expect(await invalidLengthResponse.json()).toMatchObject({
		ok: false,
		name: 'KeetaAnchorUserValidationError',
		data: {
			fields: [
				{ path: 'username' }
			]
		}
	});
}, 10_000);

test('username server validates signed transfers and release requests', async () => {
	const providerID = 'provider-signatures';
	const transferFromAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const transferToAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	let claimCalls = 0;
	let transferClaimUsername: string | null = null;
	let transferClaimAccountMatched = false;
	let transferClaimFromUserMatched = false;
	let releaseCalls = 0;
	let releaseMatchedAccount = false;

	await using server = new KeetaNetUsernameAnchorHTTPServer({
		providerID,
		usernames: {
			async resolveUsername() {
				return(null);
			},
			async resolveAccount() {
				return(null);
			},
			async claim(context) {
				claimCalls += 1;
				transferClaimUsername = context.username;
				transferClaimAccountMatched = context.account.comparePublicKey(transferToAccount);
				transferClaimFromUserMatched = !!context.fromUser && context.fromUser.comparePublicKey(transferFromAccount);
				return({ ok: true });
			},
			async releaseUsername({ account }) {
				releaseCalls += 1;
				releaseMatchedAccount = account.comparePublicKey(transferToAccount);
				return({ ok: true });
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);
	const username = 'transfer';

	const transferSigned = await SignData(transferFromAccount.assertAccount(), getUsernameTransferSignable({
		username,
		from: transferFromAccount,
		to: transferToAccount
	}));

	const claimPayload = {
		username,
		account: transferToAccount,
		transfer: {
			from: transferFromAccount,
			signed: transferSigned
		}
	};

	const claimSigned = await SignData(transferToAccount.assertAccount(), getUsernameClaimSignable(claimPayload));

	const claimResponse = await fetch(new URL('/api/claim', baseURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			username,
			account: transferToAccount.publicKeyString.get(),
			transfer: {
				from: transferFromAccount.publicKeyString.get(),
				signed: transferSigned
			},
			signed: claimSigned
		})
	});

	expect(claimResponse.status).toBe(200);
	expect(await claimResponse.json()).toEqual({ ok: true });
	expect(claimCalls).toBe(1);
	expect(transferClaimUsername).toBe(username);
	expect(transferClaimAccountMatched).toBe(true);
	expect(transferClaimFromUserMatched).toBe(true);

	const invalidClaimResponse = await fetch(new URL('/api/claim', baseURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			username,
			account: transferToAccount.publicKeyString.get(),
			transfer: {
				from: transferFromAccount.publicKeyString.get(),
				signed: transferSigned
			},
			signed: {
				...claimSigned,
				signature: 'invalid-signature'
			}
		})
	});

	expect(invalidClaimResponse.status).toBeGreaterThanOrEqual(400);
	expect(invalidClaimResponse.status).toBeLessThan(600);
	expect(claimCalls).toBe(1);

	const releaseSigned = await SignData(transferToAccount.assertAccount(), getUsernameReleaseSignable({ account: transferToAccount }));

	const releaseResponse = await fetch(new URL('/api/release', baseURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			account: transferToAccount.publicKeyString.get(),
			signed: releaseSigned
		})
	});

	expect(releaseResponse.status).toBe(200);
	expect(await releaseResponse.json()).toEqual({ ok: true });
	expect(releaseCalls).toBe(1);
	expect(releaseMatchedAccount).toBe(true);

	const invalidReleaseResponse = await fetch(new URL('/api/release', baseURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			account: transferToAccount.publicKeyString.get(),
			signed: {
				...releaseSigned,
				signature: 'invalid-signature'
			}
		})
	});

	expect(invalidReleaseResponse.status).toBeGreaterThanOrEqual(400);
	expect(invalidReleaseResponse.status).toBeLessThan(600);
	expect(releaseCalls).toBe(1);
}, 10_000);
