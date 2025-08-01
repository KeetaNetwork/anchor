import { test, expect } from 'vitest';
import Resolver from './resolver.js';
import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { createNodeAndClient } from './utils/tests/node.js';

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
			services: {
				kyc: {
					keeta_internal: {
						operations: {
							createVerification: 'https://kyc.keeta.com/api/v1/createVerification'
						},
						countryCodes: ['US']
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
						url: `keetanet://keeta_broken/metadata`
					},
					keeta_broken2: {
						/* Broken Link (invalid protocol) */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `http://insecure.com/metadata`
					},
					keeta_broken3: {
						/* XXX: Broken Link (currently not implemented) */
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `https://insecure.com/metadata`
					},
					keeta_broken4: {
						/* Invalid countryCodes schema */
						operations: {
							createAccount: 'https://banchor.broken4.com/api/v1/createAccount'
						},
						countryCodes: 'USD'
					},
					keeta_nomatch1: {
					},
					keeta_nomatch2: {
						operations: {
							createAccount: 'https://banchor.nomatch2.com/api/v1/createAccount'
						}
					}
				}
			}
		})
	});

	const resolver = new Resolver({
		root: testAccount,
		client: userClient,
		trustedCAs: []
	});

	return({
		resolver
	});
}

test('Basic Tests', async function() {
	const { resolver } = await setupForResolverTests();
	expect(resolver.stats.reads).toBe(0);

	/*
	 * Various resolver checks
	 */
	const allChecks = {
		banking: [{
			input: {
				countryCodes: ['US' as const]
			},
			createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
		}, {
			input: {
				currencyCodes: ['USD' as const]
			},
			createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
		}, {
			input: {
				countryCodes: ['MX' as const]
			},
			createAccount: 'https://banchor.foo.com/api/v1/createAccount'
		}, {
			input: {
				currencyCodes: ['MXN' as const]
			},
			createAccount: 'https://banchor.foo.com/api/v1/createAccount'
		}, {
			input: {
				countryCodes: ['US' as const],
				currencyCodes: ['USD' as const]
			},
			createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
		}, {
			input: {
				countryCodes: ['MX' as const] ,
				currencyCodes: ['MXN' as const]
			},
			createAccount: 'https://banchor.foo.com/api/v1/createAccount'
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
			createVerification: 'https://kyc.keeta.com/api/v1/createVerification'
		}, {
			input: {
				countryCodes: ['MX' as const]
			},
			result: undefined
		}]
	};

	for (const checkKind of ['banking', 'kyc'] as const) {
		const checks = allChecks[checkKind];
		for (const check of checks) {
			const checkResults = await resolver.lookup(checkKind, check.input);
			if ('result' in check && check.result === undefined) {
				expect(checkResults).toBeUndefined();

				continue;
			}
			expect(checkResults).toBeDefined();
			if (checkResults === undefined) {
				throw(new Error('internal error: checkResults is undefined'));
			}

			/*
			 * Just look at the first result
			 */
			const checkResult = checkResults[Object.keys(checkResults)[0] as keyof typeof checkResults];
			expect(checkResult).toBeDefined();
			if (checkResult === undefined) {
				throw(new Error('internal error: checkResult is undefined'));
			}

			const operations = await checkResult.operations('object');
			switch (checkKind) {
				case 'banking':
					if (!('createAccount' in operations)) {
						throw(new Error(`internal error: createAccount not found in operations for ${checkKind}`));
					}
					if ('createAccount' in check) {
						const checkCreateAccount = await operations.createAccount?.('string');
						expect(checkCreateAccount).toEqual(check.createAccount);
					}
					break;
				case 'kyc':
					if (!('createVerification' in operations)) {
						throw(new Error(`internal error: createVerification not found in operations for ${checkKind}`));
					}

					if ('createVerification' in check) {
						const checkCreateVerification = await operations.createVerification?.('string');
						expect(checkCreateVerification).toEqual(check.createVerification);
					}
					break;
			}
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
