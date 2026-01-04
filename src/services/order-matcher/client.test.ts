import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetOrderMatcherHTTPServer } from './server.js';
import KeetaOrderMatcherClient from './client.js';
import type {
	KeetaOrderMatcherPriceHistoryResponse,
	KeetaOrderMatcherPriceInfoResponse,
	KeetaOrderMatcherPairDepthResponse
} from './common.ts';

const seed = '3EA9C31127EB9F16D2653D4F0E20BB151B6F508E0D7D0A703BEA7ABF8D1A5B40';

test('Order matcher client retrieves price info and history', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);

	await using nodeAndClient = await createNodeAndClient(account);
	const client = nodeAndClient.userClient;

	const { account: baseTokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const baseToken = baseTokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: quoteTokenAccount } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const quoteToken = quoteTokenAccount.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	const priceInfoResponse: KeetaOrderMatcherPriceInfoResponse = {
		ok: true,
		last: '100.50',
		priceChange: {
			'1h': '1.20'
		},
		volume: {
			'1h': '2500.00'
		}
	};

	const priceHistoryResponse: KeetaOrderMatcherPriceHistoryResponse = {
		ok: true,
		prices: [
			{
				timestamp: Date.now(),
				high: '101.00',
				low: '99.50',
				open: '100.00',
				close: '100.25',
				volume: '1500.00'
			}
		]
	};

	const pairDepthResponse: KeetaOrderMatcherPairDepthResponse = {
		ok: true,
		grouping: 50,
		buy: [
			{
				price: '99.75',
				volume: '200.00'
			},
			{
				price: '99.50',
				volume: '150.00'
			}
		],
		sell: [
			{
				price: '100.50',
				volume: '175.00'
			},
			{
				price: '100.75',
				volume: '125.00'
			}
		]
	};

	await using server = new KeetaNetOrderMatcherHTTPServer({
		orderMatcher: {
			matchingAccounts: [ account ],
			pairs: [
				{
					base: [baseToken],
					quote: [quoteToken],
					fees: {
						type: 'sell-token-percentage',
						minPercentBasisPoints: 25
					}
				}
			],
			getPairHistory: async function([tokenA, tokenB]) {
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(priceHistoryResponse);
			},
			getPairInfo: async function([tokenA, tokenB]) {
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(priceInfoResponse);
			},
			getPairDepth: async function([tokenA, tokenB], grouping) {
				expect(grouping).toBe(50);
				expect(tokenA.comparePublicKey(baseToken)).toBe(true);
				expect(tokenB.comparePublicKey(quoteToken)).toBe(true);
				return(pairDepthResponse);
			}
		}
	});

	await server.start();

	const serviceMetadata = await server.serviceMetadata();

	await client.setInfo({
		name: 'TEST_ORDER_MATCHER_ANCHOR',
		description: 'Order matcher service for tests',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {},
			services: {
				orderMatcher: {
					TestProvider: serviceMetadata
				}
			}
		})
	});

	const resolver = new KeetaAnchorResolver({
		client: client.client,
		root: client.account,
		trustedCAs: []
	});

	const orderMatcherClient = new KeetaOrderMatcherClient(client, { resolver });

	const providers = await orderMatcherClient.getProvidersForPair([baseToken, quoteToken]);
	expect(providers).not.toBeNull();
	const [provider] = providers ?? [];
	if (provider === undefined) {
		throw(new Error('Provider lookup returned null unexpectedly'));
	}

	expect(String(provider.providerID)).toBe('TestProvider');

	expect(provider.matchingAccounts.map(account => account.publicKeyString.get())).toEqual([ account.publicKeyString.get() ]);
	const [metadata] = provider.pairs;
	if (metadata === undefined) {
		throw(new Error('Expected pair metadata'));
	}
	expect(metadata.base.map(token => token.publicKeyString.get())).toEqual([baseToken.publicKeyString.get()]);
	expect(metadata.quote.map(token => token.publicKeyString.get())).toEqual([quoteToken.publicKeyString.get()]);
	expect(metadata.fees).toEqual({ type: 'sell-token-percentage', minPercentBasisPoints: 25 });

	const info = await provider.getPairInfo([baseToken, quoteToken]);
	expect(info).toEqual(priceInfoResponse);

	const history = await provider.getPairHistory([baseToken, quoteToken]);
	expect(history).toEqual(priceHistoryResponse);

	const depth = await provider.getPairDepth([baseToken, quoteToken], 50);
	expect(depth).toEqual(pairDepthResponse);

	const allPairs = await orderMatcherClient.listAllPairs();
	expect(allPairs.map(([base, quote]) => [base.publicKeyString.get(), quote.publicKeyString.get()])).toEqual([
		[baseToken.publicKeyString.get(), quoteToken.publicKeyString.get()]
	]);

	const unmatched = await orderMatcherClient.getProvidersForPair([quoteToken, baseToken]);
	expect(unmatched).toBeNull();
});
