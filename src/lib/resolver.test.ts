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
	const TestAccountSeed = KeetaNetClient.lib.Account.generateRandomSeed();
	const TestAccount = KeetaNetClient.lib.Account.fromSeed(TestAccountSeed, 0);
	const TestAccountExternal = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const TestAccountExternalRef = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);
	const TestAccountLoop = KeetaNetClient.lib.Account.fromSeed(KeetaNetClient.lib.Account.generateRandomSeed(), 0);

	const { userClient } = await createNodeAndClient(TestAccount);

	/*
	 * An account whose metadata is set at the top-level,
	 * and referenced by the root account
	 */
	await setInfo(TestAccountExternal, userClient, {
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
	await setInfo(TestAccountExternalRef, userClient, {
		external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
		url: `keetanet://${TestAccountExternal.publicKeyString.get()}/metadata`
	});

	/*
	 * An account whose metadata references itself, creating an infinite loop
	 */
	await setInfo(TestAccountLoop, userClient, {
		external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
		url: `keetanet://${TestAccountLoop.publicKeyString.get()}/metadata`
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
				banking: {
					keeta_foo: {
						operations: {
							createAccount: 'https://banchor.foo.com/api/v1/createAccount'
						},
						countryCodes: ['MX'],
						currencyCodes: ['MXN'],
						kycProviders: ['Keeta']
					},
					[TestAccountLoop.publicKeyString.get()]: {
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `keetanet://${TestAccountLoop.publicKeyString.get()}/metadata`
					},
					[TestAccountExternalRef.publicKeyString.get()]: {
						external: '2b828e33-2692-46e9-817e-9b93d63f28fd',
						url: `keetanet://${TestAccountExternalRef.publicKeyString.get()}/metadata`
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
		root: TestAccount,
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
	const checks = [{
		input: {
			countryCodes: ['US' as const],
		},
		createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
	}, {
		input: {
			currencyCodes: ['USD' as const],
		},
		createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
	}, {
		input: {
			countryCodes: ['MX' as const] ,
		},
		createAccount: 'https://banchor.foo.com/api/v1/createAccount'
	}, {
		input: {
			currencyCodes: ['MXN' as const],
		},
		createAccount: 'https://banchor.foo.com/api/v1/createAccount'
	}, {
		input: {
			countryCodes: ['US' as const],
			currencyCodes: ['USD' as const],
		},
		createAccount: 'https://banchor.testaccountexternal.com/api/v1/createAccount'
	}, {
		input: {
			countryCodes: ['MX' as const] ,
			currencyCodes: ['MXN' as const],
		},
		createAccount: 'https://banchor.foo.com/api/v1/createAccount'
	}, {
		input: {
			countryCodes: ['US' as const] ,
			currencyCodes: ['MXN' as const],
		},
		result: undefined
	}];

	for (const check of checks) {
		const checkResult = await resolver.lookup('banking', check.input);

		if ('result' in check && check.result === undefined) {
			expect(checkResult).toBeUndefined();
			continue;
		}

		expect(checkResult).toBeDefined();
		if (checkResult === undefined) {
			throw(new Error('internal error: check is undefined'));
		}

		const operations = await checkResult.operations('object');
		if ('createAccount' in check) {
			const checkCreateAccount = await operations.createAccount?.('string');
			expect(checkCreateAccount).toEqual(check.createAccount);
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
	const { resolver } = await setupForResolverTests();

	/*
	 * Concurrent Lookups
	 */
	resolver.clearCache();
	const lookupPromises = [];
	for (let lookupID = 0; lookupID < 1000; lookupID++) {
		lookupPromises.push(resolver.lookup('banking', {
			countryCodes: ['US' as const],
		}));
	}

	const lookupResults = await Promise.all(lookupPromises);
	for (const lookupResult of lookupResults) {
		expect(lookupResult).toBeDefined();
		const operations = await lookupResult?.operations('object');
		const createAccount = await operations?.createAccount?.('string');
		expect(createAccount).toEqual('https://banchor.testaccountexternal.com/api/v1/createAccount');
	}
	expect(resolver.stats.reads).toBeGreaterThan(3000);
	expect(resolver.stats.cache.hit).toBeGreaterThan(resolver.stats.cache.miss);
	expect(resolver.stats.cache.miss).toBeLessThan(2000);
	expect(resolver.stats.keetanet.reads + resolver.stats.https.reads).toBe(resolver.stats.cache.miss);
}, 30000);
