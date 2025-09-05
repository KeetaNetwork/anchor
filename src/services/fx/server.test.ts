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
		{ request: { quote: {}, block: '' }}
	]

	const postRoutes = [
		'/api/getEstimate',
		'/api/getQuote',
		'/api/createExchange'
	]

	for (const route of postRoutes) {
		for (const data of testData) {
			const serverURL = `${url}${route}`;
			const results = await fetch(serverURL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				},
				body: JSON.stringify({
					request: data
				})
			});
			expect(results.status).toBe(500);
		}
	}


	const getParams = [
		''
		// '123' // TODO node client takes too long to timeout retries
	]
	for (const param of getParams) {
		const serverURL = `${url}/api/getExchangeStatus${param}`;
		const result = await fetch(serverURL, {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});
		expect(result.status).toBe(404);
	}
});
