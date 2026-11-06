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

export type OpenAgentSpendingAccountOptions = {
	/**
	 * The agent's own account.  Only its public key is needed; the owner
	 * never sees the agent's private key.
	 */
	agent: Account;

	/**
	 * Tokens to fund the storage account with.
	 */
	funding: AgentSpendingFunding[];

	/**
	 * Name shown for the account in Keeta Wallet.  Stored the way the
	 * wallet stores a pocket's name (the storage account's description).
	 * It is public on the network.
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

/**
 * The default permission Keeta Wallet gives a pocket: it can hold any token
 * and anyone can deposit into it.
 */
const POCKET_DEFAULT_PERMISSION = ['STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT'] as const;

/**
 * Encode storage account metadata the way Keeta Wallet encodes a pocket's
 * (web-wallet shared/fetches/pocket.ts): base64 JSON, seconds since epoch.
 */
export function encodeAgentSpendingMetadata(info: { createdAt: Date; }): string {
	return(btoa(JSON.stringify({ createdAt: Math.floor(info.createdAt.getTime() / 1000) })));
}

/**
 * Read the creation date from pocket metadata, or the epoch when there is
 * none (the wallet does the same).
 */
function decodeCreatedAt(metadata: string): Date {
	try {
		const parsed: unknown = JSON.parse(atob(metadata));
		if (typeof parsed === 'object' && parsed !== null && 'createdAt' in parsed && typeof parsed.createdAt === 'number') {
			return(new Date(parsed.createdAt * 1000));
		}
	} catch {
		/* Not pocket metadata */
	}

	return(new Date(0));
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
 *
 * The account is created exactly like a Keeta Wallet pocket (web-wallet
 * useCreatePocket): created in the same builder, name in the description,
 * pocket metadata, and a default permission of STORAGE_CAN_HOLD and
 * STORAGE_DEPOSIT.  The only additions are the agent's SEND_ON_BEHALF grant
 * and the funding sends.
 */
export async function buildOpenAgentSpendingAccount(builder: Builder, options: OpenAgentSpendingAccountOptions): Promise<{ storage: StorageAccount; }> {
	const { agent, funding, name = 'Agent' } = options;

	if (!agent.isAccount()) {
		throw(new Error('Agent must be a keyed account'));
	}

	assertFunding(funding);

	const pending = builder.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	await builder.computeBlocks();
	const storage = pending.account;

	builder.setInfo({
		name: '',
		description: name,
		metadata: encodeAgentSpendingMetadata({ createdAt: options.createdAt ?? new Date() }),
		defaultPermission: new KeetaNet.lib.Permissions([...POCKET_DEFAULT_PERMISSION])
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
 * `agent` the right to spend from it, in one publish (one wallet signature).
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

export type AgentSpendingTokenAmount = { token: Account; amount: bigint; };

/**
 * An agent spending account as the owner sees it.  Everything except the
 * name and creation date is read from the network itself: the grant from the
 * account's ACLs and history, the totals from its sends.
 */
export type AgentSpendingAccountState = {
	storage: StorageAccount;
	agent: Account;
	/** The pocket name (the storage account's description) */
	name: string;
	createdAt: Date;
	/** True while the agent still holds SEND_ON_BEHALF on the storage account */
	active: boolean;
	/** When the grant was removed, for a revoked account */
	revokedAt?: Date;
	/** Total the owner moved in, per token */
	funded: AgentSpendingTokenAmount[];
	/** Total moved back to the owner, per token */
	returned: AgentSpendingTokenAmount[];
	balances: { token: Account; balance: bigint; }[];
};

const HISTORY_PAGE_SIZE = 50;
const HISTORY_PAGE_LIMIT = 20;

function addTo(totals: AgentSpendingTokenAmount[], token: Account, amount: bigint): void {
	const existing = totals.find(function(entry) {
		return(entry.token.comparePublicKey(token));
	});

	if (existing) {
		existing.amount += amount;
	} else {
		totals.push({ token, amount });
	}
}

function grantsSendOnBehalf(permissions: InstanceType<typeof KeetaNet.lib.Permissions> | null): boolean {
	return(permissions?.has(['SEND_ON_BEHALF']) === true);
}

/**
 * Walk a storage account's history and pull out what makes it an agent
 * spending account.  Returns null when no agent was ever granted
 * SEND_ON_BEHALF on it (a plain pocket).
 */
async function readAgentSpendingHistory(base: Client, storage: StorageAccount, owner: Account): Promise<{ agent: Account; revokedAt?: Date; funded: AgentSpendingTokenAmount[]; returned: AgentSpendingTokenAmount[]; } | null> {
	let agent: Account | undefined;
	let revokedAt: Date | undefined;
	const funded: AgentSpendingTokenAmount[] = [];
	const returned: AgentSpendingTokenAmount[] = [];

	let startBlocksHash: string | undefined;
	for (let page = 0; page < HISTORY_PAGE_LIMIT; page++) {
		const history = await base.getHistory(storage, {
			...(startBlocksHash !== undefined ? { startBlocksHash } : {}),
			pageSize: HISTORY_PAGE_SIZE
		});

		/* Newest first, so the first grant change seen is the latest one */
		for (const { voteStaple } of history) {
			for (const block of voteStaple.blocks) {
				for (const operation of block.operations) {
					if (operation.type === KeetaNet.lib.Block.OperationType.MODIFY_PERMISSIONS) {
						if (!block.account.comparePublicKey(storage) || !grantsSendOnBehalf(operation.permissions)) {
							continue;
						}

						const principal = operation.principal;
						if (!(principal instanceof KeetaNet.lib.Account)) {
							continue;
						}

						if (agent === undefined) {
							agent = principal;
							if (operation.method === KeetaNet.lib.Block.AdjustMethod.SUBTRACT) {
								revokedAt = voteStaple.timestamp();
							}
						}

						continue;
					}

					if (operation.type !== KeetaNet.lib.Block.OperationType.SEND) {
						continue;
					}

					if (operation.to.comparePublicKey(storage) && block.account.comparePublicKey(owner)) {
						addTo(funded, operation.token, operation.amount);
					} else if (block.account.comparePublicKey(storage) && operation.to.comparePublicKey(owner)) {
						addTo(returned, operation.token, operation.amount);
					}
				}
			}
		}

		const last = history.at(-1);
		if (history.length < HISTORY_PAGE_SIZE || last === undefined) {
			break;
		}

		startBlocksHash = last.voteStaple.blocksHash.toString();
	}

	if (agent === undefined) {
		return(null);
	}

	return({
		agent,
		...(revokedAt !== undefined ? { revokedAt } : {}),
		funded,
		returned
	});
}

async function readAgentSpendingState(base: Client, storage: StorageAccount, owner: Account, info: { description: string; metadata: string; }, balances: { token: Account; balance: bigint; }[]): Promise<AgentSpendingAccountState | null> {
	const [ history, acls ] = await Promise.all([
		readAgentSpendingHistory(base, storage, owner),
		base.listACLsByEntity(storage)
	]);

	if (history === null) {
		return(null);
	}

	const active = acls.some(function(acl) {
		return(acl.principalType === 'ACCOUNT' && acl.principal.comparePublicKey(history.agent) && acl.permissions.has(['SEND_ON_BEHALF']));
	});

	return({
		storage,
		agent: history.agent,
		name: info.description,
		createdAt: decodeCreatedAt(info.metadata),
		active,
		...(!active && history.revokedAt !== undefined ? { revokedAt: history.revokedAt } : {}),
		funded: history.funded,
		returned: history.returned,
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
	const [ state, owner ] = await Promise.all([
		base.getAccountInfo(storageAccount),
		resolveStorageAccountOwner(base, storageAccount)
	]);

	return(await readAgentSpendingState(base, storageAccount, owner, state.info, state.balances));
}

/**
 * List every agent spending account `owner` owns, active and revoked, newest
 * first.  Pockets the owner never granted to an agent are left out.
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
	});

	const states = await Promise.all(owned.map(async function(row) {
		const storage = row.entity.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
		return(await readAgentSpendingState(base, storage, owner, row.info, row.balances));
	}));

	return(states.filter(function(state): state is AgentSpendingAccountState {
		return(state !== null);
	}).sort(function(a, b) {
		return(b.createdAt.getTime() - a.createdAt.getTime());
	}));
}

export type AddAgentSpendingFundsOptions = {
	storage: Account;
	funding: AgentSpendingFunding[];
};

/**
 * Add the sends that move more funds into an agent spending account.  This
 * is the same as moving funds into a wallet pocket; it only refuses an
 * account whose agent has been revoked.
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
};

export type RevokeAgentSpendingResult = {
	returned: { token: Account; amount: bigint; }[];
};

/**
 * Add the operations that remove the agent's grant and return the leftover
 * balance to the owner.  They land in one publish so the agent cannot race a
 * payment in between.  The account stays a pocket of the owner's; the
 * revoke itself is the record of when the agent lost access.
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
