import { test, expect } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import * as KeetaNetAnchor from '../../client/index.js';
import { createNodeAndClient } from '../../lib/utils/tests/node.js';
import KeetaAnchorResolver from '../../lib/resolver.js';
import type { KeetaAnchorFXServerConfig } from './server.js';
import { KeetaNetFXAnchorHTTPServer } from './server.js';
import { KeetaAnchorQueueStorageDriverMemory } from '../../lib/queue/index.js';
import { asleep } from '../../lib/utils/asleep.js';
import type { ConversionInput, ConversionInputCanonicalJSON, KeetaFXAnchorQuote, KeetaFXInternalPriceQuote, KeetaNetToken } from './common.js';
import type KeetaFXAnchorClient from './client.js';
import { KeetaAnchorError, KeetaAnchorUserError } from '../../lib/error.js';

const DEBUG = false;
const logger = DEBUG ? console : undefined;
const toJSONSerializable = KeetaNet.lib.Utils.Conversion.toJSONSerializable;

const testCurrencyBTC = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0, KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
const seed = 'B56AA6594977F94A8D40099674ADFACF34E1208ED965E5F7E76EE6D8A2E2744E';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NonNullableReturn<T> = T extends (...args: any[]) => infer R ? NonNullable<Awaited<R>> : never;

type KeetaFXAnchorExchangeWithProvider = NonNullableReturn<NonNullableReturn<KeetaFXAnchorClient['getQuotes']>[number]['createExchange']>;
async function waitForExchangeToComplete(server: KeetaNetFXAnchorHTTPServer, exchangeInput: KeetaFXAnchorExchangeWithProvider) {
	const timeout = Date.now() + 20_000;
	await server.pipeline.run();
	await server.pipeline.maintain();

	let exchangeStatus: Awaited<ReturnType<typeof exchangeInput.getExchangeStatus>>;
	exchangeStatus = await exchangeInput.getExchangeStatus();

	while (exchangeStatus?.status !== 'completed') {
		if (Date.now() > timeout) {
			throw(new Error(`Timeout waiting for exchangeID ${exchangeInput.exchange.exchangeID} to complete -- status is ${JSON.stringify(exchangeStatus)}`));
		}

		exchangeStatus = await exchangeInput.getExchangeStatus();
		// logger?.debug('waitForExchangeToComplete', `Polled exchange status for exchangeID ${exchangeInput.exchange.exchangeID}:`, exchangeStatus);
		await asleep(50);
	}
	return(exchangeStatus);
}

for (const useDeprecated of [false, true]) {
	let addName = '';
	if (useDeprecated) {
		addName = ' (deprecated)';
	}
	test(`FX Anchor Client Test${addName}`, async function() {
		const account = KeetaNet.lib.Account.fromSeed(seed, 0);
		const quoteSigner = KeetaNet.lib.Account.fromSeed(seed, 2);

		let liquidityProviders: InstanceType<typeof KeetaNet.lib.Account>[];
		if (useDeprecated) {
			liquidityProviders = [KeetaNet.lib.Account.fromSeed(seed, 3)];
		} else {
			liquidityProviders = [
				KeetaNet.lib.Account.fromSeed(seed, 1000),
				KeetaNet.lib.Account.fromSeed(seed, 1001),
				KeetaNet.lib.Account.fromSeed(seed, 1002),
				KeetaNet.lib.Account.fromSeed(seed, 1003),
				KeetaNet.lib.Account.fromSeed(seed, 1004),
				KeetaNet.lib.Account.fromSeed(seed, 1005),
				KeetaNet.lib.Account.fromSeed(seed, 1006),
				KeetaNet.lib.Account.fromSeed(seed, 1007),
				KeetaNet.lib.Account.fromSeed(seed, 1008),
				KeetaNet.lib.Account.fromSeed(seed, 1009)
			];
		}
		await using nodeAndClient = await createNodeAndClient(account);
		const client = nodeAndClient.userClient;
		const baseToken = client.baseToken;
		const giveTokens = nodeAndClient.give.bind(nodeAndClient);

		const { account: testCurrencyUSD } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		if (!testCurrencyUSD.isToken()) {
			throw(new Error('USD is not a token'));
		}
		const initialAccountUSDBalance = 500000n;
		await client.modTokenSupplyAndBalance(initialAccountUSDBalance, testCurrencyUSD);

		const initialAccountBalanceUSD = await client.balance(testCurrencyUSD);
		expect(initialAccountBalanceUSD).toBe(initialAccountUSDBalance);

		const { account: testCurrencyEUR } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		if (!testCurrencyEUR.isToken()) {
			throw(new Error('USD is not a token'));
		}
		const initialLiquidityProviderEURBalancePerLiquidityProvider = 100000n;
		const initialLiquidityProviderEURBalanceTotal = initialLiquidityProviderEURBalancePerLiquidityProvider * BigInt(liquidityProviders.length);

		/**
		 * Allocate some tokens for the user account to send to the liquidity providers
		 */
		await giveTokens(client.account, 50n * BigInt(liquidityProviders.length));

		for (const liquidityProvider of liquidityProviders) {
			await client.modTokenSupplyAndBalance(initialLiquidityProviderEURBalancePerLiquidityProvider, testCurrencyEUR, { account: liquidityProvider });
			const permissionsPublish = await client.updatePermissions(liquidityProvider, new KeetaNet.lib.Permissions(['ACCESS']), undefined, undefined, { account: testCurrencyEUR });
			expect(permissionsPublish.publish).toBe(true);

			const initialLiquidityProviderBalances = await client.allBalances({ account: liquidityProvider });
			expect(toJSONSerializable(initialLiquidityProviderBalances)).toEqual(toJSONSerializable([{ token: testCurrencyEUR, balance: initialLiquidityProviderEURBalancePerLiquidityProvider }]));

			/**
			 * Give the liquidity provider some KTA to pay fees
			 */
			await client.send(liquidityProvider, 50n, baseToken);
		}

		await using invalidServer = new KeetaNetFXAnchorHTTPServer({
			account: liquidityProviders[0],
			client: client,
			quoteSigner: quoteSigner,
			requiresQuote: true,
			fx: {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				getConversionRateAndFee: async function() { return({} as Omit<KeetaFXAnchorQuote, 'request' | 'signed' >) }
			}
		});

		let serverArgs: Partial<ConstructorParameters<typeof KeetaNetFXAnchorHTTPServer>[0]>;
		if (useDeprecated) {
			serverArgs = {
				account: liquidityProviders[0]
			};
		} else {
			const liquidityProviderSigner = KeetaNet.lib.Account.fromSeed(seed, 3);

			/*
			 * Grant the liquidity provider signer SEND_ON_BEHALF permission to all liquidity providers
			 */
			for (const liquidityProvider of liquidityProviders) {
				const builder = client.client.makeBuilder({ signer: liquidityProvider.assertAccount() });
				builder.updatePermissions(liquidityProviderSigner, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']));
				await client.publishBuilder(builder);
			}

			serverArgs = {
				accounts: new KeetaNet.lib.Account.Set(liquidityProviders),
				signer: liquidityProviderSigner
			};
		}

		await using server = new KeetaNetFXAnchorHTTPServer({
			logger: logger,
			...serverArgs,
			quoteSigner: quoteSigner,
			client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
			requiresQuote: true,
			storage: {
				queue: new KeetaAnchorQueueStorageDriverMemory({
					logger: logger,
					id: 'queue'
				}),
				autoRun: false
			},
			fx: {
				getConversionRateAndFee: async function(request) {
					let rate = 0.88;
					if (request.affinity === 'to') {
						rate = 1 / rate;
					}
					const liquidityProviderAccount = liquidityProviders[Math.floor(Math.random() * liquidityProviders.length)];
					if (liquidityProviderAccount === undefined) {
						throw(new Error('internal error: No liquidity provider account'));
					}
					return({
						account: liquidityProviderAccount,
						convertedAmount: BigInt(request.amount) * BigInt(Math.round(rate * 1000)) / 1000n,
						cost: {
							amount: 5n,
							token: baseToken
						}
					});
				}
			}
		});

		/*
		 * Start the FX Anchor Server and get the URL
		 */
		await invalidServer.start();
		const invalidServerURL = invalidServer.url;
		await server.start();
		const serverURL = server.url;

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
									to: [testCurrencyEUR.publicKeyString.get(), testCurrencyUSD.publicKeyString.get()]
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
								},
								{
									currencyCodes: [testCurrencyEUR.publicKeyString.get()],
									to: [testCurrencyBTC.publicKeyString.get()],
									kycProviders: ['Test']
								}
							],
							operations: {
								getEstimate: `${invalidServerURL}/api/getEstimate`,
								getQuote: `${invalidServerURL}/api/getQuote`,
								createExchange: `${invalidServerURL}/api/createExchange`
							}
						}
					}
				}
			})
		});
		logger?.log('Set info results:', results);

		await expect(async function() {
			const noSignerUserClient = new KeetaNet.UserClient({
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
				logger: logger
			});
		}).rejects.toThrow();

		const fxClientConversions = new KeetaNetAnchor.FX.Client(client, {
			root: account,
			signer: account,
			account: account,
			logger: logger
		});

		const conversionTests = [
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'USD' })) },
				result: { conversions: [testCurrencyEUR.publicKeyString.get(), testCurrencyBTC.publicKeyString.get()] }
			},
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'EUR' })) },
				result: { conversions: [testCurrencyUSD.publicKeyString.get(), testCurrencyBTC.publicKeyString.get()] }
			},
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({ from: '$BTC' })) },
				result: null
			},
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({ to: '$BTC' })) },
				result: { conversions: [testCurrencyUSD.publicKeyString.get(), testCurrencyEUR.publicKeyString.get()] }
			},
			{
				// no provider offers this pair
				test: async function() { return(await fxClientConversions.getEstimates({ from: '$BTC', to: 'USD', amount: 10n, affinity: 'from' })) },
				result: null
			},
			{
				test: async function() { return(await fxClientConversions.getQuotes({ from: '$BTC', to: 'USD', amount: 10n, affinity: 'from' })) },
				result: null
			},
			{
				// invalid currency codes
				// @ts-expect-error
				test: async function() { return(await fxClientConversions.getEstimates({ from: 'FOO', to: 'BAR', amount: 10n, affinity: 'from' })) },
				result: false
			},
			{
				// @ts-expect-error
				test: async function() { return(await fxClientConversions.getQuotes({ from: 'FOO', to: 'BAR', amount: 10n, affinity: 'from' })) },
				result: false
			},
			{
				// Cannot convert negative amount
				test: async function() { return(await fxClientConversions.getEstimates({ from: 'USD', to: 'EUR', amount: -10n, affinity: 'from' })) },
				result: false
			},
			{
				test: async function() { return(await fxClientConversions.getQuotes({ from: 'USD', to: 'EUR', amount: -10n, affinity: 'from' })) },
				result: false
			},
			{
				// invalid anchor server throws an error but SDK returns null
				test: async function() { return(await fxClientConversions.getEstimates({ from: 'EUR', to: '$BTC', amount: 10n, affinity: 'from' })) },
				result: null
			},
			{
				test: async function() { return(await fxClientConversions.getQuotes({ from: 'EUR', to: '$BTC', amount: 10n, affinity: 'from' })) },
				result: null
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
			},
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({})) },
				result: false
			},
			{
				test: async function() { return(await fxClientConversions.listPossibleConversions({ from: 'USD', to: 'EUR' })) },
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
			logger: logger
		});

		/* Get Estimate from Currency Codes */
		const requestCurrencyCodes: ConversionInput = { from: 'USD', to: 'EUR', amount: 100n, affinity: 'from' };
		/* Get Estimate from Tokens */
		const requestTokens: ConversionInput = { from: testCurrencyUSD, to: testCurrencyEUR, amount: 100n, affinity: 'from' };
		/* Get Estimate from Currency Codes Affinity: to */
		// TODO - provide more dynamic KeetaNetFXAnchorHTTPServer responses
		const requestCurrencyCodesTo: ConversionInput = { from: 'USD', to: 'EUR', amount: 88n, affinity: 'to' };

		let cumulativeEURChange = 0n;
		let cumulativeUSDChange = 0n;
		for (const request of [requestCurrencyCodes, requestTokens, requestCurrencyCodesTo]) {
			const requestCanonical = {
				from: testCurrencyUSD,
				to: testCurrencyEUR,
				amount: request.amount,
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
			let rate = 0.88;
			if (request.affinity === 'to') {
				rate = 1 / rate;
			}
			expect(toJSONSerializable(estimate.estimate)).toEqual(toJSONSerializable({
				requiresQuote: true,
				request: requestCanonical,
				convertedAmount: BigInt(requestCanonical.amount) * BigInt(Math.round(rate * 1000)) / 1000n,
				expectedCost: {
					min: 5n,
					max: 5n,
					token: baseToken
				}
			}));

			const quotes = await fxClient.getQuotes(request);
			if (quotes === null) {
				throw(new Error('Quotes is NULL'));
			}
			const quote = quotes[0];
			if (quote === undefined) {
				throw(new Error('Quote is undefined'));
			}

			/*
			 * Ensure the quote is from one of the liquidity providers
			 */
			expect(liquidityProviders.find(function(liquidityProvider) {
				return(liquidityProvider.comparePublicKey(quote.quote.account));
			})).toBeDefined();

			/*
			 * Ensure the quote is correct based on hard-coded values
			 */
			expect(toJSONSerializable(quote.quote)).toEqual(toJSONSerializable({
				request: requestCanonical,
				account: quote.quote.account,
				convertedAmount: BigInt(requestCanonical.amount) * BigInt(Math.round(rate * 1000)) / 1000n,
				cost: {
					amount: 5n,
					token: baseToken
				},
				signed: {
					...quote.quote.signed
				}
			}));

			// TODO - figure out a way to create a different estimate than quote on the http server
			// await expect(async function(){
			// 	await estimate.getQuote(0.001);
			// }).rejects.toThrow();

			const quoteFromEstimate = await estimate.getQuote();

			/*
			 * Ensure the quote is from one of the liquidity providers
			 */
			expect(liquidityProviders.find(function(liquidityProvider) {
				return(liquidityProvider.comparePublicKey(quoteFromEstimate.quote.account));
			})).toBeDefined();

			/*
			 * Ensure the quote is correct based on hard-coded values
			 */
			expect(toJSONSerializable(quoteFromEstimate.quote)).toEqual(toJSONSerializable({
				request: requestCanonical,
				account: quoteFromEstimate.quote.account,
				convertedAmount: BigInt(requestCanonical.amount) * BigInt(Math.round(rate * 1000)) / 1000n,
				cost: {
					amount: 5n,
					token: baseToken
				},
				signed: {
					...quoteFromEstimate.quote.signed
				}
			}));

			/*
			 * Create Exchange with Block
			 */
			const sendAmount = requestCanonical.affinity === 'from' ? requestCanonical.amount : quoteFromEstimate.quote.convertedAmount;
			const receiveAmount = requestCanonical.affinity === 'from' ? quoteFromEstimate.quote.convertedAmount : requestCanonical.amount;
			const headBlock = await client.head();
			const swapBlockBuilder = new KeetaNet.lib.Block.Builder({
				account,
				network: client.network,
				previous: headBlock ?? KeetaNet.lib.Block.NO_PREVIOUS,
				operations: [
					{
						type: KeetaNet.lib.Block.OperationType.SEND,
						to: quoteFromEstimate.quote.account,
						token: requestCanonical.from,
						amount: sendAmount
					},
					{
						type: KeetaNet.lib.Block.OperationType.RECEIVE,
						from: quoteFromEstimate.quote.account,
						token: requestCanonical.to,
						amount: receiveAmount,
						exact: true
					}
				]
			});

			const invalidSwapBlock = await swapBlockBuilder.seal();
			await expect((async function() {
				// Missing cost operation so server should reject it
				await quoteFromEstimate.createExchange(invalidSwapBlock);
			})).rejects.toThrow();

			swapBlockBuilder.unseal();
			// Add the cost to the operations
			swapBlockBuilder.addOperation(
				{
					type: KeetaNet.lib.Block.OperationType.SEND,
					to: quoteFromEstimate.quote.account,
					token: quoteFromEstimate.quote.cost.token,
					amount: quoteFromEstimate.quote.cost.amount
				}
			);
			const swapRequestBlock = await swapBlockBuilder.seal();

			const exchangeWithBlock = await quoteFromEstimate.createExchange(swapRequestBlock);

			// TODO - fix createConversionSwap in server setup to complete swap and return ID
			expect(exchangeWithBlock.exchange.exchangeID).toBeDefined();

			const exchangeStatusFirst = await exchangeWithBlock.getExchangeStatus();
			expect(exchangeStatusFirst.exchangeID).toBe(exchangeWithBlock.exchange.exchangeID);
			expect(exchangeStatusFirst.status).toBe('pending');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-member-access
			expect((exchangeStatusFirst as any).blockhash).toBeUndefined();

			/**
			 * Wait for exchange to complete in the queue -- because we're using the same
			 * account, if we do not wait for it to complete the account head block
			 * will be wrong on the second block submission
			 */
			const exchangeStatusWithBlock = await waitForExchangeToComplete(server, exchangeWithBlock);
			expect(exchangeStatusWithBlock.exchangeID).toBe(exchangeWithBlock.exchange.exchangeID);
			expect(exchangeStatusWithBlock.status).toBe('completed');
			expect(exchangeStatusWithBlock.blockhash).toBeDefined();

			const exchange = await quoteFromEstimate.createExchange();
			expect(exchange.exchange.exchangeID).toBeDefined();

			const exchangeStatus = await waitForExchangeToComplete(server, exchange);
			expect(exchangeStatus.exchangeID).toBe(exchange.exchange.exchangeID);
			expect(exchangeStatus.status).toBe('completed');
			expect(exchangeStatus.blockhash).toBeDefined();

			/* Multiply by 2 since we createExchange twice for the same swap */
			cumulativeEURChange += BigInt(receiveAmount) * 2n;
			cumulativeUSDChange += BigInt(sendAmount) * 2n;

			const sortBalances = (a: { balance: bigint, token: KeetaNetToken; }, b: { balance: bigint, token: KeetaNetToken; }) => Number(a.balance - b.balance);
			const removeBaseTokenBalanceEntry = function(balanceEntry: { balance: bigint, token: KeetaNetToken; }) {
				/* Remove the KTA token balance since it may have changed due to fees */
				return(!balanceEntry.token.comparePublicKey(baseToken));
			};
			const newAccountBalances = (await client.allBalances({ account })).filter(removeBaseTokenBalanceEntry);

			expect(toJSONSerializable([...newAccountBalances].sort(sortBalances))).toEqual(toJSONSerializable([{ token: testCurrencyEUR, balance: cumulativeEURChange }, { token: testCurrencyUSD, balance: (initialAccountUSDBalance - cumulativeUSDChange) }].sort(sortBalances)));

			/*
			 * Sum the balances of all tokens of all liquidity providers
			 */
			const newLiquidityBalances = (await Promise.all(liquidityProviders.map(async function(liquidityProvider) {
				return((await client.allBalances({ account: liquidityProvider })).filter(removeBaseTokenBalanceEntry));
			}))).reduce(function(sum, current) {
				for (const entry of current) {
					const existingEntry = sum.find(function(sumEntry) {
						return(sumEntry.token.comparePublicKey(entry.token));
					});
					if (existingEntry) {
						existingEntry.balance += entry.balance;
					} else {
						sum.push({ token: entry.token, balance: entry.balance });
					}
				}

				return(sum);
			}, []);

			try {
				expect(toJSONSerializable([...newLiquidityBalances].sort(sortBalances))).toEqual(toJSONSerializable([{ token: testCurrencyUSD, balance: cumulativeUSDChange }, { token: testCurrencyEUR, balance: (initialLiquidityProviderEURBalanceTotal - cumulativeEURChange) }].sort(sortBalances)));
			} catch (balanceCheckError) {
				console.error('Liquidity Provider Balances:', newLiquidityBalances);
				console.error('Expected Balances:', [{ token: testCurrencyUSD.publicKeyString.get(), balance: cumulativeUSDChange, tokenName: 'USD' }, { token: testCurrencyEUR.publicKeyString.get(), balance: (initialLiquidityProviderEURBalanceTotal - cumulativeEURChange), tokenName: 'EUR' }]);
				throw(balanceCheckError);
			}
		}
	}, 30_000);
}

test('Swap Function Negative Tests', async function() {
	const account = KeetaNet.lib.Account.fromSeed(seed, 0);
	const account2 = KeetaNet.lib.Account.fromSeed(seed, 1);
	await using nodeAndClient = await createNodeAndClient(account);
	const client = nodeAndClient.userClient;
	const fees = nodeAndClient.fees;

	/**
	 * Disable fees to avoid tests failing due to fee issues
	 */
	fees.disable();

	const { account: newToken } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	if (!newToken.isToken()) {
		throw(new Error('New Token not Token'));
	}
	const from = { account, token: testCurrencyBTC, amount: 10n }
	const to = { account: account2, token: newToken, amount: 15n }
	const swapBlockNewToken = await client.createSwapRequest({ from, to });

	const swapMissingReceive = await (new KeetaNet.lib.Block.Builder({
		account,
		network: client.network,
		previous: KeetaNet.lib.Block.NO_PREVIOUS,
		operations: [
			{
				type: KeetaNet.lib.Block.OperationType.SEND,
				to: account,
				token: testCurrencyBTC,
				amount: 5n
			}
		]
	}).seal());

	const testFails = [
		// @ts-expect-error
		async function() { await client.acceptSwapRequest(undefined, undefined) },
		async function() { await client.acceptSwapRequest({ block: swapBlockNewToken, expected: {}}) },
		async function() { await client.acceptSwapRequest({ block: swapBlockNewToken, expected: { token: testCurrencyBTC }}) },
		async function() { await client.acceptSwapRequest({ block: swapBlockNewToken, expected: { amount: 5n }}) },
		async function() { await client.acceptSwapRequest({ block: swapMissingReceive, expected: {}}) }
	]

	for (const testFail of testFails) {
		await expect(async function() {
			await testFail()
		}).rejects.toThrow();
	}
});

async function ExpectKeetaAnchorError(errorName: string, method: () => unknown): Promise<KeetaAnchorError | KeetaAnchorUserError> {
	try {
		await method();
		expect(errorName).toEqual('Function resolved and did not throw');
		throw(new Error('expected method to throw'));
	} catch (error) {
		if (KeetaAnchorUserError.isInstance(error) || KeetaAnchorError.isInstance(error)) {
			expect(error.name).toEqual(errorName);
			return(error);
		} else {
			throw(error);
		}
	}

}

test('FX Server Estimate to Exchange Test', async function() {
	const userAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
	await using nodeAndClient = await createNodeAndClient(userAccount);
	const client = nodeAndClient.userClient;
	const giveTokens = nodeAndClient.give.bind(nodeAndClient);

	const initialAccountTokenBalance = 500000n;
	const { account: testCurrencyUSD } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const { account: testCurrencyEUR } = await client.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);

	if (!testCurrencyUSD.isToken() || !testCurrencyEUR.isToken()) {
		throw(new Error('Test currencies not tokens'));
	}

	const allTokenRecipients = [];
	allTokenRecipients.push(client.account);

	async function makeServerConfig(
		config: Pick<KeetaAnchorFXServerConfig, 'requiresQuote'>,
		getRate: (request: ConversionInputCanonicalJSON) => Promise<Pick<KeetaFXInternalPriceQuote, 'convertedAmount' | 'convertedAmountBound' | 'cost'>>
	): Promise<KeetaAnchorFXServerConfig> {
		const signerLiquidityAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
		allTokenRecipients.push(signerLiquidityAccount);

		await giveTokens(signerLiquidityAccount, 10000n);

		return({
			logger: logger,
			accounts: new KeetaNet.lib.Account.Set([ signerLiquidityAccount ]),
			signer: signerLiquidityAccount,
			client: { client: client.client, network: client.config.network, networkAlias: client.config.networkAlias },
			quoteSigner: signerLiquidityAccount,
			...config,
			fx: {
				from: [{
					currencyCodes: [testCurrencyUSD.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN).publicKeyString.get()],
					to: [testCurrencyEUR.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN).publicKeyString.get()]
				}],
				getConversionRateAndFee: async function(request) {
					const rateAndFee = await getRate(request);
					return({
						account: signerLiquidityAccount,
						...rateAndFee
					});
				}
			}
		});
	}

	await using serverRequiresQuote = new KeetaNetFXAnchorHTTPServer(await makeServerConfig({
		requiresQuote: true
	}, async function() {
		return({
			convertedAmount: 1003n,
			convertedAmountBound: 900n,
			cost: {
				amount: 0n,
				token: testCurrencyUSD
			}
		});
	}));

	await using serverDoesNotRequireQuote = new KeetaNetFXAnchorHTTPServer(await makeServerConfig({
		requiresQuote: {
			requiresQuote: false,
			validateQuoteBeforeExchange: false,
			issueQuotes: true
		}
	}, async function() {
		return({
			convertedAmount: 1002n,
			convertedAmountBound: 850n,
			cost: {
				amount: 0n,
				token: testCurrencyUSD
			}
		});
	}));

	await using serverDoesNotRequireDoesNotIssueQuote = new KeetaNetFXAnchorHTTPServer(await makeServerConfig({
		requiresQuote: {
			requiresQuote: false,
			validateQuoteBeforeExchange: false,
			issueQuotes: false
		}
	}, async function() {
		return({
			convertedAmount: 1001n,
			convertedAmountBound: 750n,
			cost: {
				amount: 0n,
				token: testCurrencyUSD
			}
		});
	}));

	for (const token of [testCurrencyUSD, testCurrencyEUR]) {
		await client.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: token });
		await client.modTokenSupplyAndBalance(initialAccountTokenBalance, token);

		for (const recipient of allTokenRecipients) {
			await client.send(recipient, 2000n, token);
		}
	}

	await serverRequiresQuote.start();
	await serverDoesNotRequireQuote.start();
	await serverDoesNotRequireDoesNotIssueQuote.start();

	await client.setInfo({
		name: 'TEST', description: 'FX Anchor Test Root',
		metadata: KeetaAnchorResolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: testCurrencyUSD.publicKeyString.get(),
				EUR: testCurrencyEUR.publicKeyString.get()
			},
			services: {
				fx: {
					TestRequiresQuote: await serverRequiresQuote.serviceMetadata(),
					TestDoesNotRequireQuote: await serverDoesNotRequireQuote.serviceMetadata(),
					TestDoesNotRequireDoesNotIssueQuote: await serverDoesNotRequireDoesNotIssueQuote.serviceMetadata()
				}
			}
		})
	});

	const fxClient = new KeetaNetAnchor.FX.Client(client, {
		root: userAccount,
		signer: userAccount,
		account: userAccount,
		logger: logger
	});

	const localeCompareArgs = [
		'en', { usage: 'sort', sensitivity: 'base' }
	] as const;

	{
		/**
		 * Ensure server that requires quote throws correct error.
		 */
		const estimates = await fxClient.getEstimates({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' }, undefined, {
			providerIDs: [ 'TestRequiresQuote' ]
		});

		const estimate = estimates?.[0];

		if (!estimate) {
			throw(new Error('estimate should be defined'));
		}

		await ExpectKeetaAnchorError('KeetaFXAnchorQuoteRequiredError', async function() {
			await estimate.createExchange();
		})
	}

	{
		/**
		 * Check estimates
		 */
		const estimates = await fxClient.getEstimates({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' });
		if (estimates === null) {
			throw(new Error('Estimates is NULL'));
		}

		const sortedEstimates = estimates.sort(function(a, b) {
			return(String(a['provider'].providerID).localeCompare(String(b['provider'].providerID), ...localeCompareArgs));
		});

		expect(sortedEstimates.map(function(entry) {
			return({ convertedAmount: entry.estimate.convertedAmount, convertedAmountBound: entry.estimate.convertedAmountBound });
		})).toEqual([
			{ convertedAmount: 1001n, convertedAmountBound: 750n },
			{ convertedAmount: 1002n, convertedAmountBound: 850n },
			{ convertedAmount: 1003n, convertedAmountBound: 900n }
		]);
	}

	{
		/**
		 * Check quote issuing
		 */
		const quotes = await fxClient.getQuotes({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' });
		if (quotes === null) {
			throw(new Error('Estimates is NULL'));
		}

		const sortedQuotes = quotes.sort(function(a, b) {
			return(String(a['provider'].providerID).localeCompare(String(b['provider'].providerID), ...localeCompareArgs));
		});

		expect(sortedQuotes.map(function(entry) {
			return({ convertedAmount: entry.quote.convertedAmount });
		})).toEqual([
			{ convertedAmount: 1002n },
			{ convertedAmount: 1003n }
		]);
	}

	{
		/**
		 * Check quote/estimate issuing
		 */
		const quotes = await fxClient.getQuotesOrEstimates({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' });
		if (quotes === null) {
			throw(new Error('quotes/estimates is NULL'));
		}

		const sortedQuotes = quotes.sort(function(a, b) {
			// @ts-ignore
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			return(String(a['provider'].providerID).localeCompare(String(b['provider'].providerID), ...localeCompareArgs));
		});

		expect(sortedQuotes.map(function(entry) {
			if (entry.isQuote) {
				return({ isQuote: true, convertedAmount: entry.quote.convertedAmount });
			} else {
				return({ isQuote: false, convertedAmount: entry.estimate.convertedAmount, convertedAmountBound: entry.estimate.convertedAmountBound });
			}
		})).toEqual([
			{ isQuote: false, convertedAmount: 1001n, convertedAmountBound: 750n },
			{ isQuote: true, convertedAmount: 1002n },
			{ isQuote: true, convertedAmount: 1003n }
		]);
	}

	{
		const estimates = await fxClient.getEstimates({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' }, undefined, {
			providerIDs: [ 'TestDoesNotRequireDoesNotIssueQuote' ]
		});



		const singleEstimate = estimates?.[0];
		if (singleEstimate === undefined) {
			throw(new Error('Could not get estimate from TestDoesNotRequireDoesNotIssueQuote'));
		}

		if (singleEstimate.isQuote) {
			throw(new Error('Expected estimate, got quote'));
		}

		expect(singleEstimate['provider'].providerID).toBe('TestDoesNotRequireDoesNotIssueQuote');

		expect(singleEstimate.estimate.convertedAmount).toBe(1001n);
		expect(singleEstimate.estimate.convertedAmountBound).toBe(750n);

		const exchange = await singleEstimate.createExchange();

		const completedStatus = await waitForExchangeToComplete(serverDoesNotRequireDoesNotIssueQuote, exchange);

		expect(completedStatus.status).toBe('completed');

		const staple = await client.client.getVoteStaple(completedStatus.blockhash);

		if (!staple) {
			throw(new Error('No staple found for exchange blockhash'));
		}

		const blocksWithoutFee = staple.blocks.filter(function(block) {
			return(block.purpose !== KeetaNet.lib.Block.Purpose.FEE);
		});
		expect(blocksWithoutFee.length).toEqual(2);

		if (singleEstimate.estimate.requiresQuote !== false) {
			throw(new Error('Estimate should not require quote'));
		}

		const liquidityAccount = singleEstimate.estimate.account;

		for (let i = 0; i < blocksWithoutFee.length; i++) {
			const block = staple.blocks[i];

			if (!block) {
				throw(new Error('Missing block in staple'));
			}

			if (i === 0) {
				expect(block.account.comparePublicKey(liquidityAccount)).toBe(true);
				expect(toJSONSerializable(block.operations)).toEqual(toJSONSerializable([
					{
						type: KeetaNet.lib.Block.OperationType.SEND,
						to: userAccount,
						token: testCurrencyEUR,
						amount: 1001n
					}
				]));
			} else if (i === 1) {
				expect(block.account.comparePublicKey(userAccount)).toBe(true);

				expect(toJSONSerializable(block.operations)).toEqual(toJSONSerializable([
					{
						type: KeetaNet.lib.Block.OperationType.SEND,
						to: liquidityAccount,
						token: testCurrencyUSD,
						amount: 1000n
					},
					{
						type: KeetaNet.lib.Block.OperationType.RECEIVE,
						from: liquidityAccount,
						token: testCurrencyEUR,
						amount: 750n,
						exact: false
					}
				]));
			} else {
				expect(false).toBe(true);
			}
		}
	}

	{
		/**
		 * Ensure server is validating block being sent by client
		 */
		const quoteOrEstimates = await fxClient.getQuotesOrEstimates({ from: testCurrencyUSD, to: testCurrencyEUR, amount: 1000n, affinity: 'from' });

		expect(quoteOrEstimates?.length).toEqual(3);

		for (const quoteOrEstimate of quoteOrEstimates ?? []) {
			let liquidityAccount;

			if (quoteOrEstimate.isQuote) {
				liquidityAccount = quoteOrEstimate.quote.account;
			} else if (quoteOrEstimate.estimate.requiresQuote === false) {
				liquidityAccount = quoteOrEstimate.estimate.account;
			} else {
				throw(new Error('could not get liquidityAccount'));
			}

			const testCases: {
				builder: () => Promise<InstanceType<typeof KeetaNet['Client']['Builder']>>,
				errorCode: string;
				errorMessageContains?: string;
			}[] = [
				{
					async builder() {
						const builder = client.initBuilder();
						builder.send(liquidityAccount, 999n, testCurrencyUSD);
						return(builder);
					},
					errorCode: 'KeetaAnchorUserError',
					errorMessageContains: 'send'
				},
				{
					async builder() {
						const builder = client.initBuilder();
						builder.send(liquidityAccount, 1000n, testCurrencyUSD);
						builder.receive(liquidityAccount, 2000n, testCurrencyEUR);
						return(builder);
					},
					errorCode: 'KeetaAnchorUserError',
					errorMessageContains: 'receive'
				},
				{
					async builder() {
						const builder = client.initBuilder();
						const randomAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
						builder.send(randomAccount, 1000n, testCurrencyUSD);
						builder.receive(liquidityAccount, 900n, testCurrencyEUR);
						return(builder);
					},
					errorCode: 'KeetaAnchorUserError'
				},
				{
					async builder() {
						const builder = client.initBuilder();
						const randomAccount = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0);
						builder.send(liquidityAccount, 1000n, testCurrencyUSD);
						builder.receive(randomAccount, 900n, testCurrencyEUR);
						return(builder);
					},
					errorCode: 'KeetaAnchorUserError',
					errorMessageContains: 'liquidity account'
				}
			];

			for (const testCase of testCases) {
				const error = await ExpectKeetaAnchorError(testCase.errorCode, async function() {
					const builder = await testCase.builder();
					const { blocks } = await builder.computeBlocks();
					const block = blocks[0];
					await quoteOrEstimate.createExchange(block);
				});

				if (testCase.errorMessageContains) {
					expect(error.message.toLowerCase()).includes(testCase.errorMessageContains.toLowerCase());
				}
			}
		}
	}
});
