/**
 * Agent spending accounts.
 *
 * Lets a KYC'd owner (a Business or an individual) give a software agent the
 * power to spend on its behalf, within a hard cap, without either side
 * handing over its key:
 *
 *  - The owner creates a storage account it owns and funds it.  The balance
 *    is the spending cap: the network refuses any send beyond it.
 *  - The owner grants the agent's own account SEND_ON_BEHALF on that storage
 *    account.  The agent signs with its own key.
 *  - Identity checks on the storage account resolve to its owner (see
 *    `resolveStorageAccountOwner`), so payments carry the owner's KYC/KYB.
 *  - Revoking removes the grant and sweeps the leftover balance back to the
 *    owner.  Payments already made stay made.
 *
 * This is a skeleton: each function is the smallest working version of a
 * layer in the build map.  Recurring caps, expiry and merchant scope are not
 * enforced here because the network cannot enforce them yet (node#680).
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { resolveStorageAccountOwner } from './utils/storage-account.js';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type Account = InstanceType<typeof KeetaNet.lib.Account>;

export type AgentSpendingFunding = {
	token: Account;
	amount: bigint;
};

export type OpenAgentSpendingAccountOptions = {
	/**
	 * The agent's own account.  Only its public key is needed; the owner
	 * never sees the agent's private key.
	 */
	agent: Account;

	/**
	 * Tokens to fund the storage account with.  Each token is also
	 * allowed to be held by the storage account.
	 */
	funding: AgentSpendingFunding[];
};

export type AgentSpendingAccount = {
	storage: Account;
	owner: Account;
	agent: Account;
};

/**
 * Open and fund a storage account owned by `ownerClient`'s account and grant
 * `agent` the right to spend from it.
 *
 * Today this is two publishes (create, then configure and fund).  Layer 3 of
 * the build map collapses it to one wallet signature.
 */
export async function openAgentSpendingAccount(ownerClient: UserClient, options: OpenAgentSpendingAccountOptions): Promise<AgentSpendingAccount> {
	const { agent, funding } = options;

	if (!agent.isAccount()) {
		throw(new Error('Agent must be a keyed account'));
	}

	if (funding.length === 0) {
		throw(new Error('At least one funding entry is required'));
	}

	const { account: storage } = await ownerClient.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);

	const builder = ownerClient.initBuilder();

	for (const { token } of funding) {
		builder.updatePermissions(token, new KeetaNet.lib.Permissions(['STORAGE_CAN_HOLD']), undefined, undefined, { account: storage });
	}

	builder.setInfo({
		name: '',
		description: '',
		metadata: '',
		defaultPermission: new KeetaNet.lib.Permissions(['STORAGE_DEPOSIT'])
	}, { account: storage });

	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, undefined, { account: storage });

	for (const { token, amount } of funding) {
		if (amount <= 0n) {
			throw(new Error('Funding amounts must be positive'));
		}

		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		builder.send(storage, amount, tokenAccount);
	}

	await ownerClient.publishBuilder(builder);

	return({
		storage,
		owner: ownerClient.account,
		agent
	});
}

/**
 * Build a client for the agent that spends from the storage account and
 * signs with the agent's own key.
 */
export function agentSpendingClient(ownerOrAnyClient: UserClient, storage: Account, agentSigner: Account): UserClient {
	if (!agentSigner.isAccount() || !agentSigner.hasPrivateKey) {
		throw(new Error('Agent signer must be a keyed account holding its private key'));
	}

	return(new KeetaNet.UserClient({
		client: ownerOrAnyClient.client,
		network: ownerOrAnyClient.network,
		networkAlias: ownerOrAnyClient.config.networkAlias,
		account: storage,
		signer: agentSigner,
		usePublishAid: false
	}));
}

/**
 * Pay a merchant from the storage account, as the agent.
 *
 * The network enforces the balance cap and the SEND_ON_BEHALF grant.  Merchant
 * allow-lists, per-payment limits and expiry belong to later layers.
 */
export async function agentPay(agentClient: UserClient, to: Account, amount: bigint, token: Account, external?: string): Promise<void> {
	const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
	await agentClient.send(to, amount, tokenAccount, external);
}

export type RevokeAgentSpendingOptions = {
	agent: Account;
	storage: Account;
	/** Tokens to sweep back to the owner. */
	tokens: Account[];
};

/**
 * Remove the agent's grant and return the leftover balance to the owner, in
 * one publish so the agent cannot race a payment in between.
 */
export async function revokeAgentSpending(ownerClient: UserClient, options: RevokeAgentSpendingOptions): Promise<{ returned: { token: Account; amount: bigint; }[]; }> {
	const { agent, storage, tokens } = options;

	const builder = ownerClient.initBuilder();

	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, KeetaNet.lib.Block.AdjustMethod.SUBTRACT, { account: storage });

	const returned: { token: Account; amount: bigint; }[] = [];
	for (const token of tokens) {
		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		const amount = await ownerClient.balance(tokenAccount, { account: storage });
		if (amount <= 0n) {
			continue;
		}

		builder.send(ownerClient.account, amount, tokenAccount, undefined, { account: storage });
		returned.push({ token, amount });
	}

	await ownerClient.publishBuilder(builder);

	return({ returned });
}

/**
 * Whose identity a payment from `storage` carries.  Merchants and anchors call
 * this to find the KYC'd owner behind an agent's payment.
 */
export async function resolveAgentSpendingOwner(client: UserClient | InstanceType<typeof KeetaNet.Client>, storage: Account): Promise<Account> {
	const base = 'client' in client ? client.client : client;
	return(await resolveStorageAccountOwner(base, storage));
}
