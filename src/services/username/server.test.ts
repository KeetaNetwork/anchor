import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetUsernameAnchorHTTPServer } from './server.js';
import { USERNAME_MAX_LENGTH } from './common.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;

test('username server resolves account and nulls', async () => {
	const providerID = 'provider-abc';
	const knownAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);

	await using server = new KeetaNetUsernameAnchorHTTPServer({
		logger: logger,
		providerID,
		usernames: {
			async resolve({ username }) {
				if (username === 'alice') {
					return(knownAccount);
				}

				return(null);
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);
	const resolveURL = new URL('/api/resolve', baseURL);

	const response = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: 'alice' })
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, account: knownAccount.publicKeyString.get() });

	const unknownResponse = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: 'bob' })
	});

	expect(unknownResponse.status).toBe(200);

	expect(await unknownResponse.json()).toEqual({
		ok: true,
		account: null
	});
}, 10_000);

test('username server enforces usernamePattern when provided', async () => {
	const providerID = 'provider-pattern';
	await using server = new KeetaNetUsernameAnchorHTTPServer({
		providerID,
		usernamePattern: '^[a-z]+$',
		usernames: {
			async resolve({ username }) {
				if (username === 'valid') {
					return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
				}

				return(null);
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);
	const resolveURL = new URL('/api/resolve', baseURL);

	const invalidResponse = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: 'INVALID123' })
	});

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

	const validResponse = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: 'valid' })
	});

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
			async resolve() {
				return(null);
			}
		}
	});

	await server.start();

	const baseURL = new URL(server.url);
	const resolveURL = new URL('/api/resolve', baseURL);

	const invalidCharResponse = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: '漢' })
	});

	expect(invalidCharResponse.status).toBe(400);
	expect(await invalidCharResponse.json()).toMatchObject({
		ok: false,
		name: 'KeetaAnchorUserValidationError',
		data: {
			fields: [
				{
					path: 'username',
					expected: 'Latin-1 characters'
				}
			]
		}
	});

	const longUsername = 'a'.repeat(USERNAME_MAX_LENGTH + 1);
	const invalidLengthResponse = await fetch(resolveURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({ username: longUsername })
	});

	expect(invalidLengthResponse.status).toBe(400);
	expect(await invalidLengthResponse.json()).toMatchObject({
		ok: false,
		name: 'KeetaAnchorUserValidationError',
		data: {
			fields: [
				{
					path: 'username',
					valueRules: {
						maximum: String(USERNAME_MAX_LENGTH)
					}
				}
			]
		}
	});
}, 10_000);
