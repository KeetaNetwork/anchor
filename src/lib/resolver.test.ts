import { test, expect } from 'vitest';
import Resolver from './resolver.js';
import type { ServiceMetadata, ServiceMetadataExternalizable, ServiceSearchCriteria } from './resolver.ts';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { createNodeAndClient } from './utils/tests/node.js';
import CurrencyInfo from '@keetanetwork/currency-info';

async function setInfo(account: ReturnType<typeof KeetaNetClient.lib.Account.fromSeed>, userClient: KeetaNetClient.UserClient, value: Parameters<typeof Resolver.Metadata.formatMetadata>[0]): Promise<void> {
	const testAccountExternalUserClient = new KeetaNetClient.UserClient({
		client: userClient.client,
		signer: account,
		usePublishAid: false,
		network: userClient.network,
		/* XXX:TODO: Need to be able to get this from the UserClient/Client */
		networkAlias: 'test'
	});

	await testAccountExternalUserClient.setInfo({
		name: '',
		description: '',
		metadata: Resolver.Metadata.formatMetadata(value)
	});
}

async function setupForResolverTests() {
	const testAccountSeed = KeetaNetClient.lib.Account.generateRandomSeed();
	const testAccount = KeetaNetClient.lib.Account.fromSeed(testAccountSeed, 0);
	const testAccountExternal = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const testAccountExternalRef = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const testAccountLoop = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const testCurrencyUSD = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0, KeetaNetClient.lib.Account.AccountKeyAlgorithm.TOKEN);
	const testCurrencyMXN = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0, KeetaNetClient.lib.Account.AccountKeyAlgorithm.TOKEN);
	const testCurrencyBTC = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0, KeetaNetClient.lib.Account.AccountKeyAlgorithm.TOKEN);

	const { userClient } = await createNodeAndClient(testAccount);

	/*
	 * An account whose metadata is set at the top-level,
	 * and referenced by the root account
	 */
	await setInfo(testAccountExternal, userClient, {
		operations: {
			createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
		},
		countryCodes: ['US'],
		currencyCodes: ['USD'],
		kycProviders: ['Keeta']
	});

	/*
	 * An account whose metadata references another account at the top-level
	 */
	await setInfo(testAccountExternalRef, userClient, {
		external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
		url: `keetanet://${testAccountExternal.publicKeyString.get()}/metadata`
	});

	/*
	 * An account whose metadata references itself, creating an infinite loop
	 */
	await setInfo(testAccountLoop, userClient, {
		external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
		url: `keetanet://${testAccountLoop.publicKeyString.get()}/metadata`
	});

	/*
	 * Set the metadata for the root account
	 */
	await userClient.setInfo({
		name: '',
		description: '',
		metadata: Resolver.Metadata.formatMetadata({
			version: 1,
			currencyMap: {
				USD: testCurrencyUSD.publicKeyString.get(),
				MXN: testCurrencyMXN.publicKeyString.get(),
				'$BTC': testCurrencyBTC.publicKeyString.get()
			},
			services: {
				kyc: {
					keeta_internal: {
						operations: {
							createVerification: 'https://kyc.keeta.com/api/v1/createVerification'
						},
						countryCodes: ['US'],
						ca: 'TEST'
					}
				},
				fx: {
					keeta_fx: {
						operations: {
							getQuote: 'https://fx.keeta.com/api/v1/getQuote',
							createExchange: 'https://fx.keeta.com/api/v1/createExchange',
							getEstimate: 'https://fx.keeta.com/api/v1/getEstimate',
							getExchangeStatus: 'https://fx.keeta.com/api/v1/getStatus/{id}'
						},
						from: [{
							currencyCodes: [testCurrencyUSD.publicKeyString.get()],
							to: [testCurrencyMXN.publicKeyString.get()],
							kycProviders: ['']
						}],
					}
				},
				banking: {
					keeta_foo: {
						operations: {
							createAccount: 'https://banchor.foo.com/api/v1/createAccount'
						},
						countryCodes: ['MX'],
						currencyCodes: ['MXN'],
						kycProviders: ['Keeta']
					},
					keeta_https: {
						/* HTTPS Link */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: 'https://localhost:9341/metadata'
					},
					[testAccountLoop.publicKeyString.get()]: {
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `keetanet://${testAccountLoop.publicKeyString.get()}/metadata`
					},
					[testAccountExternalRef.publicKeyString.get()]: {
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `keetanet://${testAccountExternalRef.publicKeyString.get()}/metadata`
					},
					keeta_broken1: {
						/* Broken KeetaNet Link */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: 'keetanet://keeta_broken/metadata'
					},
					keeta_broken2: {
						/* Broken Link (invalid protocol) */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: 'http://insecure.com/metadata'
					},
					keeta_broken3: {
						/* Broken Link (no such file) */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: 'https://keeta.com/__TEST__/metadata'
					},
					keeta_broken4: {
						/* Invalid countryCodes schema */
						operations: {
							createAccount: 'https://banchor.broken4.com/api/v1/createAccount'
						},
						countryCodes: 'USD'
					} as unknown as NonNullable<ServiceMetadata['services']['banking']>[string],
					keeta_nomatch1: {
					} as unknown as NonNullable<ServiceMetadata['services']['banking']>[string],
					keeta_nomatch2: {
						operations: {
							createAccount: 'https://banchor.nomatch2.com/api/v1/createAccount'
						}
					} as unknown as NonNullable<ServiceMetadata['services']['banking']>[string]
				}
			}
		} satisfies ServiceMetadataExternalizable)
	});

	const resolver = new Resolver({
		root: testAccount,
		client: userClient,
		trustedCAs: [],
logger: console
	});

	return({
		resolver,
		tokens: {
			USD: testCurrencyUSD,
			MXN: testCurrencyMXN,
			'$BTC': testCurrencyBTC
		}
	});
}

test('Basic Tests', async function() {
	const { resolver, tokens } = await setupForResolverTests();
	expect(resolver.stats.reads).toBe(0);

	/*
	 * Various resolver checks
	 */
	const allChecks = {
		banking: [{
			input: {
				countryCodes: ['US' as const]
			},
			createAccount: ['https://banchor.testaccountexternal.com/api/v1/createAccount']
		}, {
			input: {
				currencyCodes: ['USD' as const]
			},
			createAccount: ['https://banchor.testaccountexternal.com/api/v1/createAccount']
		}, {
			input: {
				countryCodes: ['MX' as const]
			},
			createAccount: ['https://banchor.foo.com/api/v1/createAccount']
		}, {
			input: {
				currencyCodes: ['MXN' as const]
			},
			createAccount: ['https://banchor.foo.com/api/v1/createAccount']
		}, {
			input: {
				countryCodes: ['US' as const],
				currencyCodes: ['USD' as const]
			},
			createAccount: ['https://banchor.testaccountexternal.com/api/v1/createAccount']
		}, {
			input: {
				countryCodes: ['MX' as const] ,
				currencyCodes: ['MXN' as const]
			},
			createAccount: ['https://banchor.foo.com/api/v1/createAccount']
		}, {
			input: {
				countryCodes: ['US' as const] ,
				currencyCodes: ['MXN' as const]
			},
			result: undefined
		}],
		kyc: [{
			input: {
				countryCodes: ['US' as const]
			},
			createVerification: ['https://kyc.keeta.com/api/v1/createVerification']
		}, {
			input: {
				countryCodes: ['MX' as const]
			},
			result: undefined
		}],
		fx: [{
			input: {
				inputCurrencyCode: 'USD' as const,
				outputCurrencyCode: 'MXN' as const
			},
			createExchange: ['https://fx.keeta.com/api/v1/createExchange']
		}, {
			input: {
				inputCurrencyCode: 'USD' as const,
				outputCurrencyCode: 'EUR' as const
			},
			result: undefined
		}]
	} satisfies {
		[key in keyof NonNullable<ServiceMetadata['services']>]: ({
			input: ServiceSearchCriteria<key>;
		} & ({
			result?: undefined;
		} | {
			createAccount?: string[];
			createVerification?: string[];
			createExchange?: string[];
		}))[]
	};

	for (const checkKind of ['banking', 'kyc', 'fx'] as const) {
		const checks = allChecks[checkKind];
		for (const check of checks) {
			const checkResults = await resolver.lookup(checkKind, check.input);
			if ('result' in check && check.result === undefined) {
				expect(checkResults).toBeUndefined();

				continue;
			}

			try {
				expect(checkResults).toBeDefined();
			} catch (checkError) {
				console.error(`checkResults for ${checkKind}, ${JSON.stringify(check)} is not defined`);
				throw(checkError);
			}
			if (checkResults === undefined) {
				throw(new Error('internal error: checkResults is undefined'));
			}

			/*
			 * Accumulate all the results
			 */
			const checkOperationName = Object.keys(check).find(function(key): key is 'createAccount' | 'createVerification' {
				return(key !== 'input' && key !== 'result');
			});
			if (checkOperationName === undefined) {
				throw(new Error(`internal error: checkOperationName is undefined for ${checkKind}, ${JSON.stringify(check)}`));
			}

			const foundOperations: string[] = [];
			for (const checkResultID of Object.keys(checkResults)) {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				const checkResult = checkResults[checkResultID as keyof typeof checkResults];
				if (checkResult === undefined) {
					throw(new Error(`internal error: checkResult for ${checkKind} is undefined`));
				}

				const operations = await checkResult.operations('object');
				if (checkOperationName in operations) {
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
					const operation = operations[checkOperationName as keyof typeof operations];
					if (operation === undefined) {
						throw(new Error(`internal error: operation for ${checkKind}, ${JSON.stringify(check)} is undefined`));
					}

					// @ts-ignore
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					foundOperations.push(await operation('string'));
				}
			}

			if (!(checkOperationName in check)) {
				throw(new Error(`internal error: checkOperationName ${checkOperationName} not found in check ${JSON.stringify(check)}`));
			}

			// @ts-ignore
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const expectedOperations: string[] = check[checkOperationName];

			expect([...foundOperations].sort()).toEqual([...expectedOperations].sort());
		}
	}

	/*
	 * Ensure that the resolver stats are being updated and that the
	 * cache is being used
	 */
	expect(resolver.stats.reads).toBeGreaterThan(0);
	expect(resolver.stats.cache.hit).toBeGreaterThan(0);
	expect(resolver.stats.cache.miss).toBeGreaterThan(0);
	expect(resolver.stats.keetanet.reads).toBeGreaterThan(0);

	/*
	 * Verify that this internal interface is not exposed to the user
	 */
	expect(function() {
		resolver._mutableStats(Symbol('statsAccessToken'));
	}).toThrow();

	/*
	 * Verify that currency lookups work
	 */
	/*
	 * These should not return an error, but may return null
	 * if the currency is not found
	 */
	const currencyChecksPassValid = [
		{
			input: 'USD',
			result: {
				token: tokens.USD.publicKeyString.get(),
				currency: 'USD'
			}
		},
		{
			input: 'MXN',
			result: {
				token: tokens.MXN.publicKeyString.get(),
				currency: 'MXN'
			}
		},
		{
			input: '$BTC',
			result: {
				token: tokens['$BTC'].publicKeyString.get(),
				currency: '$BTC'
			}
		},
		{
			input: 'EUR',
			result: null
		},
		{
			input: new CurrencyInfo.Currency('USD'),
			result: {
				token: tokens.USD.publicKeyString.get(),
				currency: 'USD'
			}
		},
		{
			input: (new CurrencyInfo.Currency('USD')).isoNumber,
			result: {
				token: tokens.USD.publicKeyString.get(),
				currency: 'USD'
			}
		},
		{
			input: "840",
			result: {
				token: tokens.USD.publicKeyString.get(),
				currency: 'USD'
			}
		},
		{
			input: "973",
			result: null
		},
		{
			input: 'EUR',
			result: null
		}
	] as const;

	/*
	 * These are invalid by type, but should not return an error -- they
	 * should return null
	 */
	const currencyChecksPassInvalid = [
		{
			input: '$USD'
		},
		{
			input: 'BTC'
		}
	] as const;

	/*
	 * These are invalid input and should throw an error
	 */
	const currencyChecksFail = [
		{
			input: null
		},
		{
			input: undefined
		},
		{
			input: {}
		},
		{
			input: []
		},
		{
			input: ['USD']
		}
	];

	/*
	 * Type check the valid checks that should pass
	 *
	 * The condition is always false, so this block never runs
	 * but the type checker sees it
	 */
	if (currencyChecksPassValid.length < 0) {
		for (const currencyCheck of currencyChecksPassValid) {
			resolver.lookupToken(currencyCheck.input);
		}
	}

	for (const currencyCheck of [...currencyChecksPassValid, ...currencyChecksPassInvalid]) {
		try {
			const currencyResult = await resolver.lookupToken(currencyCheck.input as any);
			let expectedResult;
			if ('result' in currencyCheck) {
				expectedResult = currencyCheck.result;
			} else {
				expectedResult = null;
			}
			if (expectedResult === null) {
				expect(currencyResult).toBeNull();
			} else {
				expect(currencyResult).toBeDefined();
				if (currencyResult === undefined) {
					throw(new Error('internal error: currencyResult is undefined'));
				}

				expect(currencyResult).toEqual(expectedResult);
			}
		} catch (lookupError) {
			console.error('resolver.lookupToken failed for', currencyCheck.input);
			throw(lookupError);
		}
	}

	for (const currencyCheck of currencyChecksFail) {
		try {
			await expect(async function() {
				return(await resolver.lookupToken(currencyCheck.input as any));
			}).rejects.toThrow();
		} catch (lookupError) {
			console.error('resolver.lookupToken failed for', currencyCheck.input);

			throw(lookupError);
		}
	}

	/**
	 * List all tokens and their associated currencies
	 */
	const allTokens = await resolver.listTokens();
	expect(allTokens.length).toBe(3);
	expect(allTokens.map(t => t.currency).sort()).toEqual(Object.keys(tokens).sort());
	for(const { token, currency } of allTokens) {
		expect(token).toBe(tokens[currency as keyof typeof tokens].publicKeyString.get());
	}
});

test('Concurrent Lookups', async function() {
	const concurrency = 1000;
	const { resolver } = await setupForResolverTests();

	/*
	 * Concurrent Lookups
	 */
	resolver.clearCache();

	/*
	 * Prime the cache with a single lookup
	 */
	await resolver.lookup('banking', {
		countryCodes: ['US' as const]
	});

	const lookupPromises = [];
	for (let lookupID = 0; lookupID < concurrency; lookupID++) {
		lookupPromises.push(resolver.lookup('banking', {
			countryCodes: ['US' as const]
		}));
	}

	const lookupAllResults = await Promise.all(lookupPromises);
	for (const lookupResults of lookupAllResults) {
		expect(lookupResults).toBeDefined();
		if (lookupResults === undefined) {
			throw(new Error('internal error: lookupResults is undefined'));
		}

		/*
		 * Just look at the first result
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const lookupResult = lookupResults[Object.keys(lookupResults)[0] as keyof typeof lookupResults];

		const operations = await lookupResult?.operations('object');
		const createAccount = await operations?.createAccount?.('string');
		expect(createAccount).toEqual('https://banchor.testaccountexternal.com/api/v1/createAccount');
	}
	expect(resolver.stats.reads).toBeGreaterThan(concurrency * 3);
	expect(resolver.stats.cache.hit).toBeGreaterThan(resolver.stats.cache.miss);
	expect(resolver.stats.cache.miss).toBeLessThan(concurrency * 2);
	expect(resolver.stats.keetanet.reads + resolver.stats.https.reads + resolver.stats.unsupported.reads).toBe(resolver.stats.cache.miss);
}, 30000);
