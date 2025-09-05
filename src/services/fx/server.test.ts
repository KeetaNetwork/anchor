import { expect, test } from "vitest";
import { KeetaNetFXAnchorHTTPServer } from "./server.js";
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from "../../lib/utils/tests/node.js";
import type { KeetaFXAnchorQuote } from "./common.js";

test('FX Server Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	const { userClient: client } = await createNodeAndClient(account);

	await using server = new KeetaNetFXAnchorHTTPServer({
		account: account,
		client: client,
		quoteSigner: account,
		fx: {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			getConversionRateAndFee: async function() { return({} as Omit<KeetaFXAnchorQuote, 'request' | 'signed' >) }
		}
	});

	await server.start();
	const url = server.url;

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
});
