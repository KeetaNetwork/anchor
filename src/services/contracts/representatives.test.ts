/**
 * The sequencer on a network of two representatives with half the voting
 * weight each, so every staple needs both votes: a representative that is
 * behind, a refused call, and a caller forking its chain between the
 * quotes and the votes.
 */
import { afterEach, expect } from 'vitest';
import { createTestNode, testingNetworkId } from '@keetanetwork/keetanet-node/dist/lib/utils/helper_testing.js';
import type { LocalNodeWithPrivateKey } from '@keetanetwork/keetanet-node/dist/lib/utils/helper_testing.js';
import { generateInitialVoteStaple } from '@keetanetwork/keetanet-node/dist/lib/utils/initial.js';
import type { BlockJSONOperations } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import { KeetaNet } from '../../client/index.js';
import { KeetaNetContractsAnchorHTTPServer } from './server.js';
import KeetaContractsAnchorClient, { KeetaContractsAnchorProvider } from './client.js';
import { stateId } from './common.js';
import type { Buffer } from '../../lib/utils/buffer.js';
import type { Account, KeyPairAccount } from './test-utils.js';
import { contractTest, instruction, logger, probe, program } from './test-utils.js';

type Block = InstanceType<typeof KeetaNet.lib.Block>;
type VoteStaple = InstanceType<typeof KeetaNet.lib.Vote.Staple>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async function() {
	for (const stop of cleanup.splice(0).reverse()) {
		await stop();
	}
});

interface Network {
	nodes: LocalNodeWithPrivateKey[];
	client: InstanceType<typeof KeetaNet.Client>;
	sequencer: KeyPairAccount;
	server: KeetaNetContractsAnchorHTTPServer;
	/** Blocks signed by `signer` on `account`'s chain (its own by default), extending the head */
	block(signer: KeyPairAccount, operations: BlockJSONOperations[], account?: Account): Promise<Block>;
	/** Votes from every representative, applied to `to` (every representative by default) */
	staple(blocks: Block[], to?: LocalNodeWithPrivateKey[]): Promise<VoteStaple>;
	deploy(creator: KeyPairAccount, code: Buffer): Promise<string>;
	/** The sequencer as `account` reaches it, with its contracts client */
	as(account: KeyPairAccount): { contracts: KeetaContractsAnchorClient; provider: KeetaContractsAnchorProvider; };
}

async function network(): Promise<Network> {
	const seed = KeetaNet.lib.Account.generateRandomSeed();
	const account = (index: number) => KeetaNet.lib.Account.fromSeed(seed, index);
	const [repA, repB, trusted, holder, sequencer] = [0, 1, 100, 101, 102].map(account);
	if (repA === undefined || repB === undefined || trusted === undefined || holder === undefined || sequencer === undefined) {
		throw(new Error('accounts'));
	}

	const nodes: LocalNodeWithPrivateKey[] = [];
	for (const rep of [repA, repB]) {
		const node = await createTestNode(rep, { initialTrustedAccount: trusted });
		cleanup.push(async () => await node.stop());
		nodes.push(node);
	}
	const [first] = nodes;
	if (first === undefined) {
		throw(new Error('no representative'));
	}

	async function block(signer: KeyPairAccount, operations: BlockJSONOperations[], chain: Account = signer): Promise<Block> {
		const head = await first?.ledger.getHeadBlock(chain, 'main');
		return(await new KeetaNet.lib.Block.Builder({ account: chain, signer, previous: head?.hash ?? KeetaNet.lib.Block.NO_PREVIOUS, network: testingNetworkId, operations }).seal());
	}
	async function staple(blocks: Block[], to: LocalNodeWithPrivateKey[] = nodes): Promise<VoteStaple> {
		const temporary = [];
		for (const node of nodes) {
			temporary.push(await node.ledger.vote(blocks));
		}
		const permanent = [];
		for (const node of nodes) {
			permanent.push(await node.ledger.vote(blocks, temporary));
		}
		const voteStaple = KeetaNet.lib.Vote.Staple.fromVotesAndBlocks(permanent, blocks);
		for (const node of to) {
			await node.ledger.add(voteStaple);
		}
		return(voteStaple);
	}

	// Half the weight to each representative.
	const initial = await generateInitialVoteStaple({ initialTrustedAccount: trusted, network: testingNetworkId, addSupply: { recipient: trusted, delegate: true, delegateTo: repA, amount: 1_000n }});
	for (const node of nodes) {
		await node.ledger.add(initial.voteStaple);
	}
	const baseToken = first.ledger.baseToken.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await staple([await block(trusted, [{ type: KeetaNet.lib.Block.OperationType.SEND, to: holder, token: baseToken, amount: 500n }])]);
	await staple([await block(holder, [{ type: KeetaNet.lib.Block.OperationType.SET_REP, to: repB }])]);

	const client = new KeetaNet.Client(nodes.map((node, index) => ({ endpoints: { api: node.config.endpoints?.api ?? '', p2p: node.config.endpoints?.p2p ?? '' }, key: [repA, repB][index] ?? repA })));
	cleanup.push(async () => await client.destroy());
	await client.updateReps(true);
	const userClient = (signer: KeyPairAccount) => new KeetaNet.UserClient({ client, signer, usePublishAid: false, network: testingNetworkId, networkAlias: first.config.networkAlias });

	const server = new KeetaNetContractsAnchorHTTPServer({ logger, sequencer, client: userClient(sequencer), catchUpMs: 3_000 });
	await server.start();
	cleanup.push(async () => await server[Symbol.asyncDispose]());

	return({
		nodes,
		client,
		sequencer,
		server,
		block,
		staple,
		async deploy(creator, code) {
			const head = await first.ledger.getHeadBlock(creator, 'main');
			const contract = creator.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE, head?.hash ?? KeetaNet.lib.Block.NO_PREVIOUS, 0);
			await staple([await block(creator, [{ type: KeetaNet.lib.Block.OperationType.CONTRACT_DEPLOY, contract, code, sequencer }])]);
			return(contract.publicKeyString.get());
		},
		as(caller) {
			const contracts = new KeetaContractsAnchorClient(userClient(caller), { root: sequencer, account: caller, logger });
			const provider = new KeetaContractsAnchorProvider('test', { sequencer: sequencer.publicKeyString.get(), operations: { submit: new URL('/api/submit', server.url).toString() }}, contracts);
			return({ contracts, provider });
		}
	});
}

function newAccount(): KeyPairAccount {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

contractTest('the sequencer waits for a representative that is behind, instead of failing the call', async () => {
	const on = await network();
	const [nodeA, nodeB] = on.nodes;
	const alice = newAccount();
	const contract = await on.deploy(alice, program('keeta_probe'));
	const { contracts, provider } = on.as(alice);

	// Alice's latest block reaches one representative now and the other a moment later.
	const latest = await on.block(alice, [{ type: KeetaNet.lib.Block.OperationType.SET_REP, to: on.sequencer }]);
	const late = await on.staple([latest], nodeA === undefined ? [] : [nodeA]);
	contracts.published(latest);
	setTimeout(() => {
		// It may have fetched the block itself by then.
		nodeB?.ledger.add(late).catch(() => undefined);
	}, 500);

	const result = await provider.call({ instruction: instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0)) });
	expect(result.writes[0]?.version).toBe(1n);
	for (const node of on.nodes) {
		expect((await node.ledger.getContractState(KeetaNet.lib.Account.fromPublicKeyString(contract), stateId('counter'))).version).toBe(1n);
	}
}, 120_000);

contractTest('a call its contract refuses lands as a failed call, holding no chain', async () => {
	const on = await network();
	const alice = newAccount();
	const contract = await on.deploy(alice, program('keeta_probe'));
	const { provider } = on.as(alice);

	await expect(provider.call({ instruction: instruction(contract, [], probe.fail('not today')) })).rejects.toThrow(/not today/u);
	expect(await on.client.getPendingBlock(KeetaNet.lib.Account.fromPublicKeyString(contract))).toBeNull();
	expect(await on.client.getPendingBlock(alice)).toBeNull();

	// The next call needs no waiting.
	const started = Date.now();
	const result = await provider.call({ instruction: instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0)) });
	expect(result.writes[0]?.version).toBe(1n);
	expect(Date.now() - started).toBeLessThan(3_000);
}, 120_000);

contractTest('a caller forking its chain between the quotes and the votes holds the contract only until the votes expire', async () => {
	const on = await network();
	const [, nodeB] = on.nodes;
	const [alice, bob] = [newAccount(), newAccount()];
	const contract = await on.deploy(alice, program('keeta_probe'));
	const counter = instruction(contract, [{ name: 'counter', writable: true }], probe.increment(0));

	// Bob's call passes the quotes; then, before the votes, he gets one
	// representative to vote for a competing block on his chain.
	const original = on.client.voteEach.bind(on.client);
	let forked = false;
	on.client.voteEach = async (...args: Parameters<typeof original>) => {
		if (!forked) {
			forked = true;
			await nodeB?.ledger.vote([await on.block(bob, [{ type: KeetaNet.lib.Block.OperationType.SET_REP, to: on.sequencer }])]);
		}
		return(await original(...args));
	};
	await expect(on.as(bob).provider.call({ instruction: counter })).rejects.toThrow(/successor/u);

	// Bob is refused for a while, without waiting.
	await expect(on.as(bob).provider.call({ instruction: counter })).rejects.toThrow(/forked its chain/u);

	// The other representative's vote holds the contract's chain until it
	// expires (10 s, plus the minute of slop votes get for clock skew); the
	// sequencer waits that out rather than build a competing ordering it
	// would refuse.
	const started = Date.now();
	const result = await on.as(alice).provider.call({ instruction: counter });
	expect(result.writes[0]?.version).toBe(1n);
	expect(Date.now() - started).toBeGreaterThan(55_000);
	expect(Date.now() - started).toBeLessThan(90_000);
}, 180_000);
