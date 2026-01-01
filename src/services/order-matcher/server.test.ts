import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import { KeetaNetOrderMatcherHTTPServer } from './server.js';
import type {
	KeetaOrderMatcherPriceHistoryResponse,
	KeetaOrderMatcherPriceInfoResponse,
	KeetaOrderMatcherPairDepthResponse
} from './common.ts';

const seed = 'DD2063130D5DA116D84890DC8450F0DC79A20B6965C8B7C3DB6B2E1C246D77F4';

test('Order matcher server exposes price endpoints and metadata', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);

	await using nodeAndClient = await createNodeAndClient(account);
	const client = nodeAndClient.userClient;

	const { account: baseTokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const baseToken = baseTokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: quoteTokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const quoteToken = quoteTokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	const priceInfoResponse: KeetaOrderMatcherPriceInfoResponse = {
		ok: true,
		last: '75.25'
	};

	const priceHistoryResponse: KeetaOrderMatcherPriceHistoryResponse = {
		ok: true,
		prices: [
			{
				timestamp: Date.now(),
				high: '76.00',
				low: '74.00',
				open: '75.00',
				close: '75.25',
				volume: '900.00'
			}
		]
	};

	const pairDepthResponse: KeetaOrderMatcherPairDepthResponse = {
		ok: true,
		grouping: 100,
		buy: [
			{
				price: '74.50',
				volume: '500.00'
			},
			{
				price: '74.75',
				volume: '300.00'
			}
		],
		sell: [
			{
				price: '75.50',
				volume: '450.00'
			},
			{
				price: '75.75',
				volume: '350.00'
			}
		]
	};

	let priceInfoCalls = 0;
	let priceHistoryCalls = 0;
		let pairDepthCalls = 0;

	await using server = new KeetaNetOrderMatcherHTTPServer({
		orderMatcher: {
			matchingAccounts: [ account ],
			pairs: [
				{
					base: [baseToken],
					quote: [quoteToken]
				}
			],
			getPairHistory: async function([tokenA, tokenB]) {
				priceHistoryCalls += 1;
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(priceHistoryResponse);
			},
			getPairInfo: async function([tokenA, tokenB]) {
				priceInfoCalls += 1;
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(priceInfoResponse);
			},
			getPairDepth: async function([tokenA, tokenB], grouping) {
				pairDepthCalls += 1;
				expect(grouping).toBe(100);
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(pairDepthResponse);
			}
		}
	});

	await server.start();

	const baseKey = baseToken.publicKeyString.get();
	const quoteKey = quoteToken.publicKeyString.get();

	const infoFetch = await fetch(`${server.url}/api/price-info/${baseKey}:${quoteKey}`);
	expect(infoFetch.ok).toBe(true);
	const infoJSON = await infoFetch.json();
	expect(infoJSON).toEqual(priceInfoResponse);

	const historyFetch = await fetch(`${server.url}/api/price-history/${baseKey}:${quoteKey}`);
	expect(historyFetch.ok).toBe(true);
	const historyJSON = await historyFetch.json();
	expect(historyJSON).toEqual(priceHistoryResponse);

	const depthFetch = await fetch(`${server.url}/api/pair-depth/${baseKey}:${quoteKey}?grouping=100`);
	expect(depthFetch.ok).toBe(true);
	const depthJSON = await depthFetch.json();
	expect(depthJSON).toEqual(pairDepthResponse);

	expect(priceInfoCalls).toBe(1);
	expect(priceHistoryCalls).toBe(1);
	expect(pairDepthCalls).toBe(1);

	const metadata = await server.serviceMetadata();
	expect(metadata.operations.getPairInfo).toBeDefined();
	expect(metadata.operations.getPairInfo).toContain('/api/price-info');
	expect(metadata.operations.getPairHistory).toBeDefined();
	expect(metadata.operations.getPairHistory).toContain('/api/price-history');
	expect(metadata.operations.getPairDepth).toBeDefined();
	expect(metadata.operations.getPairDepth).toContain('/api/pair-depth');
	expect(metadata.matchingAccounts).toEqual([ account.publicKeyString.get() ]);
	expect(metadata.pairs).toHaveLength(1);
	const [pairMetadata] = metadata.pairs;
	if (pairMetadata === undefined) {
		throw(new Error('Expected pair metadata in serviceMetadata response'));
	}
	expect(pairMetadata.base).toEqual([baseKey]);
	expect(pairMetadata.quote).toEqual([quoteKey]);
});
