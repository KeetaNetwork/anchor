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
 * Each operation comes in two forms: a `build*` function that adds the
 * operations to a builder the caller publishes (so a wallet can show the fee
 * and ask for one signature), and a convenience function that builds and
 * publishes with a UserClient.
 *
 * Recurring caps, expiry and merchant scope are not enforced here because the
 * network cannot enforce them yet (node#680).
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { StorageAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { resolveStorageAccountOwner } from './utils/storage-account.js';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type Client = InstanceType<typeof KeetaNet.Client>;
type Account = InstanceType<typeof KeetaNet.lib.Account>;
type Builder = ReturnType<UserClient['initBuilder']>;
type StorageAccount = StorageAddress;

export type AgentSpendingFunding = {
	token: Account;
	amount: bigint;
};

/**
 * What the owner's wallet remembers about an agent spending account.  It is
 * stored in the storage account's metadata so any client of the owner (a
 * wallet, an agent tool) can list and describe the owner's agents.
 *
 * `funded` is the total the owner moved in; it is bookkeeping, not a limit the
 * network enforces.  The balance is the only enforced cap.
 */
export type AgentSpendingMetadata = {
	kind: 'agent-spending';
	version: 1;
	agent: string;
	createdAt: number;
	funded: { [token: string]: string; };
	revokedAt?: number;
	returned?: { [token: string]: string; };
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

	/**
	 * A label for the owner's own use.  It is public on the network, so it
	 * should not contain anything private.
	 */
	name?: string;

	/** Defaults to now */
	createdAt?: Date;
};

export type AgentSpendingAccount = {
	storage: Account;
	owner: Account;
	agent: Account;
};

const AGENT_SPENDING_DEFAULT_PERMISSION = ['STORAGE_DEPOSIT'] as const;

function toUnixSeconds(date: Date): number {
	return(Math.floor(date.getTime() / 1000));
}

export function encodeAgentSpendingMetadata(metadata: AgentSpendingMetadata): string {
	const bytes = new TextEncoder().encode(JSON.stringify(metadata));
	return(btoa(String.fromCharCode(...bytes)));
}

function isStringRecord(value: unknown): value is { [key: string]: string; } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return(false);
	}

	return(Object.values(value).every(function(entry) {
		return(typeof entry === 'string');
	}));
}

/**
 * Decode the metadata of a storage account, or return null when it is not an
 * agent spending account.
 */
export function decodeAgentSpendingMetadata(metadata: string): AgentSpendingMetadata | null {
	if (metadata === '') {
		return(null);
	}

	let parsed: unknown;
	try {
		const bytes = Uint8Array.from(atob(metadata), function(char) {
			return(char.charCodeAt(0));
		});
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return(null);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return(null);
	}

	if (!('kind' in parsed) || parsed.kind !== 'agent-spending') {
		return(null);
	}

	if (!('version' in parsed) || parsed.version !== 1) {
		return(null);
	}

	if (!('agent' in parsed) || typeof parsed.agent !== 'string') {
		return(null);
	}

	if (!('createdAt' in parsed) || typeof parsed.createdAt !== 'number') {
		return(null);
	}

	if (!('funded' in parsed) || !isStringRecord(parsed.funded)) {
		return(null);
	}

	const retval: AgentSpendingMetadata = {
		kind: 'agent-spending',
		version: 1,
		agent: parsed.agent,
		createdAt: parsed.createdAt,
		funded: parsed.funded
	};

	if ('revokedAt' in parsed && typeof parsed.revokedAt === 'number') {
		retval.revokedAt = parsed.revokedAt;
	}

	if ('returned' in parsed && isStringRecord(parsed.returned)) {
		retval.returned = parsed.returned;
	}

	return(retval);
}

function addAmounts(base: { [token: string]: string; }, funding: AgentSpendingFunding[]): { [token: string]: string; } {
	const retval = { ...base };
	for (const { token, amount } of funding) {
		const key = token.publicKeyString.get();
		retval[key] = (BigInt(retval[key] ?? '0') + amount).toString();
	}

	return(retval);
}

function assertFunding(funding: AgentSpendingFunding[]): void {
	if (funding.length === 0) {
		throw(new Error('At least one funding entry is required'));
	}

	for (const { amount } of funding) {
		if (amount <= 0n) {
			throw(new Error('Funding amounts must be positive'));
		}
	}
}

/**
 * Add the operations that open, fund and grant an agent spending account to
 * `builder`.  The builder's account is the owner.  Everything lands in one
 * publish, so a wallet asks for a single signature.
 */
export async function buildOpenAgentSpendingAccount(builder: Builder, options: OpenAgentSpendingAccountOptions): Promise<{ storage: StorageAccount; }> {
	const { agent, funding } = options;

	if (!agent.isAccount()) {
		throw(new Error('Agent must be a keyed account'));
	}

	assertFunding(funding);

	const pending = builder.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	await builder.computeBlocks();
	const storage = pending.account;

	for (const { token } of funding) {
		builder.updatePermissions(token, new KeetaNet.lib.Permissions(['STORAGE_CAN_HOLD']), undefined, undefined, { account: storage });
	}

	const metadata: AgentSpendingMetadata = {
		kind: 'agent-spending',
		version: 1,
		agent: agent.publicKeyString.get(),
		createdAt: toUnixSeconds(options.createdAt ?? new Date()),
		funded: addAmounts({}, funding)
	};

	builder.setInfo({
		name: '',
		description: options.name ?? '',
		metadata: encodeAgentSpendingMetadata(metadata),
		defaultPermission: new KeetaNet.lib.Permissions([...AGENT_SPENDING_DEFAULT_PERMISSION])
	}, { account: storage });

	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, undefined, { account: storage });

	for (const { token, amount } of funding) {
		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		builder.send(storage, amount, tokenAccount);
	}

	return({ storage });
}

/**
 * Open and fund a storage account owned by `ownerClient`'s account and grant
 * `agent` the right to spend from it, in one publish.
 */
export async function openAgentSpendingAccount(ownerClient: UserClient, options: OpenAgentSpendingAccountOptions): Promise<AgentSpendingAccount> {
	const builder = ownerClient.initBuilder();
	const { storage } = await buildOpenAgentSpendingAccount(builder, options);
	await ownerClient.publishBuilder(builder);

	return({
		storage,
		owner: ownerClient.account,
		agent: options.agent
	});
}

/**
 * The agent spending account as the owner sees it on the network.
 */
export type AgentSpendingAccountState = {
	storage: StorageAccount;
	agent: Account;
	name: string;
	metadata: AgentSpendingMetadata;
	/** True while the agent still holds SEND_ON_BEHALF on the storage account */
	active: boolean;
	balances: { token: Account; balance: bigint; }[];
};

function readAgentSpendingState(storage: StorageAccount, info: { description: string; metadata: string; }, acls: Awaited<ReturnType<Client['listACLsByEntity']>>, balances: { token: Account; balance: bigint; }[]): AgentSpendingAccountState | null {
	const metadata = decodeAgentSpendingMetadata(info.metadata);
	if (metadata === null) {
		return(null);
	}

	const agent = KeetaNet.lib.Account.fromPublicKeyString(metadata.agent);
	const active = acls.some(function(acl) {
		return(acl.principalType === 'ACCOUNT' && acl.principal.comparePublicKey(agent) && acl.permissions.has(['SEND_ON_BEHALF']));
	});

	return({
		storage,
		agent,
		name: info.description,
		metadata,
		active,
		balances
	});
}

/**
 * Read one agent spending account.  Returns null when `storage` is not one.
 */
export async function getAgentSpendingAccount(client: UserClient | Client, storage: Account): Promise<AgentSpendingAccountState | null> {
	const base = 'client' in client ? client.client : client;
	if (!storage.isStorage()) {
		return(null);
	}

	const storageAccount = storage.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	const [ state, acls ] = await Promise.all([
		base.getAccountInfo(storageAccount),
		base.listACLsByEntity(storageAccount)
	]);

	return(readAgentSpendingState(storageAccount, state.info, acls, state.balances));
}

/**
 * List every agent spending account `owner` owns, active and revoked, newest
 * first.
 */
export async function listAgentSpendingAccounts(client: UserClient | Client, owner: Account): Promise<AgentSpendingAccountState[]> {
	const base = 'client' in client ? client.client : client;
	const rows = await base.listACLsByPrincipalWithInfo(owner);

	const owned = rows.filter(function(row) {
		if (!row.entity.isStorage()) {
			return(false);
		}

		return(row.principals.some(function(acl) {
			return(acl.principalType === 'ACCOUNT' && acl.principal.comparePublicKey(owner) && acl.permissions.has(['OWNER']));
		}));
	}).filter(function(row) {
		return(decodeAgentSpendingMetadata(row.info.metadata) !== null);
	});

	const states = await Promise.all(owned.map(async function(row) {
		const storage = row.entity.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
		const acls = await base.listACLsByEntity(storage);
		return(readAgentSpendingState(storage, row.info, acls, row.balances));
	}));

	return(states.filter(function(state): state is AgentSpendingAccountState {
		return(state !== null);
	}).sort(function(a, b) {
		return(b.metadata.createdAt - a.metadata.createdAt);
	}));
}

export type AddAgentSpendingFundsOptions = {
	storage: Account;
	funding: AgentSpendingFunding[];
};

/**
 * Add the operations that move more funds into an agent spending account.
 * Tokens the account cannot hold yet are allowed first, and the funded total
 * in the metadata is raised in the same publish.
 */
export async function buildAddAgentSpendingFunds(builder: Builder, client: UserClient | Client, options: AddAgentSpendingFundsOptions): Promise<void> {
	const { storage, funding } = options;
	assertFunding(funding);

	const state = await getAgentSpendingAccount(client, storage);
	if (state === null) {
		throw(new Error('Not an agent spending account'));
	}

	if (!state.active) {
		throw(new Error('Agent spending account has been revoked'));
	}

	const base = 'client' in client ? client.client : client;
	const acls = await base.listACLsByEntity(state.storage);

	for (const { token } of funding) {
		const canHold = acls.some(function(acl) {
			return(acl.principalType === 'ACCOUNT' && acl.principal.comparePublicKey(token) && acl.permissions.has(['STORAGE_CAN_HOLD']));
		});

		if (!canHold) {
			builder.updatePermissions(token, new KeetaNet.lib.Permissions(['STORAGE_CAN_HOLD']), undefined, undefined, { account: state.storage });
		}
	}

	builder.setInfo({
		name: '',
		description: state.name,
		metadata: encodeAgentSpendingMetadata({ ...state.metadata, funded: addAmounts(state.metadata.funded, funding) }),
		defaultPermission: new KeetaNet.lib.Permissions([...AGENT_SPENDING_DEFAULT_PERMISSION])
	}, { account: state.storage });

	for (const { token, amount } of funding) {
		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		builder.send(state.storage, amount, tokenAccount);
	}
}

export async function addAgentSpendingFunds(ownerClient: UserClient, options: AddAgentSpendingFundsOptions): Promise<void> {
	const builder = ownerClient.initBuilder();
	await buildAddAgentSpendingFunds(builder, ownerClient, options);
	await ownerClient.publishBuilder(builder);
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
	/** Tokens to sweep back to the owner.  Defaults to every token with a balance. */
	tokens?: Account[];
	/** Defaults to now */
	revokedAt?: Date;
};

export type RevokeAgentSpendingResult = {
	returned: { token: Account; amount: bigint; }[];
};

/**
 * Add the operations that remove the agent's grant and return the leftover
 * balance to the owner.  They land in one publish so the agent cannot race a
 * payment in between.  When the account carries agent spending metadata, it
 * is marked revoked in the same publish.
 */
export async function buildRevokeAgentSpending(builder: Builder, ownerClient: UserClient, options: RevokeAgentSpendingOptions): Promise<RevokeAgentSpendingResult> {
	const { agent, storage } = options;

	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, KeetaNet.lib.Block.AdjustMethod.SUBTRACT, { account: storage });

	const balances = await (async function() {
		if (options.tokens === undefined) {
			const all = await ownerClient.allBalances({ account: storage });
			return(all.map(function({ token, balance }) {
				return({ token, amount: balance });
			}));
		}

		return(await Promise.all(options.tokens.map(async function(token) {
			const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			return({ token, amount: await ownerClient.balance(tokenAccount, { account: storage }) });
		})));
	})();

	const returned: { token: Account; amount: bigint; }[] = [];
	for (const { token, amount } of balances) {
		if (amount <= 0n) {
			continue;
		}

		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		builder.send(ownerClient.account, amount, tokenAccount, undefined, { account: storage });
		returned.push({ token, amount });
	}

	const state = await getAgentSpendingAccount(ownerClient, storage);
	if (state !== null) {
		const returnedMetadata: { [token: string]: string; } = {};
		for (const { token, amount } of returned) {
			returnedMetadata[token.publicKeyString.get()] = amount.toString();
		}

		builder.setInfo({
			name: '',
			description: state.name,
			metadata: encodeAgentSpendingMetadata({
				...state.metadata,
				revokedAt: toUnixSeconds(options.revokedAt ?? new Date()),
				returned: returnedMetadata
			}),
			defaultPermission: new KeetaNet.lib.Permissions([...AGENT_SPENDING_DEFAULT_PERMISSION])
		}, { account: storage });
	}

	return({ returned });
}

export async function revokeAgentSpending(ownerClient: UserClient, options: RevokeAgentSpendingOptions): Promise<RevokeAgentSpendingResult> {
	const builder = ownerClient.initBuilder();
	const result = await buildRevokeAgentSpending(builder, ownerClient, options);
	await ownerClient.publishBuilder(builder);

	return(result);
}

export type AgentSpendingActivityEntry = {
	kind: 'payment' | 'funded' | 'returned' | 'fee';
	/** The merchant for a payment, the fee collector for a fee, the owner otherwise */
	counterparty: Account;
	token: Account;
	amount: bigint;
	date: Date;
	blockHash: string;
	external?: string;
};

export type AgentSpendingActivityPage = {
	entries: AgentSpendingActivityEntry[];
	/** Pass back as `startBlocksHash` for the next, older page */
	nextCursor?: string;
};

/**
 * Payments, funding and returns of an agent spending account, newest first,
 * one history page at a time.
 */
export async function listAgentSpendingActivity(client: UserClient | Client, storage: Account, options?: { startBlocksHash?: string; pageSize?: number; }): Promise<AgentSpendingActivityPage> {
	const base = 'client' in client ? client.client : client;
	const owner = await resolveStorageAccountOwner(base, storage);
	const pageSize = options?.pageSize ?? 20;

	const history = await base.getHistory(storage, {
		...(options?.startBlocksHash !== undefined ? { startBlocksHash: options.startBlocksHash } : {}),
		pageSize
	});

	const entries: AgentSpendingActivityEntry[] = [];
	for (const { voteStaple } of history) {
		const date = voteStaple.timestamp();
		for (const block of voteStaple.blocks) {
			const fromStorage = block.account.comparePublicKey(storage);
			const isFee = block.purpose === KeetaNet.lib.Block.Purpose.FEE;
			for (const operation of block.operations) {
				if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
					continue;
				}

				const toStorage = operation.to.comparePublicKey(storage);
				if (!fromStorage && !toStorage) {
					continue;
				}

				let kind: AgentSpendingActivityEntry['kind'];
				let counterparty: Account;
				if (fromStorage && isFee) {
					kind = 'fee';
					counterparty = operation.to;
				} else if (fromStorage) {
					kind = operation.to.comparePublicKey(owner) ? 'returned' : 'payment';
					counterparty = operation.to;
				} else {
					kind = 'funded';
					counterparty = block.account;
				}

				entries.push({
					kind,
					counterparty,
					token: operation.token,
					amount: operation.amount,
					date,
					blockHash: block.hash.toString(),
					...(operation.external !== undefined ? { external: operation.external } : {})
				});
			}
		}
	}

	const last = history.at(-1);
	return({
		entries,
		...(history.length === pageSize && last !== undefined ? { nextCursor: last.voteStaple.blocksHash.toString() } : {})
	});
}

/**
 * Whose identity a payment from `storage` carries.  Merchants and anchors call
 * this to find the KYC'd owner behind an agent's payment.
 */
export async function resolveAgentSpendingOwner(client: UserClient | Client, storage: Account): Promise<Account> {
	const base = 'client' in client ? client.client : client;
	return(await resolveStorageAccountOwner(base, storage));
}
