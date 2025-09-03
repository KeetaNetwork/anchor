import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import type { ConversionInput } from './common.js';

const DEBUG = false;

const testCurrencyUSD = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
const testCurrencyEUR = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
const testCurrencyBTC = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

test('FX Anchor Client Test', async function() {
	const logger = DEBUG ? console : undefined;
	const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const liquidityProvider = KeetaNet.lib.Account.fromSeed(seed, 1);

	const { userClient: client } = await createNodeAndClient(account);
	const testTimestamp = new Date();

	await using server = new KeetaNetFXAnchorHTTPServer({
		account: liquidityProvider,
		client: client,
		fx: {
			getConversionRateAndFeeEstimate: async function(request) {
				return({
					request,
					convertedAmount: (parseInt(request.amount) * 0.88).toFixed(0),
					expectedCost: {
						min: '1',
						max: '5',
						token: testCurrencyUSD.publicKeyString.get()
					}
				});
			},
			getConversionRateAndFeeQuote: async function(request) {
				return({
					request,
					account: liquidityProvider.publicKeyString.get(),
					convertedAmount: (parseInt(request.amount) * 0.90).toFixed(0),
					cost: {
						amount: '5',
						token: testCurrencyUSD.publicKeyString.get()
					},
					signed: {
						nonce: '',
						timestamp: testTimestamp.toISOString(),
						signature: ''
					}
				});
			},
			createConversionSwap: async function(_ignored_request) {
				return({
					exchangeID: '123'
				});
			}
		}
	});

	/*
	 * Start the FX Anchor Server and get the URL
	 */
	await server.start();
	const serverURL = server.url;

	const sendBlock = await (new KeetaNet.lib.Block.Builder({
		account,
		network: client.network,
		previous: KeetaNet.lib.Block.NO_PREVIOUS,
		operations: [
			{
				type: KeetaNet.lib.Block.OperationType.SEND,
				to: liquidityProvider.publicKeyString.get(),
				token: testCurrencyUSD.publicKeyString.get(),
				amount: '100'
			},
			{
				type: KeetaNet.lib.Block.OperationType.RECEIVE,
				from: liquidityProvider.publicKeyString.get(),
				token: testCurrencyEUR.publicKeyString.get(),
				amount: '88',
				exact: true
			}
		]
	}).seal());

	const results = await client.setInfo({
		description: 'FX Anchor Test Root',
		name: 'TEST',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: testCurrencyUSD.publicKeyString.get(),
				EUR: testCurrencyEUR.publicKeyString.get(),
				'$BTC': testCurrencyBTC.publicKeyString.get()
			},
			services: {
				fx: {
					Bad: {
						from: [{
							currencyCodes: ['FOO'],
							to: ['BAR']
						}],
						operations: {
							getEstimate: 'https://example.com/getEstimate.json',
							getQuote: 'https://example.com/getQuote.json',
							createExchange: 'https://example.com/createExchange.json',
							getExchangeStatus: 'https://example.com/createVerification.json'
						}
					},
					Test: {
						from: [
							{
								currencyCodes: [testCurrencyUSD.publicKeyString.get()],
								to: [testCurrencyEUR.publicKeyString.get()]
							},
							{
								currencyCodes: [testCurrencyEUR.publicKeyString.get()],
								to: [testCurrencyUSD.publicKeyString.get()]
							},
							{
								currencyCodes: [testCurrencyUSD.publicKeyString.get()],
								to: [testCurrencyBTC.publicKeyString.get()]
							}
						],
						operations: {
							getEstimate: `${serverURL}/api/getEstimate`,
							getQuote: `${serverURL}/api/getQuote`,
							createExchange: `${serverURL}/api/createExchange`,
							getExchangeStatus: `${serverURL}/api/getExchangeStatus/{exchangeID}`
						}
					},
					Test2: {
						from: [
							{
								currencyCodes: [testCurrencyUSD.publicKeyString.get()],
								to: [testCurrencyBTC.publicKeyString.get()],
								kycProviders: ['Test']
							}
						],
						operations: {
							getEstimate: `${serverURL}/api/getEstimate`,
							getQuote: `${serverURL}/api/getQuote`,
							createExchange: `${serverURL}/api/createExchange`,
							getExchangeStatus: `${serverURL}/api/getExchangeStatus/{exchangeID}`
						}
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
		new KeetaNetAnchor.FX.Client(noSignerUserClient, {
			root: account,
			...(logger ? { logger: logger } : {})
		});
	}).rejects.toThrow();

	const fxClientConversions = new KeetaNetAnchor.FX.Client(client, {
		root: account,
		signer: account,
		account: account,
		...(logger ? { logger: logger } : {})
	});

	const conversionTests = [
		{
			test: async function() { return(await fxClientConversions.listCurrencies()) },
			result: [
				{ token: testCurrencyUSD.publicKeyString.get(), currency: 'USD' },
				{ token: testCurrencyEUR.publicKeyString.get(), currency: 'EUR' },
				{ token: testCurrencyBTC.publicKeyString.get(), currency: '$BTC' }
			]
		},
		{
			test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'USD' })) },
			result: { conversions: [testCurrencyEUR.publicKeyString.get(), testCurrencyBTC.publicKeyString.get()] }
		},
		{
			test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'EUR' })) },
			result: { conversions: [testCurrencyUSD.publicKeyString.get()] }
		},
		{
			test: async function() { return(await fxClientConversions.listPossibleConversions({ from: '$BTC' })) },
			result: { conversions: [] }
		},
		{
			test: async function() { return(await fxClientConversions.listPossibleConversions({ to: '$BTC' })) },
			result: { conversions: [testCurrencyUSD.publicKeyString.get()] }
		},
		{
			// @ts-expect-error
			test: async function() { return(await fxClientConversions.getEstimates({ from: 'FOO', to: 'BAR', amount: 10, affinity: 'from' })) },
			result: false
		},
		{
			// @ts-expect-error
			test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'FOO' })) },
			result: false
		},
		{
			// @ts-expect-error
			test: async function() { return(await fxClientConversions.listPossibleConversions({ to: 'BAR' })) },
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

	const fxClient = new KeetaNetAnchor.FX.Client(client, {
		root: account,
		...(logger ? { logger: logger } : {})
	});

	/* Get Estimate from Currency Codes */
	const requestCurrencyCodes: ConversionInput = { from: 'USD', to: 'EUR', amount: 100, affinity: 'from' };
	/* Get Estimate from Tokens */
	const requestTokens: ConversionInput = { from: testCurrencyUSD, to: testCurrencyEUR, amount: 100, affinity: 'from' };
	/* Get Estimate from Currency Codes Affinity: to */
	// TODO - provide more dynamic KeetaNetFXAnchorHTTPServer responses
	const requestCurrencyCodesTo: ConversionInput = { from: 'USD', to: 'EUR', amount: 100, affinity: 'to' };

	for (const request of [requestCurrencyCodes, requestTokens, requestCurrencyCodesTo]) {
		const requestCanonical = {
			from: testCurrencyUSD.publicKeyString.get(),
			to: testCurrencyEUR.publicKeyString.get(),
			amount: request.amount.toString(),
			affinity: request.affinity
		};

		const estimates = await fxClient.getEstimates(request);
		if (estimates === null) {
			throw(new Error('Estimates is NULL'));
		}
		const estimate = estimates[0];
		if (estimate === undefined) {
			throw(new Error('Estimate is undefined'));
		}
		expect(estimate.estimate).toEqual({
			request: requestCanonical,
			convertedAmount: (parseInt(requestCanonical.amount) * 0.88).toFixed(0),
			expectedCost: {
				min: '1',
				max: '5',
				token: testCurrencyUSD.publicKeyString.get()
			}
		});

		await expect(async function(){
			await estimate.getQuote(0.001);
		}).rejects.toThrow();

		const quote = await estimate.getQuote();
		expect(quote.quote).toEqual({
			request: requestCanonical,
			account: liquidityProvider.publicKeyString.get(),
			convertedAmount: (parseInt(requestCanonical.amount) * 0.90).toFixed(0),
			cost: {
				amount: '5',
				token: testCurrencyUSD.publicKeyString.get()
			},
			signed: {
				nonce: '',
				timestamp: testTimestamp.toISOString(),
				signature: ''
			}
		});

		const exchangeWithBlock = await quote.createExchange(sendBlock);
		// TODO - fix createConversionSwap in server setup to complete swap and return ID
		expect(exchangeWithBlock.exchange.exchangeID).toBe('123');

		const exchange = await quote.createExchange();
		expect(exchange.exchange.exchangeID).toBe('123');

		const exchangeStatus = await exchange.getExchangeStatus();
		expect(exchangeStatus.exchange.exchangeID).toBe('123');
	}
});
