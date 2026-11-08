import { test, expect, vi } from 'vitest';
import { KeetaNet } from '../client/index.js';
import { createNodeAndClient } from './utils/tests/node.js';
import { addAgentSpendingFunds, agentPay, agentSpendingClient, buildOpenAgentSpendingAccount, encodeAgentSpendingMetadata, getAgentSpendingAccount, listAgentSpendingAccounts, listAgentSpendingActivity, openAgentSpendingAccount, resolveAgentSpendingOwner, revokeAgentSpending } from './agent-spending.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

function clientFor(anyClient: InstanceType<typeof KeetaNet.UserClient>, account: ReturnType<typeof newAccount>) {
	return(new KeetaNet.UserClient({
		client: anyClient.client,
		network: anyClient.network,
		networkAlias: anyClient.config.networkAlias,
		account,
		signer: account,
		usePublishAid: false
	}));
}

/*
 * The whole chain with no UI and no mocks: open and fund storage, grant the
 * agent, the agent pays within the cap, the cap holds, revoke, the agent's
 * next payment is refused and the leftover goes back to the owner.
 */
test('agent spends from an owner-funded storage account until revoked', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const merchant = newAccount();

	await using nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;

	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(10_000n, usdToken);

	/* The base token pays network fees for blocks the agent publishes */
	await nodeAndClient.give(owner, 200n);
	const funded = await openAgentSpendingAccount(ownerClient, {
		agent,
		funding: [ { token: usd, amount: 500n }, { token: ownerClient.baseToken, amount: 100n } ],
		name: 'Shopping agent'
	});

	expect(funded.storage.isStorage()).toBe(true);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(500n);

	/* Created like a Keeta Wallet pocket, so the wallet can show it */
	const { info } = await ownerClient.client.getAccountInfo(funded.storage);
	expect(info.name).toBe('');
	expect(info.description).toBe('Shopping agent');
	expect(atob(info.metadata)).toMatch(/^\{"createdAt":\d+\}$/);

	/* Payments from storage carry the owner's identity */
	const resolvedOwner = await resolveAgentSpendingOwner(ownerClient, funded.storage);
	expect(resolvedOwner.comparePublicKey(owner)).toBe(true);

	/* The agent pays with its own key */
	const agentClient = agentSpendingClient(ownerClient, funded.storage, agent);
	await agentPay(agentClient, merchant, 200n, usd);
	expect(await ownerClient.balance(usdToken, { account: merchant })).toBe(200n);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(300n);

	/* The balance is the cap */
	await expect(agentPay(agentClient, merchant, 301n, usd)).rejects.toThrow(/balance becomes negative/);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(300n);

	/* A stranger's key cannot spend from it */
	const strangerClient = agentSpendingClient(ownerClient, funded.storage, newAccount());
	await expect(agentPay(strangerClient, merchant, 1n, usd)).rejects.toThrow(/does not have required permissions/);

	/* Revoke: grant removed, leftover returned, earlier payments stand */
	const ownerBefore = await ownerClient.balance(usdToken);
	const { returned } = await revokeAgentSpending(ownerClient, { agent, storage: funded.storage, tokens: [ usd ] });
	expect(returned).toHaveLength(1);
	expect(returned[0]?.amount).toBe(300n);
	expect(await ownerClient.balance(usdToken)).toBe(ownerBefore + 300n);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(0n);
	expect(await ownerClient.balance(usdToken, { account: merchant })).toBe(200n);

	/* Refund the storage so the refusal is about the grant, not the balance */
	await ownerClient.send(funded.storage, 50n, usdToken);
	await expect(agentPay(agentClient, merchant, 10n, usd)).rejects.toThrow(/does not have required permissions/);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(50n);
}, 60_000);

/*
 * What a wallet needs: open in one publish with a name, find the owner's
 * agents, add funds, read the payments, and see the account as revoked with
 * what came back.
 */
test('owner lists, funds, reads and revokes agent spending accounts', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const merchant = newAccount();

	await using nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;

	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(10_000n, usdToken);
	await nodeAndClient.give(owner, 200n);

	expect(await listAgentSpendingAccounts(ownerClient, owner)).toHaveLength(0);

	/* A plain pocket, never granted to an agent, is not an agent */
	const pocketBuilder = ownerClient.initBuilder();
	const pocket = pocketBuilder.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	await pocketBuilder.computeBlocks();
	pocketBuilder.setInfo({ name: '', description: 'Savings', metadata: encodeAgentSpendingMetadata({ createdAt: new Date() }), defaultPermission: new KeetaNet.lib.Permissions(['STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT']) }, { account: pocket.account });
	await ownerClient.publishBuilder(pocketBuilder);
	expect(await listAgentSpendingAccounts(ownerClient, owner)).toHaveLength(0);

	const builder = ownerClient.initBuilder();
	const { storage } = await buildOpenAgentSpendingAccount(builder, {
		agent,
		name: 'Shopping agent',
		funding: [ { token: usd, amount: 500n }, { token: ownerClient.baseToken, amount: 20n } ]
	});
	const published = await ownerClient.publishBuilder(builder);
	const publishedBlocks = 'voteStaple' in published ? published.voteStaple.blocks : published.blocks;
	/* One publish, every block signed by the owner: one wallet signature */
	expect(publishedBlocks.every(function(block) {
		const signer = block.signer;
		return(!Array.isArray(signer) && signer.comparePublicKey(owner));
	})).toBe(true);

	const listed = await listAgentSpendingAccounts(ownerClient, owner);
	expect(listed).toHaveLength(1);
	const first = listed[0];
	expect(first?.storage.comparePublicKey(storage)).toBe(true);
	expect(first?.agent.comparePublicKey(agent)).toBe(true);
	expect(first?.name).toBe('Shopping agent');
	expect(first?.active).toBe(true);
	expect(first?.funded.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(500n);

	const agentClient = agentSpendingClient(ownerClient, storage, agent);
	await agentPay(agentClient, merchant, 120n, usd, 'order-1');

	await addAgentSpendingFunds(ownerClient, { storage, funding: [ { token: usd, amount: 250n } ] });
	const afterFunds = await getAgentSpendingAccount(ownerClient, storage);
	expect(afterFunds?.funded.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(750n);
	expect(afterFunds?.revokedAt).toBeUndefined();
	expect(await ownerClient.balance(usdToken, { account: storage })).toBe(630n);

	/* A grant scoped to one token is not the agent's grant */
	const scoped = newAccount();
	await ownerClient.updatePermissions(scoped, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), usd, undefined, { account: storage });
	const afterScopedGrant = await getAgentSpendingAccount(ownerClient, storage);
	expect(afterScopedGrant?.agent.comparePublicKey(agent)).toBe(true);
	expect(afterScopedGrant?.active).toBe(true);

	const activity = await listAgentSpendingActivity(ownerClient, storage);
	const payments = activity.entries.filter(function(entry) {
		return(entry.kind === 'payment');
	});
	expect(payments).toHaveLength(1);
	expect(payments[0]?.amount).toBe(120n);
	expect(payments[0]?.counterparty.comparePublicKey(merchant)).toBe(true);
	expect(payments[0]?.external).toBe('order-1');
	expect(activity.entries.filter(function(entry) {
		return(entry.kind === 'funded' && entry.token.comparePublicKey(usd));
	}).map(function(entry) {
		return(entry.amount);
	}).sort()).toEqual([ 250n, 500n ]);

	const { returned } = await revokeAgentSpending(ownerClient, { agent, storage });
	expect(returned.find(function(entry) {
		return(entry.token.comparePublicKey(usd));
	})?.amount).toBe(630n);

	const revoked = await getAgentSpendingAccount(ownerClient, storage);
	expect(revoked?.active).toBe(false);
	expect(revoked?.revokedAt).toBeInstanceOf(Date);
	expect(revoked?.returned.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(630n);
	expect(revoked?.agent.comparePublicKey(agent)).toBe(true);
	expect(revoked?.truncated).toBe(false);
	expect(await listAgentSpendingAccounts(ownerClient, owner)).toHaveLength(1);
	await expect(addAgentSpendingFunds(ownerClient, { storage, funding: [ { token: usd, amount: 1n } ] })).rejects.toThrow(/revoked/);

	const afterRevoke = await listAgentSpendingActivity(ownerClient, storage);
	expect(afterRevoke.entries.some(function(entry) {
		return(entry.kind === 'returned' && entry.amount === 630n);
	})).toBe(true);

	/* A stranger's deposit is a deposit, not the owner's funding */
	const stranger = newAccount();
	await ownerClient.send(stranger, 5n, usdToken);
	await nodeAndClient.give(stranger, 10n);
	await clientFor(ownerClient, stranger).send(storage, 5n, usdToken);
	const afterDeposit = await listAgentSpendingActivity(ownerClient, storage);
	expect(afterDeposit.entries[0]?.kind).toBe('deposit');
	expect(afterDeposit.entries[0]?.counterparty.comparePublicKey(stranger)).toBe(true);
	expect((await getAgentSpendingAccount(ownerClient, storage))?.funded.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(750n);
}, 60_000);

async function setUpSpending(nodeAndClient: Awaited<ReturnType<typeof createNodeAndClient>>, owner: ReturnType<typeof newAccount>, agent: ReturnType<typeof newAccount>) {
	const ownerClient = nodeAndClient.userClient;
	if (ownerClient === undefined) {
		throw(new Error('No owner client'));
	}

	const { account: usd } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const usdToken = usd.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: usd });
	await ownerClient.modTokenSupplyAndBalance(10_000n, usdToken);
	await nodeAndClient.give(owner, 200n);
	const { storage } = await openAgentSpendingAccount(ownerClient, {
		agent,
		funding: [ { token: usd, amount: 500n }, { token: ownerClient.baseToken, amount: 50n } ],
		name: 'Agent'
	});

	return({ ownerClient, usd, usdToken, storage });
}

/*
 * The revoke must not hang on the sweep: the agent pays between the
 * balance read and the publish, so the combined publish fails, and the
 * grant still goes.
 */
test('revoke holds when the agent pays between the balance read and the publish', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const merchant = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const { ownerClient, usd, usdToken, storage } = await setUpSpending(nodeAndClient, owner, agent);

	const agentClient = agentSpendingClient(ownerClient, storage, agent);
	const publish = ownerClient.publishBuilder.bind(ownerClient);
	const spy = vi.spyOn(ownerClient, 'publishBuilder').mockImplementationOnce(async function(builder) {
		await agentPay(agentClient, merchant, 100n, usd);
		return(await publish(builder));
	});

	const ownerBefore = await ownerClient.balance(usdToken);
	const { returned, unswept } = await revokeAgentSpending(ownerClient, { agent, storage, tokens: [ usd ] });
	spy.mockRestore();

	expect(returned).toHaveLength(1);
	expect(returned[0]?.amount).toBe(400n);
	expect(unswept).toHaveLength(0);
	expect(await ownerClient.balance(usdToken)).toBe(ownerBefore + 400n);
	expect(await ownerClient.balance(usdToken, { account: merchant })).toBe(100n);
	expect((await getAgentSpendingAccount(ownerClient, storage))?.active).toBe(false);

	await ownerClient.send(storage, 10n, usdToken);
	await expect(agentPay(agentClient, merchant, 1n, usd)).rejects.toThrow(/does not have required permissions/);

	/*
	 * The combined publish lands but the client sees an error (a timeout,
	 * say): the revoke-only retry is refused, and the result still reports
	 * success because the grant is gone.
	 */
	const second = newAccount();
	await ownerClient.updatePermissions(second, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, undefined, { account: storage });
	const lost = vi.spyOn(ownerClient, 'publishBuilder').mockImplementationOnce(async function(builder) {
		await publish(builder);
		throw(new Error('timeout'));
	});
	const afterTimeout = await revokeAgentSpending(ownerClient, { agent: second, storage, tokens: [ usd ] });
	lost.mockRestore();
	expect(afterTimeout.unswept).toHaveLength(0);
	expect((await getAgentSpendingAccount(ownerClient, storage))?.active).toBe(false);
}, 60_000);

/*
 * Anyone can deposit any token into the storage account.  A token the
 * owner cannot receive is left behind by the default sweep instead of
 * failing the revoke.
 */
test('default sweep skips a deposited token the owner cannot receive', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const stranger = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const { ownerClient, usd, usdToken, storage } = await setUpSpending(nodeAndClient, owner, agent);

	await nodeAndClient.give(stranger, 100n);
	const strangerClient = clientFor(ownerClient, stranger);
	const { account: poison } = await strangerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	const poisonToken = poison.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await strangerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions([], []) }, { account: poison });
	await strangerClient.modTokenSupplyAndBalance(1_000n, poisonToken);
	await strangerClient.updatePermissions(storage, new KeetaNet.lib.Permissions(['ACCESS']), undefined, undefined, { account: poison });
	await strangerClient.send(storage, 7n, poisonToken);
	expect(await ownerClient.balance(poisonToken, { account: storage })).toBe(7n);

	/* The owner really cannot receive it */
	await expect(ownerClient.send(owner, 0n, poisonToken, undefined, { account: storage })).rejects.toThrow();

	const ownerBefore = await ownerClient.balance(usdToken);
	const publishes = vi.spyOn(ownerClient, 'publishBuilder');
	const { returned, unswept } = await revokeAgentSpending(ownerClient, { agent, storage });
	/* Skipped up front, so the one-signature publish went through */
	expect(publishes).toHaveBeenCalledTimes(1);
	publishes.mockRestore();
	expect(returned.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(500n);
	expect(unswept).toHaveLength(1);
	expect(unswept[0]?.token.comparePublicKey(poison)).toBe(true);
	expect(unswept[0]?.amount).toBe(7n);
	expect(await ownerClient.balance(usdToken)).toBe(ownerBefore + 500n);
	expect((await getAgentSpendingAccount(ownerClient, storage))?.active).toBe(false);
}, 60_000);

/*
 * The agent comes from the ACLs, so a busy account is still found when the
 * history walk stops at its bound, and the totals say they are partial.
 */
test('agent and grant are read from ACLs past the history bound', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const replacement = newAccount();
	const merchant = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const { ownerClient, usd, storage } = await setUpSpending(nodeAndClient, owner, agent);

	const agentClient = agentSpendingClient(ownerClient, storage, agent);
	for (let payment = 0; payment < 3; payment++) {
		await agentPay(agentClient, merchant, 10n, usd);
	}

	/* Activity pages stop at the page size and continue from the cursor */
	const firstPage = await listAgentSpendingActivity(ownerClient, storage, { pageSize: 2 });
	expect(firstPage.nextCursor).toBeDefined();
	const secondPage = await listAgentSpendingActivity(ownerClient, storage, { pageSize: 2, ...(firstPage.nextCursor !== undefined ? { startBlocksHash: firstPage.nextCursor } : {}) });
	const firstHashes = new Set(firstPage.entries.map(function(entry) { return(entry.blockHash); }));
	expect(secondPage.entries.length).toBeGreaterThan(0);
	expect(secondPage.entries.some(function(entry) { return(firstHashes.has(entry.blockHash)); })).toBe(false);

	const bounds = { pageSize: 1, pageLimit: 2 };
	const busy = await getAgentSpendingAccount(ownerClient, storage, bounds);
	expect(busy?.agent.comparePublicKey(agent)).toBe(true);
	expect(busy?.active).toBe(true);
	expect(busy?.truncated).toBe(true);
	expect(await listAgentSpendingAccounts(ownerClient, owner, bounds)).toHaveLength(1);

	const full = await getAgentSpendingAccount(ownerClient, storage);
	expect(full?.truncated).toBe(false);
	expect(full?.funded.find(function(entry) { return(entry.token.comparePublicKey(usd)); })?.amount).toBe(500n);

	/* One publish revokes the agent and grants another: the new one is the agent */
	const builder = ownerClient.initBuilder();
	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, KeetaNet.lib.Block.AdjustMethod.SUBTRACT, { account: storage });
	builder.updatePermissions(replacement, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, KeetaNet.lib.Block.AdjustMethod.ADD, { account: storage });
	await ownerClient.publishBuilder(builder);

	const swapped = await getAgentSpendingAccount(ownerClient, storage);
	expect(swapped?.agent.comparePublicKey(replacement)).toBe(true);
	expect(swapped?.active).toBe(true);

	/* Revoked, the history names the latest agent */
	await revokeAgentSpending(ownerClient, { agent: replacement, storage, sweep: false });
	const revoked = await getAgentSpendingAccount(ownerClient, storage);
	expect(revoked?.agent.comparePublicKey(replacement)).toBe(true);
	expect(revoked?.active).toBe(false);
	expect(revoked?.revokedAt).toBeInstanceOf(Date);
}, 60_000);
