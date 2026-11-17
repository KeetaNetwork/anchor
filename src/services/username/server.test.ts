import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetUsernameAnchorHTTPServer } from './server.js';
import { USERNAME_MAX_LENGTH, getUsernameClaimSignable, getUsernameReleaseSignable, getUsernameTransferSignable } from './common.js';
import { signRequest } from '../../lib/http-server/request-signing.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('username server resolves account and nulls', async () => {
	const knownAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	await using server = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
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
	await using server = new KeetaNetUsernameAnchorHTTPServer({
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
	await using server = new KeetaNetUsernameAnchorHTTPServer({
		usernames: {
			async resolveAccount() { return(null); },
			async resolveUsername() { return(null); }
		}
	});

	await server.start();

	const baseURL = new URL(server.url);

	const invalidCharResponse = await fetch(new URL('/api/resolve/\u6f22', baseURL));

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

test('username server accepts a transfer authorization and a release once, and only at the provider they were made for', async () => {
	const transferFromAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const transferToAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	let claimCalls = 0;
	let transferClaimUsername: string | null = null;
	let transferClaimAccountMatched = false;
	let transferClaimFromUserMatched = false;
	let releaseCalls = 0;
	let releaseMatchedAccount = false;

	await using server = new KeetaNetUsernameAnchorHTTPServer({
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

	const claimURL = new URL('/api/claim', baseURL);
	const transferSignable = getUsernameTransferSignable({
		username,
		from: transferFromAccount,
		to: transferToAccount
	});
	const transferSigned = await signRequest(transferFromAccount.assertAccount(), { method: 'POST', url: claimURL }, transferSignable);

	const claimPayload = {
		username,
		account: transferToAccount,
		transfer: {
			from: transferFromAccount,
			signed: transferSigned
		}
	};

	async function postClaim(transferSignedField: typeof transferSigned, tamper = false) {
		const body = {
			username,
			account: transferToAccount.publicKeyString.get(),
			transfer: {
				from: transferFromAccount.publicKeyString.get(),
				signed: transferSignedField
			}
		};
		const signed = await signRequest(transferToAccount.assertAccount(), { method: 'POST', url: claimURL, body }, getUsernameClaimSignable({ ...claimPayload, transfer: { ...claimPayload.transfer, signed: transferSignedField }}));

		return(await fetch(claimURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({ ...body, signed: tamper ? { ...signed, signature: 'invalid-signature' } : signed })
		}));
	}

	/*
	 * A transfer authorization made for another provider is refused here
	 */
	const otherProviderTransfer = await signRequest(transferFromAccount.assertAccount(), { method: 'POST', url: new URL('https://usernames.example.com/api/claim') }, transferSignable);
	const otherProviderResponse = await postClaim(otherProviderTransfer);
	expect(otherProviderResponse.status).toBeGreaterThanOrEqual(400);
	expect(claimCalls).toBe(0);

	const claimResponse = await postClaim(transferSigned);

	expect(claimResponse.status).toBe(200);
	expect(await claimResponse.json()).toEqual({ ok: true });
	expect(claimCalls).toBe(1);
	expect(transferClaimUsername).toBe(username);
	expect(transferClaimAccountMatched).toBe(true);
	expect(transferClaimFromUserMatched).toBe(true);

	/*
	 * The transfer authorization is spent, even inside a freshly signed claim
	 */
	const reusedTransferResponse = await postClaim(transferSigned);
	expect(reusedTransferResponse.status).toBeGreaterThanOrEqual(400);
	expect(claimCalls).toBe(1);

	const invalidClaimResponse = await postClaim(await signRequest(transferFromAccount.assertAccount(), { method: 'POST', url: claimURL }, transferSignable), true);
	expect(invalidClaimResponse.status).toBeGreaterThanOrEqual(400);
	expect(invalidClaimResponse.status).toBeLessThan(600);
	expect(claimCalls).toBe(1);

	const releaseURL = new URL('/api/release', baseURL);
	const releaseBody = { account: transferToAccount.publicKeyString.get() };
	const releaseSigned = await signRequest(transferToAccount.assertAccount(), { method: 'POST', url: releaseURL, body: releaseBody }, getUsernameReleaseSignable({ account: transferToAccount }));

	const releaseResponse = await fetch(releaseURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ ...releaseBody, signed: releaseSigned })
	});

	expect(releaseResponse.status).toBe(200);
	expect(await releaseResponse.json()).toEqual({ ok: true });
	expect(releaseCalls).toBe(1);
	expect(releaseMatchedAccount).toBe(true);

	/*
	 * Replaying the captured release is refused
	 */
	const replayedReleaseResponse = await fetch(releaseURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ ...releaseBody, signed: releaseSigned })
	});
	expect(replayedReleaseResponse.status).toBeGreaterThanOrEqual(400);
	expect(releaseCalls).toBe(1);

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

test('username server metadata exposes unencoded resolve URI template', async () => {
	await using server = new KeetaNetUsernameAnchorHTTPServer({
		url: 'https://usernames.example.com',
		usernames: {
			async resolveUsername() {
				return(null);
			},
			async resolveAccount() {
				return(null);
			}
		}
	});

	await server.start();

	const metadata = await server.serviceMetadata();
	expect(metadata.operations.resolve).toContain('{toResolve}');
}, 10_000);
