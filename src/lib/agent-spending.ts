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
	/**
	 * True when the history read stopped at its bound before reaching the
	 * start of the account.  `funded`, `returned` and `revokedAt` then cover
	 * only the newest part of the history.  `agent` and `active` never
	 * depend on it while the grant is in place.
	 */
	truncated: boolean;
	balances: { token: Account; balance: bigint; }[];
};

/**
 * How much history a state read walks: up to `pageLimit` pages of
 * `pageSize` vote staples, newest first.
 */
export type AgentSpendingHistoryBounds = {
	pageSize?: number;
	pageLimit?: number;
};

const HISTORY_PAGE_SIZE = 50;
const HISTORY_PAGE_LIMIT = 20;

/* How many storage accounts listAgentSpendingAccounts reads at once */
const LIST_CONCURRENCY = 4;

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

/*
 * The agent's grant covers the whole storage account.  A grant scoped to
 * a target (for example one token) is something else and is not the agent.
 */
function coversWholeAccount(target: { comparePublicKey(other: StorageAccount): boolean; } | undefined | null, storage: StorageAccount): boolean {
	return(target === undefined || target === null || target.comparePublicKey(storage));
}

type AgentSpendingHistory = {
	/** The principal of the latest whole-account SEND_ON_BEHALF change, if one was seen */
	agent?: Account;
	revokedAt?: Date;
	funded: AgentSpendingTokenAmount[];
	returned: AgentSpendingTokenAmount[];
	truncated: boolean;
};

/**
 * The blocks of a vote staple and their operations, newest first.  A staple
 * holds its blocks, and a block its operations, oldest first.
 */
function* newestFirst(blocks: InstanceType<typeof KeetaNet.lib.Block>[]): Generator<{ block: InstanceType<typeof KeetaNet.lib.Block>; operation: InstanceType<typeof KeetaNet.lib.Block>['operations'][number]; }> {
	for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
		const block = blocks[blockIndex];
		if (block === undefined) {
			continue;
		}

		for (let operationIndex = block.operations.length - 1; operationIndex >= 0; operationIndex--) {
			const operation = block.operations[operationIndex];
			if (operation !== undefined) {
				yield({ block, operation });
			}
		}
	}
}

/**
 * Walk a storage account's history, newest first and within the bounds, for
 * the funding and return totals and the latest change to an agent's grant.
 */
async function readAgentSpendingHistory(base: Client, storage: StorageAccount, owner: Account, bounds?: AgentSpendingHistoryBounds): Promise<AgentSpendingHistory> {
	const pageSize = bounds?.pageSize ?? HISTORY_PAGE_SIZE;
	const pageLimit = bounds?.pageLimit ?? HISTORY_PAGE_LIMIT;

	let agent: Account | undefined;
	let revokedAt: Date | undefined;
	let truncated = false;
	const funded: AgentSpendingTokenAmount[] = [];
	const returned: AgentSpendingTokenAmount[] = [];

	let startBlocksHash: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= pageLimit) {
			truncated = true;
			break;
		}

		const history = await base.getHistory(storage, {
			...(startBlocksHash !== undefined ? { startBlocksHash } : {}),
			/* Without depth, getHistory keeps paging to the start of the chain */
			depth: pageSize,
			pageSize
		});

		for (const { voteStaple } of history) {
			for (const { block, operation } of newestFirst(voteStaple.blocks)) {
				if (operation.type === KeetaNet.lib.Block.OperationType.MODIFY_PERMISSIONS) {
					if (agent !== undefined || !block.account.comparePublicKey(storage) || !grantsSendOnBehalf(operation.permissions) || !coversWholeAccount(operation.target, storage)) {
						continue;
					}

					const principal = operation.principal;
					if (!(principal instanceof KeetaNet.lib.Account)) {
						continue;
					}

					agent = principal;
					if (operation.method === KeetaNet.lib.Block.AdjustMethod.SUBTRACT) {
						revokedAt = voteStaple.timestamp();
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

		const last = history.at(-1);
		if (history.length < pageSize || last === undefined) {
			break;
		}

		startBlocksHash = last.voteStaple.blocksHash.toString();
	}

	return({
		...(agent !== undefined ? { agent } : {}),
		...(revokedAt !== undefined ? { revokedAt } : {}),
		funded,
		returned,
		truncated
	});
}

/**
 * The agent currently granted SEND_ON_BEHALF over the whole storage account,
 * read from its ACLs.  The owner is never the agent.
 */
function currentAgent(acls: Awaited<ReturnType<Client['listACLsByEntity']>>, storage: StorageAccount, owner: Account): Account | undefined {
	for (const acl of acls) {
		if (acl.principalType !== 'ACCOUNT' || acl.principal.comparePublicKey(owner)) {
			continue;
		}

		if (acl.permissions.has(['SEND_ON_BEHALF']) && coversWholeAccount(acl.target, storage)) {
			return(acl.principal);
		}
	}

	return(undefined);
}

/**
 * The grant itself is read from the ACLs, which are authoritative and cost
 * one call however busy the account is.  History supplies the totals, and,
 * for an account whose grant is gone, which agent it was and when it was
 * revoked.  Returns null for a pocket that never had an agent within the
 * history bounds.
 */
async function readAgentSpendingState(base: Client, storage: StorageAccount, owner: Account, info: { description: string; metadata: string; }, balances: { token: Account; balance: bigint; }[], bounds?: AgentSpendingHistoryBounds): Promise<AgentSpendingAccountState | null> {
	const [ history, acls ] = await Promise.all([
		readAgentSpendingHistory(base, storage, owner, bounds),
		base.listACLsByEntity(storage)
	]);

	const granted = currentAgent(acls, storage, owner);
	const agent = granted ?? history.agent;
	if (agent === undefined) {
		return(null);
	}

	const active = granted !== undefined;

	return({
		storage,
		agent,
		name: info.description,
		createdAt: decodeCreatedAt(info.metadata),
		active,
		...(!active && history.revokedAt !== undefined ? { revokedAt: history.revokedAt } : {}),
		funded: history.funded,
		returned: history.returned,
		truncated: history.truncated,
		balances
	});
}

/* Run `task` over `items` with at most `limit` running at once, keeping order */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (item !== undefined) {
				results[index] = await task(item);
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return(results);
}

/**
 * Read one agent spending account.  Returns null when `storage` is not one.
 */
export async function getAgentSpendingAccount(client: UserClient | Client, storage: Account, bounds?: AgentSpendingHistoryBounds): Promise<AgentSpendingAccountState | null> {
	const base = 'client' in client ? client.client : client;
	if (!storage.isStorage()) {
		return(null);
	}

	const storageAccount = storage.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	const [ state, owner ] = await Promise.all([
		base.getAccountInfo(storageAccount),
		resolveStorageAccountOwner(base, storageAccount)
	]);

	return(await readAgentSpendingState(base, storageAccount, owner, state.info, state.balances, bounds));
}

/**
 * List every agent spending account `owner` owns, active and revoked, newest
 * first.  Pockets the owner never granted to an agent are left out.
 */
export async function listAgentSpendingAccounts(client: UserClient | Client, owner: Account, bounds?: AgentSpendingHistoryBounds): Promise<AgentSpendingAccountState[]> {
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

	const states = await mapWithConcurrency(owned, LIST_CONCURRENCY, async function(row) {
		const storage = row.entity.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
		return(await readAgentSpendingState(base, storage, owner, row.info, row.balances, bounds));
	});

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
	/**
	 * Tokens to sweep back to the owner.  Defaults to every token with a
	 * balance that the owner can receive; see `unswept` for the rest.
	 */
	tokens?: Account[];
	/** Sweep the leftover back to the owner.  Default true. */
	sweep?: boolean;
};

export type AgentSpendingUnswept = {
	token: Account;
	amount: bigint;
	reason: string;
};

export type RevokeAgentSpendingResult = {
	/** What was swept back to the owner */
	returned: AgentSpendingTokenAmount[];
	/** Balances left in the storage account, and why */
	unswept: AgentSpendingUnswept[];
};

function errorReason(error: unknown): string {
	return(error instanceof Error ? error.message : String(error));
}

/**
 * Whether the owner holds ACCESS on `token`, from an ACL of their own on it
 * or from its default permission.  Anyone can deposit into the storage
 * account, so a token the owner cannot receive must not reach the sweep.
 */
async function ownerCanReceive(base: Client, owner: Account, token: Account): Promise<boolean> {
	const [ tokenState, ownerACLs ] = await Promise.all([
		base.getAccountInfo(token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN)),
		base.listACLsByPrincipal(owner, [ token ])
	]);

	const explicit = ownerACLs.filter(function(acl) {
		return(acl.entity.comparePublicKey(token));
	});

	if (explicit.length > 0) {
		return(explicit.some(function(acl) {
			return(acl.permissions.has(['ACCESS']));
		}));
	}

	const info = tokenState.info;
	return('defaultPermission' in info && info.defaultPermission.has(['ACCESS']));
}

async function sweepPlan(ownerClient: UserClient, storage: Account, tokens?: Account[]): Promise<{ sweep: AgentSpendingTokenAmount[]; unswept: AgentSpendingUnswept[]; }> {
	const base = ownerClient.client;
	if (tokens !== undefined) {
		const balances = await Promise.all(tokens.map(async function(token) {
			const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
			return({ token, amount: await ownerClient.balance(tokenAccount, { account: storage }) });
		}));

		return({
			sweep: balances.filter(function({ amount }) {
				return(amount > 0n);
			}),
			unswept: []
		});
	}

	const all = await ownerClient.allBalances({ account: storage });
	const checked = await Promise.all(all.filter(function({ balance }) {
		return(balance > 0n);
	}).map(async function({ token, balance }) {
		const receivable = await ownerCanReceive(base, ownerClient.account, token).catch(function() {
			return(false);
		});

		return({ token, amount: balance, receivable });
	}));

	const sweep: AgentSpendingTokenAmount[] = [];
	const unswept: AgentSpendingUnswept[] = [];
	for (const { token, amount, receivable } of checked) {
		if (receivable) {
			sweep.push({ token, amount });
		} else {
			unswept.push({ token, amount, reason: 'Owner cannot receive this token' });
		}
	}

	return({ sweep, unswept });
}

function addSweep(builder: Builder, ownerClient: UserClient, storage: Account, sweep: AgentSpendingTokenAmount[]): void {
	for (const { token, amount } of sweep) {
		const tokenAccount = token.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN);
		builder.send(ownerClient.account, amount, tokenAccount, undefined, { account: storage });
	}
}

/**
 * Add the operations that remove the agent's grant and, unless `sweep` is
 * false, return the leftover balance to the owner, for one signature.
 *
 * The grant removal comes first and is what stops the agent; the sweep only
 * tidies up.  Because they share a publish, a sweep send that fails (the
 * agent paid after the balances were read, or a token refuses the owner)
 * fails the revoke with it.  When the publish fails, publish again with
 * `sweep: false`: revokeAgentSpending does this for you.
 */
export async function buildRevokeAgentSpending(builder: Builder, ownerClient: UserClient, options: RevokeAgentSpendingOptions): Promise<RevokeAgentSpendingResult> {
	const { agent, storage } = options;

	builder.updatePermissions(agent, new KeetaNet.lib.Permissions(['SEND_ON_BEHALF']), undefined, KeetaNet.lib.Block.AdjustMethod.SUBTRACT, { account: storage });

	if (options.sweep === false) {
		return({ returned: [], unswept: [] });
	}

	const { sweep, unswept } = await sweepPlan(ownerClient, storage, options.tokens);
	addSweep(builder, ownerClient, storage, sweep);

	return({ returned: sweep, unswept });
}

async function stillGranted(base: Client, storage: Account, agent: Account): Promise<boolean> {
	const storageAccount = storage.assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.STORAGE);
	const acls = await base.listACLsByEntity(storageAccount);
	return(acls.some(function(acl) {
		return(acl.principalType === 'ACCOUNT' && acl.principal.comparePublicKey(agent) && acl.permissions.has(['SEND_ON_BEHALF']) && coversWholeAccount(acl.target, storageAccount));
	}));
}

/**
 * Remove the agent's grant, then return the leftover to the owner.
 *
 * The revoke never depends on the sweep.  It is tried as one publish first;
 * if that fails, the grant is removed on its own and the sweep is retried
 * from fresh balances, one token at a time, after the agent can no longer
 * pay.  Whatever could not be swept is reported in `unswept`.  Only a
 * failure to remove the grant throws.
 */
export async function revokeAgentSpending(ownerClient: UserClient, options: RevokeAgentSpendingOptions): Promise<RevokeAgentSpendingResult> {
	const combined = ownerClient.initBuilder();
	const planned = await buildRevokeAgentSpending(combined, ownerClient, options);
	try {
		await ownerClient.publishBuilder(combined);
		return(planned);
	} catch {
		/* Fall through: remove the grant on its own, then sweep */
	}

	const revokeOnly = ownerClient.initBuilder();
	await buildRevokeAgentSpending(revokeOnly, ownerClient, { ...options, sweep: false });
	try {
		await ownerClient.publishBuilder(revokeOnly);
	} catch (error: unknown) {
		/*
		 * The combined publish may have landed after all (a timeout, say),
		 * in which case the grant is already gone and this one is refused.
		 * Only throw when the agent really still holds the grant.
		 */
		if (await stillGranted(ownerClient.client, options.storage, options.agent)) {
			throw(error);
		}
	}

	if (options.sweep === false) {
		return({ returned: [], unswept: [] });
	}

	/* The agent cannot pay any more, so these balances are final */
	const { sweep, unswept } = await sweepPlan(ownerClient, options.storage, options.tokens);
	const returned: AgentSpendingTokenAmount[] = [];
	for (const entry of sweep) {
		const builder = ownerClient.initBuilder();
		addSweep(builder, ownerClient, options.storage, [ entry ]);
		try {
			await ownerClient.publishBuilder(builder);
			returned.push(entry);
		} catch (error: unknown) {
			unswept.push({ ...entry, reason: errorReason(error) });
		}
	}

	return({ returned, unswept });
}

export type AgentSpendingActivityEntry = {
	/**
	 * `funded` is a send in from the owner, the same sends the state's
	 * `funded` total counts; `deposit` is a send in from anyone else.
	 */
	kind: 'payment' | 'funded' | 'deposit' | 'returned' | 'fee';
	/** The merchant for a payment, the fee collector for a fee, the sender for a deposit, the owner otherwise */
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
		depth: pageSize,
		pageSize
	});

	const entries: AgentSpendingActivityEntry[] = [];
	for (const { voteStaple } of history) {
		const date = voteStaple.timestamp();
		for (const { block, operation } of newestFirst(voteStaple.blocks)) {
			const fromStorage = block.account.comparePublicKey(storage);
			const isFee = block.purpose === KeetaNet.lib.Block.Purpose.FEE;
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
				kind = block.account.comparePublicKey(owner) ? 'funded' : 'deposit';
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
