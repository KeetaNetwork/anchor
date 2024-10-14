import { afterEach } from 'vitest';
import * as KeetaNetClient from '@keetapay/keetanet-client';
import { createTestNode } from '@keetapay/keetanet-node/dist/lib/utils/helper_testing.js';
import * as KeetaNetNode from '@keetapay/keetanet-node/dist/client';
import { assert } from 'typia';

const toCleanup: (() => Promise<void>)[] = [];
afterEach(async function() {
	await Promise.all(toCleanup.splice(0).map(async function(code) {
		await code();
	}));
});

type CreateNodeAndClientResponse = {
	node: InstanceType<typeof KeetaNetNode.lib.Node>,
	client: InstanceType<typeof KeetaNetClient.Client>,
	userClient?: InstanceType<typeof KeetaNetClient.UserClient>
};

type KeetaNetClientGenericAccount = NonNullable<ConstructorParameters<typeof KeetaNetClient.UserClient>[0]['signer']>;
type KeetaNetClientSeed = Parameters<typeof KeetaNetClient.lib.Account.fromSeed>[0];

/**
 * Create a KeetaNet Node instance as well as a client which can be used to
 * interact with the network.
 */
export async function createNodeAndClient(userAccount: KeetaNetClientGenericAccount, repAccountSeed?: KeetaNetClientSeed): Promise<Omit<CreateNodeAndClientResponse, 'userClient'> & Required<Pick<CreateNodeAndClientResponse, 'userClient'>>>;
export async function createNodeAndClient(userAccount?: undefined, repAccountSeed?: KeetaNetClientSeed): Promise<CreateNodeAndClientResponse>;
export async function createNodeAndClient(userAccount?: KeetaNetClientGenericAccount, repAccountSeed?: KeetaNetClientSeed): Promise<CreateNodeAndClientResponse>;
export async function createNodeAndClient(userAccount?: KeetaNetClientGenericAccount, repAccountSeed?: KeetaNetClientSeed): Promise<CreateNodeAndClientResponse> {
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

	const endpoints = assert<Required<NonNullable<typeof testNode.config.endpoints>>>(testNode.config.endpoints);

	const testClient = new KeetaNetClient.Client([{
		endpoints: endpoints,
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
		userClient: userClient
	});
}

