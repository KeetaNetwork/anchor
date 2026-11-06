import { test, expect } from 'vitest';
import { KeetaNet } from '../client/index.js';
import { createNodeAndClient } from './utils/tests/node.js';
import { agentPay, agentSpendingClient, openAgentSpendingAccount, resolveAgentSpendingOwner, revokeAgentSpending } from './agent-spending.js';

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
		funding: [ { token: usd, amount: 500n }, { token: ownerClient.baseToken, amount: 100n } ]
	});

	expect(funded.storage.isStorage()).toBe(true);
	expect(await ownerClient.balance(usdToken, { account: funded.storage })).toBe(500n);

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
