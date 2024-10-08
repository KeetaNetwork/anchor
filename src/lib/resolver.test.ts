import { test, expect, afterEach } from 'vitest';
import Resolver from './resolver.js';
import * as KeetaNetClient from '@keetapay/keetanet-client';
import { createTestNode } from '@keetapay/keetanet-node/dist/lib/utils/helper_testing.js';
import * as KeetaNetNode from '@keetapay/keetanet-node/dist/client';
import * as util from 'node:util';

const toCleanup: (() => Promise<void>)[] = [];
afterEach(async function() {
	await Promise.all(toCleanup.splice(0).map(async function(code) {
		await code();
	}));
});

/* XXX:TODO: Maybe this should be moved to a helper file ? */
async function createNodeAndClient(userAccount: InstanceType<typeof KeetaNetClient.lib.Account>, repAccountSeed?: string | bigint): Promise<{
	node: InstanceType<typeof KeetaNetNode.lib.Node>,
	client: InstanceType<typeof KeetaNetClient.Client>,
	userClient: InstanceType<typeof KeetaNetClient.UserClient>
}>;
async function createNodeAndClient(userAccount?: undefined, repAccountSeed?: string | bigint): Promise<{
	node: InstanceType<typeof KeetaNetNode.lib.Node>,
	client: InstanceType<typeof KeetaNetClient.Client>,
}>;
async function createNodeAndClient(userAccount?: InstanceType<typeof KeetaNetClient.lib.Account>, repAccountSeed?: string | bigint): Promise<{
	node: InstanceType<typeof KeetaNetNode.lib.Node>,
	client: InstanceType<typeof KeetaNetClient.Client>,
	userClient?: InstanceType<typeof KeetaNetClient.UserClient>
}>;
async function createNodeAndClient(userAccount?: InstanceType<typeof KeetaNetClient.lib.Account>, repAccountSeed?: string | bigint): Promise<{
	node: InstanceType<typeof KeetaNetNode.lib.Node>,
	client: InstanceType<typeof KeetaNetClient.Client>,
	userClient?: InstanceType<typeof KeetaNetClient.UserClient>
}> {
	if (repAccountSeed === undefined) {
		repAccountSeed = KeetaNetClient.lib.Account.generateRandomSeed({ asString: true });
	}

	const TestRepAccountNode = KeetaNetNode.lib.Account.fromSeed(repAccountSeed, 0);
	const TestRepAccountClient = KeetaNetClient.lib.Account.fromSeed(repAccountSeed, 0);

	const testNode = await createTestNode(TestRepAccountNode, {
		/*
		 * This does not work because it generates a Serial Number
		 * of 0, but does not tell the Ledger, so the next vote
		 * attempt will fail since it is a duplicate
		 */
		createInitialVoteStaple: false,
		nodeConfig: {
			nodeAlias: 'TEST'
		},
	});
	const testClient = new KeetaNetClient.Client([{
		endpoints: {
			// @ts-ignore
			api: testNode.config.endpoints?.api,
			// @ts-ignore
			p2p: testNode.config.endpoints?.p2p
		},
		key: TestRepAccountClient
	}]);

	toCleanup.push(async function() {
		await testNode.stop();
	});

	{
		/*
		 * Because "createInitialVoteStaple" is broken, we need to
		 * manually initialize the chain
		 */
		const itaUserClient = new KeetaNetClient.UserClient({
			client: testClient,
			network: testNode.config.network,
			networkAlias: testNode.config.networkAlias,
			// @ts-ignore
			signer: TestRepAccountClient,
			usePublishAid: false
		});
		await itaUserClient.initializeChain({
			addSupplyAmount: BigInt(1000),
			delegateTo: TestRepAccountClient,
			/* XXX: This is broken too, so we need to set it to a high number */
			voteSerial: BigInt('999999999999999999')
		}, {
			account: TestRepAccountClient,
			usePublishAid: false
		});
	}

	let userClient;
	if (userAccount) {
		userClient = new KeetaNetClient.UserClient({
			client: testClient,
			network: testNode.config.network,
			networkAlias: testNode.config.networkAlias,
			// @ts-ignore
			signer: userAccount,
			usePublishAid: false
		});

	}

	return({
		node: testNode,
		client: testClient,
		// @ts-ignore
		computeBuilderBlocks: async function(builder: ReturnType<typeof testClient['makeBuilder']>) {
			return(await testClient.computeBuilderBlocks(testNode.config.network, builder));
		},
		userClient
	});
}

test('Basic Tests', async function() {
	const TestAccountSeed = KeetaNetClient.lib.Account.generateRandomSeed();
	const TestAccount = KeetaNetClient.lib.Account.fromSeed(TestAccountSeed, 0);

	const { userClient } = await createNodeAndClient(TestAccount);

	await userClient.setInfo({
		name: 'TEST',
		description: 'TEST',
		metadata: 'TEST'
	});

	const resolver = new Resolver({
		root: TestAccount,
		client: userClient,
		trustedCAs: []
	});

	const check = await resolver.lookup('BANKING', {
		countryCodes: ['US']
	});

	expect(check).toBeDefined();
});
