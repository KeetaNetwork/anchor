import { expect, test } from 'vitest';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';

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
