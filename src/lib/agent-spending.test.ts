import { test, expect } from 'vitest';
import { KeetaNet } from '../client/index.js';
import { createNodeAndClient } from './utils/tests/node.js';
import { addAgentSpendingFunds, agentPay, agentSpendingClient, buildOpenAgentSpendingAccount, encodeAgentSpendingMetadata, getAgentSpendingAccount, listAgentSpendingAccounts, listAgentSpendingActivity, openAgentSpendingAccount, resolveAgentSpendingOwner, revokeAgentSpending } from './agent-spending.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
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
	expect(await listAgentSpendingAccounts(ownerClient, owner)).toHaveLength(1);
	await expect(addAgentSpendingFunds(ownerClient, { storage, funding: [ { token: usd, amount: 1n } ] })).rejects.toThrow(/revoked/);

	const afterRevoke = await listAgentSpendingActivity(ownerClient, storage);
	expect(afterRevoke.entries.some(function(entry) {
		return(entry.kind === 'returned' && entry.amount === 630n);
	})).toBe(true);
}, 60_000);
