import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;
const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';

test('FX Anchor Client Test', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	// const liquidityProvider = KeetaNet.lib.Account.fromSeed(seed, 1);
	// const quoteSigner = KeetaNet.lib.Account.fromSeed(seed, 2);
	const { userClient: client } = await createNodeAndClient(account);

	const baseToken = client.baseToken;

	const { account: testCurrencyUSDC } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!testCurrencyUSDC.isToken()) {
		throw(new Error('USDC is not a token'));
	}
	const initialAccountUSDCBalance = 500000n;
	await client.modTokenSupplyAndBalance(initialAccountUSDCBalance, testCurrencyUSDC);

	const initialAccountBalances = await client.allBalances();
	expect(toJSONSerializable(initialAccountBalances)).toEqual(toJSONSerializable([{ token: testCurrencyUSDC, balance: initialAccountUSDCBalance }]));

	// await using invalidServer = new KeetaNetFXAnchorHTTPServer({
	// 	account: liquidityProvider,
	// 	client: client,
	// 	quoteSigner: quoteSigner,
	// 	fx: {
	// 		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	// 		getConversionRateAndFee: async function() { return({} as Omit<KeetaFXAnchorQuote, 'request' | 'signed' >) }
	// 	}
	// });
	// await using server = new KeetaNetFXAnchorHTTPServer({
	// 	...(logger ? { logger: logger } : {}),
	// 	account: liquidityProvider,
	// 	quoteSigner: quoteSigner,
	// 	client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
	// 	fx: {
	// 		getConversionRateAndFee: async function(request) {
	// 			let rate = 0.88;
	// 			if (request.affinity === 'to') {
	// 				rate = 1 / rate;
	// 			}
	// 			return({
	// 				account: liquidityProvider.publicKeyString.get(),
	// 				convertedAmount: (parseInt(request.amount) * rate).toFixed(0),
	// 				cost: {
	// 					amount: '5',
	// 					token: testCurrencyUSD.publicKeyString.get()
	// 				}
	// 			});
	// 		}
	// 	}
	// });

	/*
	 * Start the FX Anchor Server and get the URL
	 */
	// await invalidServer.start();
	// const invalidServerURL = invalidServer.url;
	// await server.start();
	// const serverURL = server.url;
	const serverURL = 'http://localhost';

	const results = await client.setInfo({
		description: 'Asset Movement Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			services: {
				assetMovement: {
					Bad: {
						operations: {
							getEstimate: 'https://example.com/getEstimate.json',
							getQuote: 'https://example.com/getQuote.json',
							createExchange: 'https://example.com/createExchange.json',
							getExchangeStatus: 'https://example.com/createVerification.json'
						},
						supportedAssets: [
							{
								asset: baseToken.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
										]
									}
								]
							},
							{
								asset: testCurrencyUSDC.publicKeyString.get(),
								paths: [
									{
										pair: [
										]
									}
								]
							}
						]
					},
					Test: {
						operations: {
							initiateTransfer: `${serverURL}/api/initiateTransfer`,
							getTransferStatus: `${serverURL}/api/getTransferStatus`,
							createPersistentForwarding: `${serverURL}/api/createPersistentForwarding`,
							listTransactions: `${serverURL}/api/listTransactions`
						},
						supportedAssets: [
							{
								asset: baseToken.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }},
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ], inbound: [ 'EVM_CALL' ] }}
										]
									}
								]
							},
							{
								asset: testCurrencyUSDC.publicKeyString.get(),
								paths: [
									{
										pair: [
											{ location: 'chain:evm:100', id: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', rails: { common: [ 'EVM_SEND' ] }},
											{ location: 'chain:keeta:123', id: account.publicKeyString.get(), rails: { common: [ 'KEETA_SEND' ] }}
										]
									}
								]
							}
						]
					}
				}
			}
		})
	});
	logger?.log('Set info results:', results);

	await expect(async function() {
		const noSignerUserClient = new  KeetaNet.UserClient({
			client: client.client,
			network: client.network,
			networkAlias: client.config.networkAlias,
			account: KeetaNet.lib.Account.fromPublicKeyString(account.publicKeyString.get()),
			signer: null,
			usePublishAid: false
		});
		// Should fail with no signer error
		new KeetaNetAnchor.AssetMovement.Client(noSignerUserClient, {
			root: account,
			...(logger ? { logger: logger } : {})
		});
	}).rejects.toThrow();

	const assetTransferClient = new KeetaNetAnchor.AssetMovement.Client(client, {
		root: account,
		signer: account,
		account: account,
		...(logger ? { logger: logger } : {})
	});

	const baseTokenProvider = await assetTransferClient.getProvidersForTransfer({ asset: baseToken });

	const conversionTests = [
		{
			test: async function() { return((await assetTransferClient.resolver.listTransferableAssets()).sort()) },
			result: [testCurrencyUSDC.publicKeyString.get(), baseToken.publicKeyString.get()].sort()
		},
		{
			// no provider offers this pair
			test: async function() { return(await assetTransferClient.getProvidersForTransfer({ asset: baseToken, from: { location: 'chain:keeta:100' }, to: { location: 'chain:evm:100', recipient: '123' }, value: 100n })) },
			result: null
		},
		{
			// @ts-expect-error
			test: async function() { return(await assetTransferClient.createPersistentForwardingAddress(TODO_PROVIDER, { asset: baseToken, destinationLocation: 'chain:keeta:100', destinationAddress: account.publicKeyString.get(), sourceLocation: 'chain:evm:100' })) },
			result: false
		}
	];

	for (const test of conversionTests) {
		if (test.result === false) {
			await expect(test.test()).rejects.toThrow();
		} else {
			const result = await test.test();
			expect(result).toEqual(test.result);
		}
	}
});
