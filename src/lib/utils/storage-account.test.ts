import { expect, test } from 'vitest';
import { KeetaNet } from '../../client/index.js';
import { createNodeAndClient } from './tests/node.js';
import { openAgentSpendingAccount } from '../agent-spending.js';
import { SignData } from './signing.js';
import { authenticateStorageAccountRequest } from './storage-account.js';

function newAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

test('authenticateStorageAccountRequest accepts the owner and allowed delegate operations only', async function() {
	const owner = newAccount();
	const agent = newAccount();
	const stranger = newAccount();
	await using nodeAndClient = await createNodeAndClient(owner);
	const ownerClient = nodeAndClient.userClient;
	const client = ownerClient.client;

	const { account: token } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await ownerClient.setInfo({ name: '', description: '', metadata: '', defaultPermission: new KeetaNet.lib.Permissions(['ACCESS'], []) }, { account: token });
	await ownerClient.modTokenSupplyAndBalance(100n, token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
	const { storage } = await openAgentSpendingAccount(ownerClient, { agent, funding: [{ token, amount: 10n }] });

	const signable = ['test:op', 'payload'];
	const permission = { operation: 'read', delegateOperations: ['read'] };

	const byOwner = await authenticateStorageAccountRequest(client, storage, signable, await SignData(owner, [storage, ...signable]), { operation: 'write', delegateOperations: ['read'] });
	expect(byOwner.isOwner).toBe(true);
	expect(byOwner.signer.comparePublicKey(owner)).toBe(true);

	const byAgent = await authenticateStorageAccountRequest(client, storage, signable, await SignData(agent, [storage, ...signable]), permission);
	expect(byAgent.isOwner).toBe(false);
	expect(byAgent.owner.comparePublicKey(owner)).toBe(true);
	expect(byAgent.signer.comparePublicKey(agent)).toBe(true);

	/* A delegate is held to the allow-list */
	await expect(authenticateStorageAccountRequest(client, storage, signable, await SignData(agent, [storage, ...signable]), { operation: 'write', delegateOperations: ['read'] })).rejects.toThrow('This operation is not available to storage account delegates');

	/* Someone with no grant, or a signature made without the storage account prefix, is refused */
	await expect(authenticateStorageAccountRequest(client, storage, signable, await SignData(stranger, [storage, ...signable]), permission)).rejects.toThrow('Invalid signature');
	await expect(authenticateStorageAccountRequest(client, storage, signable, await SignData(agent, signable), permission)).rejects.toThrow('Invalid signature');
});
