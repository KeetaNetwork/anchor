import { expect, test } from 'vitest';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import type { KeetaFXAnchorQuoteJSON } from './common.js';

test('FX Server Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const storage = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE, undefined, 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	for (const fxAccount of [account, storage]) {
		await using server = new KeetaNetFXAnchorHTTPServer({
			account: fxAccount,
			signer: account,
			client: client,
			quoteSigner: account,
			fx: {
				from: [{
					currencyCodes: [token1.publicKeyString.get()],
					to: [token2.publicKeyString.get()]
				}],
				getConversionRateAndFee: async function() {
					return({
						account: fxAccount,
						convertedAmount: 1000n,
						cost: {
							amount: 0n,
							token: KeetaNet.lib.Account.fromTokenPublicKey(KeetaNet.lib.Account.generateRandomSeed())
						}
					});
				}
			}
		});

		await server.start();
		const url = server.url;

		const serviceMetadata = await server.serviceMetadata();
		expect(serviceMetadata).toEqual({
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			operations: {
				getEstimate: `${url}/api/getEstimate`,
				getQuote: `${url}/api/getQuote`,
				createExchange: `${url}/api/createExchange`,
				getExchangeStatus: `${url}/api/getExchangeStatus/{id}`
			}
		});

		const testData = [
			null,
			undefined,
			{},
			{ request: null },
			{ request: undefined },
			{ request: {}},
			{ request: { quote: null }},
			{ request: { quote: {}}},
			{ request: { quote: {}, block: null }},
			{ request: { quote: {}, block: undefined }},
			{ request: { quote: {}, block: 123 }},
			{ request: { quote: {}, block: '' }}
		]

		const postRoutes = [
			{ test: '/api/getEstimate', error: 500 },
			{ test: '/api/getQuote', error: 500 },
			{ test: '/api/createExchange', error: 500 },
			{ test: '/api/missing', error: 404 },
			{ test: '/api/getEstimate', error: 500, skipJSON: true },
			{ test: '/api/getEstimate', error: 400, contentType: 'text/plain' }
		]

		for (const route of postRoutes) {
			for (const data of testData) {
				const serverURL = `${url}${route.test}`;
				const results = await fetch(serverURL, {
					method: 'POST',
					headers: {
						'Content-Type': route.contentType ?? 'application/json',
						'Accept': 'application/json'
					},
					body: route.skipJSON ? '123' : JSON.stringify({
						request: data
					})
				});
				expect(results.status).toBe(route.error);
			}
		}


		const getParams = [
			{ test: '', error: 404 },
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			{ test: `/${{}}`, error: 500 }
			// { test: '123', error: 500 } // TODO node client takes too long to timeout retries
		]
		for (const param of getParams) {
			const serverURL = `${url}/api/getExchangeStatus${param.test}`;
			const result = await fetch(serverURL, {
				method: 'GET',
				headers: {
					'Accept': 'application/json'
				}
			});
			expect(result.status).toBe(param.error);
		}

		{
			/*
			* Verify that CORS headers are set correctly
			*/
			const corsTestURL = `${url}/api/getEstimate`;

			const checks = [
				{
					request: {
						from: 'keeta_amx',
						to: 'keeta_anx',
						amount: '1.00',
						affinity: 'to'
					},
					responseStatus: 200
				}, {
					request: {},
					responseStatus: 500
				}
			];
			for (const check of checks) {
				const result_POST = await fetch(corsTestURL, {
					method: 'POST',
					headers: {
						'Origin': 'http://example.com',
						'Content-Type': 'application/json',
						'Accept': 'application/json'
					},
					body: JSON.stringify({
						request: check.request
					})
				});

				expect(result_POST.status).toBe(check.responseStatus);
				expect(result_POST.headers.get('Access-Control-Allow-Origin')).toBe('*');
			}

			const result_OPTIONS = await fetch(corsTestURL, {
				method: 'OPTIONS',
				headers: {
					'Origin': 'http://example.com',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'Content-Type'
				}
			});

			expect(result_OPTIONS.status).toBe(204);
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Methods')?.split(',').map(function(part) {
				return(part.trim());
			}).sort().join(',')).toBe('OPTIONS,POST');
			expect(result_OPTIONS.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
			expect(Number(result_OPTIONS.headers.get('Access-Control-Max-Age'))).toBeGreaterThan(30);
		}
	}
});

test('FX Server Quote Validation Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	let validateQuoteCalled = false;
	let shouldAcceptQuote = true;

	await using server = new KeetaNetFXAnchorHTTPServer({
		account: account,
		client: client,
		quoteSigner: account,
		fx: {
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			getConversionRateAndFee: async function() {
				return({
					account: account,
					convertedAmount: 1000n,
					cost: {
						amount: 0n,
						token: token1
					}
				});
			},
			validateQuote: async function(quote: KeetaFXAnchorQuoteJSON) {
				validateQuoteCalled = true;
				/* Verify that the quote has the expected structure */
				expect(quote).toHaveProperty('request');
				expect(quote).toHaveProperty('account');
				expect(quote).toHaveProperty('convertedAmount');
				expect(quote).toHaveProperty('cost');
				expect(quote).toHaveProperty('signed');
				return(shouldAcceptQuote);
			}
		}
	});

	await server.start();
	const url = server.url;

	/* First, get a quote */
	const quoteResponse = await fetch(`${url}/api/getQuote`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				from: token1.publicKeyString.get(),
				to: token2.publicKeyString.get(),
				amount: '100',
				affinity: 'from'
			}
		})
	});

	expect(quoteResponse.status).toBe(200);
	const quoteData: unknown = await quoteResponse.json();
	expect(quoteData).toHaveProperty('ok', true);
	expect(quoteData).toHaveProperty('quote');

	if (typeof quoteData !== 'object' || quoteData === null || !('quote' in quoteData)) {
		throw(new Error('Invalid quote response'));
	}

	const quote = quoteData.quote;

	/* Test that the quote is rejected when validateQuote returns false */
	validateQuoteCalled = false;
	shouldAcceptQuote = false;

	const exchangeResponseRejected = await fetch(`${url}/api/createExchange`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				quote: quote,
				block: 'AAAAAAAAAA==' // A minimal valid base64 string that will decode but fail later
			}
		})
	});

	/* The validation callback should have been called */
	expect(validateQuoteCalled).toBe(true);
	/* And since it returned false, the server should reject the request */
	expect(exchangeResponseRejected.status).toBe(400);
	const errorData: unknown = await exchangeResponseRejected.json();
	expect(errorData).toHaveProperty('ok', false);
	expect(errorData).toHaveProperty('error');
	/* Verify we got the correct error type */
	if (typeof errorData === 'object' && errorData !== null && 'name' in errorData) {
		expect(errorData.name).toBe('KeetaFXAnchorQuoteValidationFailedError');
	}
});

test('FX Server Quote Expiry Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	/* Test with 5 second TTL */
	await using server = new KeetaNetFXAnchorHTTPServer({
		account: account,
		client: client,
		quoteSigner: account,
		fx: {
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			getConversionRateAndFee: async function() {
				return({
					account: account,
					convertedAmount: 1000n,
					cost: {
						amount: 0n,
						token: token1
					}
				});
			},
			quoteTTL: 5000 // 5 seconds
		}
	});

	await server.start();
	const url = server.url;

	/* Get a quote with expiry information */
	const quoteResponse = await fetch(`${url}/api/getQuote`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				from: token1.publicKeyString.get(),
				to: token2.publicKeyString.get(),
				amount: '100',
				affinity: 'from'
			}
		})
	});

	expect(quoteResponse.status).toBe(200);
	const quoteData: unknown = await quoteResponse.json();
	expect(quoteData).toHaveProperty('ok', true);
	expect(quoteData).toHaveProperty('quote');

	if (typeof quoteData !== 'object' || quoteData === null || !('quote' in quoteData)) {
		throw(new Error('Invalid quote response'));
	}

	const quote = quoteData.quote;
	if (typeof quote !== 'object' || quote === null || !('signed' in quote)) {
		throw(new Error('Invalid quote structure'));
	}

	const signed = quote.signed;
	if (typeof signed !== 'object' || signed === null) {
		throw(new Error('Invalid signed structure'));
	}

	/* Verify that expiry information is included */
	expect(signed).toHaveProperty('serverTime');
	expect(signed).toHaveProperty('expiresAt');

	/* Verify that serverTime and expiresAt are valid ISO 8601 timestamps */
	if (typeof signed !== 'object' || signed === null ||
	    !('serverTime' in signed) || typeof signed.serverTime !== 'string' ||
	    !('expiresAt' in signed) || typeof signed.expiresAt !== 'string') {
		throw(new Error('serverTime and expiresAt should be strings'));
	}

	const serverTime = new Date(signed.serverTime);
	const expiresAt = new Date(signed.expiresAt);
	expect(serverTime.toISOString()).toBe(signed.serverTime);
	expect(expiresAt.toISOString()).toBe(signed.expiresAt);

	/* Verify that expiresAt is approximately 5 seconds after serverTime */
	const timeDiff = expiresAt.getTime() - serverTime.getTime();
	expect(timeDiff).toBeGreaterThanOrEqual(4999); // Allow 1ms tolerance
	expect(timeDiff).toBeLessThanOrEqual(5001); // Allow 1ms tolerance

	/* Test that a non-expired quote is accepted */
	const exchangeResponseValid = await fetch(`${url}/api/createExchange`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				quote: quote,
				block: 'AAAAAAAAAA==' // A minimal valid base64 string that will decode but fail later (but after expiry check)
			}
		})
	});

	/* The quote should not be rejected for expiry (it will fail for other reasons) */
	/* If it was rejected for expiry, status would be 400 with QuoteValidationFailed error */
	const validData: unknown = await exchangeResponseValid.json();
	if (typeof validData === 'object' && validData !== null && 'name' in validData) {
		expect(validData.name).not.toBe('KeetaFXAnchorQuoteValidationFailedError');
	}

	/* Now test with an expired quote by manipulating the expiresAt timestamp */
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const expiredQuote = JSON.parse(JSON.stringify(quote));
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	expiredQuote.signed.expiresAt = new Date(Date.now() - 1000).toISOString(); // 1 second in the past

	const exchangeResponseExpired = await fetch(`${url}/api/createExchange`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				quote: expiredQuote,
				block: 'AAAAAAAAAA=='
			}
		})
	});

	/* The expired quote should be rejected */
	expect(exchangeResponseExpired.status).toBe(400);
	const expiredData: unknown = await exchangeResponseExpired.json();
	expect(expiredData).toHaveProperty('ok', false);
	expect(expiredData).toHaveProperty('error');
	if (typeof expiredData === 'object' && expiredData !== null && 'name' in expiredData) {
		expect(expiredData.name).toBe('KeetaFXAnchorQuoteValidationFailedError');
	}
});

test('FX Server Quote Without Expiry Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const token1 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1);
	const token2 = account.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 2);
	const { userClient: client } = await createNodeAndClient(account);

	/* Test without TTL (expiry disabled) */
	await using server = new KeetaNetFXAnchorHTTPServer({
		account: account,
		client: client,
		quoteSigner: account,
		fx: {
			from: [{
				currencyCodes: [token1.publicKeyString.get()],
				to: [token2.publicKeyString.get()]
			}],
			getConversionRateAndFee: async function() {
				return({
					account: account,
					convertedAmount: 1000n,
					cost: {
						amount: 0n,
						token: token1
					}
				});
			}
			/* quoteTTL not specified - no expiry */
		}
	});

	await server.start();
	const url = server.url;

	/* Get a quote without expiry information */
	const quoteResponse = await fetch(`${url}/api/getQuote`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		},
		body: JSON.stringify({
			request: {
				from: token1.publicKeyString.get(),
				to: token2.publicKeyString.get(),
				amount: '100',
				affinity: 'from'
			}
		})
	});

	expect(quoteResponse.status).toBe(200);
	const quoteData: unknown = await quoteResponse.json();
	expect(quoteData).toHaveProperty('ok', true);
	expect(quoteData).toHaveProperty('quote');

	if (typeof quoteData !== 'object' || quoteData === null || !('quote' in quoteData)) {
		throw(new Error('Invalid quote response'));
	}

	const quote = quoteData.quote;
	if (typeof quote !== 'object' || quote === null || !('signed' in quote)) {
		throw(new Error('Invalid quote structure'));
	}

	const signed = quote.signed;
	if (typeof signed !== 'object' || signed === null) {
		throw(new Error('Invalid signed structure'));
	}

	/* Verify that expiry information is NOT included */
	expect('serverTime' in signed ? signed.serverTime : undefined).toBeUndefined();
	expect('expiresAt' in signed ? signed.expiresAt : undefined).toBeUndefined();
});
