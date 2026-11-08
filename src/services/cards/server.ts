/**
 * The cards anchor: issues and manages stablecoin-funded virtual cards for
 * agent spending accounts, and decides in real time whether each purchase
 * is approved.
 *
 * Requests are signed for a storage account by its owner or by an agent
 * holding SEND_ON_BEHALF, and resolve to the owner, the same way the asset
 * movement anchor treats storage accounts.  Agents can sign nothing until
 * the operator passes `delegateOperations` (usually
 * {@link CARD_AGENT_OPERATIONS}).  An agent's cards only draw on wallets
 * the owner registered.
 *
 * Revoking an agent on the network stops its cards.  The owner's wallet
 * asks the anchor to freeze all of the agent's cards right after the revoke
 * (POST /api/cards/agents/:agent/freeze).  As a backstop, listing cards and
 * every authorization re-read the storage account's grants and freeze any
 * card whose creator can no longer act for the account.  Such a card stays
 * frozen while the agent is revoked, because the agent may still hold its
 * number.  The owner can close it, replace it with a new number
 * (POST /api/cards/:id/replace), or grant the agent access again and then
 * unfreeze it.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server/common.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { authenticateStorageAccountRequest, resolveStorageAccountAuthority } from '../../lib/utils/storage-account.js';
import type {
	CardAuthorizationDecision,
	CardAuthorizationRequest,
	CardControls,
	CardDetails,
	CardsOperationName,
	KeetaCardsFreezeAgentCardsResult,
	RegisteredCardWallet
} from './common.js';
import {
	DEFAULT_CARD_DELEGATE_OPERATIONS,
	assertValidCardControls,
	assertValidFundingWallet,
	getCardActionSignable,
	getCreateCardSignable,
	getFreezeAgentCardsSignable,
	getListCardsSignable,
	getListWalletsSignable,
	getRegisterWalletSignable,
	getReplaceCardSignable,
	getRevealCardSignable,
	getUpdateControlsSignable,
	isSameFundingWallet
} from './common.js';
import {
	assertKeetaCardsCardActionRequestJSON,
	assertKeetaCardsCreateRequestJSON,
	assertKeetaCardsFreezeAgentCardsRequestJSON,
	assertKeetaCardsRegisterWalletRequestJSON,
	assertKeetaCardsReplaceCardRequestJSON,
	assertKeetaCardsRevealRequestJSON,
	assertKeetaCardsUpdateControlsRequestJSON
} from './common.server.generated.js';
import { decideCardAuthorization, tightenCardControls } from './policy.js';
import type { CardProvider } from './provider.js';

type Account = InstanceType<typeof KeetaNet.lib.Account>;
type KeetaNetClient = InstanceType<typeof KeetaNet.Client>;

/**
 * What {@link CardStore.recordAuthorization} asks of its caller: given the
 * card as stored right now, the decision and the card to save (if changed).
 */
export type CardAuthorizationStep = (card: CardDetails | null) => { decision: CardAuthorizationDecision; card?: CardDetails; };

/**
 * Where the anchor keeps its cards.  The in-memory store is for tests and
 * local runs; a deployed anchor backs this with its database.
 */
export interface CardStore {
	put(card: CardDetails): Promise<void>;
	get(id: string): Promise<CardDetails | null>;
	listByAccount(account: string): Promise<CardDetails[]>;

	/**
	 * Decide one purchase and save its effect on the card atomically, so
	 * concurrent authorizations can't both spend the same limit or both use
	 * a single-use card.  Calls for one card run one at a time against the
	 * latest stored card; a database does this in a transaction that locks
	 * the card's row (SELECT ... FOR UPDATE) and runs `step` inside it.
	 *
	 * `key` is the issuer's ID for the authorization.  When a decision for
	 * that key is already recorded (an issuer retry or a replay), it is
	 * returned again and `step` is not run, so a purchase is counted once.
	 */
	recordAuthorization(id: string, key: string | undefined, step: CardAuthorizationStep): Promise<CardAuthorizationDecision>;

	/**
	 * Change a stored card atomically, against its latest version, so a
	 * status change can't overwrite spend recorded by a concurrent
	 * authorization.  Returns the saved card, or null if there is none.
	 */
	update(id: string, change: (card: CardDetails) => void): Promise<CardDetails | null>;

	/** Record a funding wallet the owner registered; registering it again changes nothing */
	addWallet(account: string, wallet: RegisteredCardWallet): Promise<void>;
	listWallets(account: string): Promise<RegisteredCardWallet[]>;
}

export class InMemoryCardStore implements CardStore {
	readonly #cards = new Map<string, CardDetails>();
	readonly #decisions = new Map<string, CardAuthorizationDecision>();
	readonly #wallets = new Map<string, RegisteredCardWallet[]>();
	/* The tail of each card's queue of writes, so writes to a card don't interleave */
	readonly #queues = new Map<string, Promise<unknown>>();

	#serialize<T>(id: string, work: () => T): Promise<T> {
		const previous = this.#queues.get(id) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.catch(function() { return(undefined); });
		this.#queues.set(id, tail);
		void tail.then(() => {
			if (this.#queues.get(id) === tail) {
				this.#queues.delete(id);
			}
		});

		return(next);
	}

	async put(card: CardDetails): Promise<void> {
		const copy = structuredClone(card);
		await this.#serialize(card.id, () => {
			this.#cards.set(copy.id, copy);
		});
	}

	async update(id: string, change: (card: CardDetails) => void): Promise<CardDetails | null> {
		return(await this.#serialize(id, () => {
			const stored = this.#cards.get(id);
			if (!stored) {
				return(null);
			}

			const card = structuredClone(stored);
			change(card);
			this.#cards.set(id, structuredClone(card));
			return(card);
		}));
	}

	async recordAuthorization(id: string, key: string | undefined, step: CardAuthorizationStep): Promise<CardAuthorizationDecision> {
		return(await this.#serialize(id, () => {
			const recordKey = key === undefined ? undefined : `${id}:${key}`;
			const recorded = recordKey === undefined ? undefined : this.#decisions.get(recordKey);
			if (recorded !== undefined) {
				return(structuredClone(recorded));
			}

			const stored = this.#cards.get(id);
			const { decision, card } = step(stored ? structuredClone(stored) : null);
			if (card !== undefined) {
				this.#cards.set(id, structuredClone(card));
			}

			if (recordKey !== undefined) {
				this.#decisions.set(recordKey, structuredClone(decision));
			}

			return(decision);
		}));
	}

	async get(id: string): Promise<CardDetails | null> {
		const card = this.#cards.get(id);
		if (!card) {
			return(null);
		}

		return(structuredClone(card));
	}

	async listByAccount(account: string): Promise<CardDetails[]> {
		return([...this.#cards.values()].filter(function(card) {
			return(card.account === account);
		}).map(function(card) {
			return(structuredClone(card));
		}));
	}

	async addWallet(account: string, wallet: RegisteredCardWallet): Promise<void> {
		const wallets = this.#wallets.get(account) ?? [];
		if (!wallets.some(function(known) { return(isSameFundingWallet(known, wallet)); })) {
			wallets.push(structuredClone(wallet));
			this.#wallets.set(account, wallets);
		}
	}

	async listWallets(account: string): Promise<RegisteredCardWallet[]> {
		return(structuredClone(this.#wallets.get(account) ?? []));
	}
}

export interface KeetaAnchorCardsServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	/** Network client used to resolve storage account owners and agents */
	client: { client: KeetaNetClient; } | InstanceType<typeof KeetaNet.UserClient>;

	/** The card issuer integration */
	provider: CardProvider & {
		setAuthorizer?: (authorizer: (request: CardAuthorizationRequest) => Promise<CardAuthorizationDecision>) => void;
	};

	store?: CardStore;

	/**
	 * Operations an agent (an account holding SEND_ON_BEHALF on the storage
	 * account) may call.  The owner can always call every operation.
	 */
	delegateOperations?: readonly CardsOperationName[];

	/**
	 * Controls for new cards.  An owner's request may override them; an
	 * agent's request can only tighten them (see {@link tightenCardControls}),
	 * so set these to cap what agents can give themselves.
	 */
	defaultControls?: CardControls;
}

type Caller = {
	storage: Account;
	owner: Account;
	signer: Account;
	isOwner: boolean;
};

function json(output: unknown): { output: string; contentType: string; } {
	return({ output: JSON.stringify(output), contentType: 'application/json' });
}

function parseBody<T>(assertion: (input: unknown) => T, body: JSONSerializable | undefined): T {
	try {
		return(assertion(body));
	} catch {
		throw(new KeetaAnchorUserError('Malformed request'));
	}
}

export class KeetaNetCardsAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorCardsServerConfig> {
	readonly provider: KeetaAnchorCardsServerConfig['provider'];
	readonly store: CardStore;
	readonly delegateOperations: readonly CardsOperationName[];
	readonly defaultControls: CardControls;
	readonly #client: KeetaNetClient;
	/*
	 * Revoke freezes running now, by storage account, so an unfreeze waits
	 * for them.  This is per process: anchors run as several instances
	 * need a shared lock instead.
	 */
	readonly #revokeFreezes = new Map<string, Set<Promise<unknown>>>();

	constructor(config: KeetaAnchorCardsServerConfig) {
		super(config);

		this.provider = config.provider;
		this.store = config.store ?? new InMemoryCardStore();
		this.delegateOperations = config.delegateOperations ?? DEFAULT_CARD_DELEGATE_OPERATIONS;
		this.defaultControls = config.defaultControls ?? {};
		this.#client = config.client.client;

		this.provider.setAuthorizer?.((request) => {
			return(this.authorize(request));
		});
	}

	/**
	 * Check a signature for a storage account and the operation.  Returns
	 * who is calling, resolved to the owner.
	 */
	async #authenticate(accountString: string | undefined, signed: HTTPSignedField | undefined, signable: Signable, operation: CardsOperationName): Promise<Caller> {
		if (!accountString || !signed) {
			throw(new KeetaAnchorUserError('Authentication required'));
		}

		let storage: Account;
		try {
			storage = KeetaNet.lib.Account.fromPublicKeyString(accountString);
		} catch {
			throw(new KeetaAnchorUserError('Invalid account public key'));
		}

		if (!storage.isStorage()) {
			throw(new KeetaAnchorUserError('Cards belong to agent spending (storage) accounts'));
		}

		const { owner, signer, isOwner } = await authenticateStorageAccountRequest(this.#client, storage, signable, signed, {
			operation,
			delegateOperations: this.delegateOperations
		});

		return({ storage, owner, signer, isOwner });
	}

	/* An agent only sees and acts on the cards it made; the owner sees all */
	#canSee(caller: Caller, card: CardDetails): boolean {
		return(card.account === caller.storage.publicKeyString.get() && (caller.isOwner || card.createdBy === caller.signer.publicKeyString.get()));
	}

	async #cardFor(caller: Caller, id: string): Promise<CardDetails> {
		const card = await this.store.get(id);
		if (card === null || !this.#canSee(caller, card)) {
			throw(new KeetaAnchorUserError('Card not found'));
		}

		return(card);
	}

	/**
	 * Who can act for a storage account right now: a check that answers
	 * whether an account (the owner or a delegate) still can.  Fails closed:
	 * if the network can't be read, nobody is authorized.
	 */
	async #authorityFor(account: string): Promise<(creator: string) => boolean> {
		try {
			const storage = KeetaNet.lib.Account.fromPublicKeyString(account);
			const authority = await resolveStorageAccountAuthority(this.#client, storage);
			return(function(creator) {
				const key = KeetaNet.lib.Account.fromPublicKeyString(creator);
				return(authority.owner.comparePublicKey(key) || authority.delegates.some(function(delegate) {
					return(delegate.comparePublicKey(key));
				}));
			});
		} catch (error) {
			this.logger.debug('KeetaNetCardsAnchorHTTPServer', 'could not resolve storage account authority', error);
			return(function() {
				return(false);
			});
		}
	}

	async #trackRevokeFreeze<T>(account: string, work: () => Promise<T>): Promise<T> {
		const running = work();
		const set = this.#revokeFreezes.get(account) ?? new Set();
		this.#revokeFreezes.set(account, set);
		set.add(running);
		try {
			return(await running);
		} finally {
			set.delete(running);
			if (set.size === 0) {
				this.#revokeFreezes.delete(account);
			}
		}
	}

	async #revokeFreezesSettled(account: string): Promise<void> {
		await Promise.allSettled([...(this.#revokeFreezes.get(account) ?? [])]);
	}

	async #registerWallet(caller: Caller, wallet: CardDetails['wallet']): Promise<void> {
		await this.store.addWallet(caller.storage.publicKeyString.get(), {
			chain: wallet.chain,
			currency: wallet.currency,
			address: wallet.address,
			registeredBy: caller.owner.publicKeyString.get(),
			registeredAt: new Date().toISOString()
		});
	}

	/**
	 * The account a public key names, in canonical form, if it can act for
	 * the storage account as an agent right now.  Throws otherwise.
	 */
	async #activeAgent(caller: Caller, agentString: string): Promise<string> {
		let agent: string;
		try {
			agent = KeetaNet.lib.Account.fromPublicKeyString(agentString).publicKeyString.get();
		} catch {
			throw(new KeetaAnchorUserError('Invalid agent public key'));
		}

		const isAuthorized = await this.#authorityFor(caller.storage.publicKeyString.get());
		if (agent === caller.owner.publicKeyString.get() || !isAuthorized(agent)) {
			throw(new KeetaAnchorUserError('That agent has no grant on this account'));
		}

		return(agent);
	}

	/**
	 * Stop a card at the issuer because the agent that made it was revoked.
	 * A card the agent or owner had already frozen is relabeled, so it too
	 * can't be unfrozen while the agent may still hold its number.
	 */
	async #freezeForRevokedAgent(card: CardDetails): Promise<void> {
		if (card.status === 'closed' || (card.status === 'frozen' && card.statusReason === 'delegate_revoked')) {
			return;
		}

		if (card.status === 'active') {
			await this.provider.freezeCard(card.id);
		}

		const saved = await this.store.update(card.id, function(fresh) {
			if (fresh.status !== 'closed') {
				fresh.status = 'frozen';
				fresh.statusReason = 'delegate_revoked';
			}
		});
		Object.assign(card, saved);
	}

	/**
	 * Freeze every card on the list whose creator can no longer act for the
	 * account.  Issuer failures are logged and left for the next pass.
	 */
	async #freezeCardsOfRevokedAgents(account: string, cards: CardDetails[]): Promise<void> {
		const open = cards.filter(function(card) {
			return(card.status !== 'closed' && card.statusReason !== 'delegate_revoked');
		});
		if (open.length === 0) {
			return;
		}

		await this.#trackRevokeFreeze(account, async () => {
			const isAuthorized = await this.#authorityFor(account);
			for (const card of open) {
				if (isAuthorized(card.createdBy)) {
					continue;
				}

				try {
					await this.#freezeForRevokedAgent(card);
				} catch (error) {
					this.logger.error('KeetaNetCardsAnchorHTTPServer', 'failed to freeze a revoked agent\'s card', card.id, error);
				}
			}
		});
	}

	/**
	 * The real-time decision for a purchase.  A provider's webhook route
	 * calls this and answers the issuer with the result.  It never calls
	 * the issuer itself: freezing or closing the card at the issuer happens
	 * after the answer, so the issuer's time budget only covers the network
	 * lookup and the store.
	 */
	async authorize(request: CardAuthorizationRequest): Promise<CardAuthorizationDecision> {
		const known = await this.store.get(request.cardID);
		if (known === null) {
			return({ approved: false, reason: 'card_not_found' });
		}

		/* Read the grants before taking the card's lock, so the lock is short */
		const isAuthorized = await this.#authorityFor(known.account);
		const creatorStillAuthorized = isAuthorized(known.createdBy);

		let after: 'freeze' | 'close' | undefined;
		const decision = await this.store.recordAuthorization(request.cardID, request.authorizationID, function(card) {
			after = undefined;
			const decided = decideCardAuthorization(request, { card, creatorStillAuthorized, now: new Date() });
			if (card === null) {
				return({ decision: decided });
			}

			if (!creatorStillAuthorized && card.status !== 'closed') {
				after = 'freeze';
			}

			if (!decided.approved) {
				return({ decision: decided });
			}

			card.spentCents += request.amountCents;
			if (card.controls.singleUse) {
				card.status = 'closed';
				card.statusReason = 'single_use';
				after = 'close';
			}

			return({ decision: decided, card });
		});

		/*
		 * After answering, so a slow or failing issuer can't turn the
		 * decision into an error, and the purchase approved now completes
		 * before a single-use card closes.
		 */
		const cardID = request.cardID;
		if (after === 'freeze') {
			setImmediate(() => {
				this.#trackRevokeFreeze(known.account, async () => {
					const card = await this.store.get(cardID);
					if (card !== null) {
						await this.#freezeForRevokedAgent(card);
					}
				}).catch((error: unknown) => {
					this.logger.error('KeetaNetCardsAnchorHTTPServer', 'failed to freeze a revoked agent\'s card', cardID, error);
				});
			});
		} else if (after === 'close') {
			setImmediate(() => {
				this.provider.closeCard(cardID).catch((error: unknown) => {
					this.logger.error('KeetaNetCardsAnchorHTTPServer', 'failed to close single-use card', cardID, error);
				});
			});
		}

		return(decision);
	}

	protected async initRoutes(_ignore_config: KeetaAnchorCardsServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = { ...(this.provider.routes?.() ?? {}) };

		routes['POST /api/cards'] = async (_ignore_params, body) => {
			const request = parseBody(assertKeetaCardsCreateRequestJSON, body);
			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getCreateCardSignable(request), 'createCard');

			/* The owner may loosen the defaults; an agent can only tighten them */
			const requested = request.controls ?? {};
			const controls = caller.isOwner
				? { ...this.defaultControls, ...requested }
				: tightenCardControls(this.defaultControls, requested);
			try {
				assertValidFundingWallet(request.wallet);
				assertValidCardControls(requested);
				assertValidCardControls(controls);
			} catch (error) {
				throw(new KeetaAnchorUserError(error instanceof Error ? error.message : 'Invalid request'));
			}

			/* An agent may only use a wallet the owner approved */
			const account = caller.storage.publicKeyString.get();
			if (!caller.isOwner) {
				const registered = await this.store.listWallets(account);
				if (!registered.some(function(known) { return(isSameFundingWallet(known, request.wallet)); })) {
					throw(new KeetaAnchorUserError('Agents can only fund cards from a wallet the owner registered'));
				}
			}

			const issued = await this.provider.createCard({
				owner: caller.owner,
				storage: caller.storage,
				wallet: request.wallet,
				controls,
				...(request.label !== undefined ? { label: request.label } : {})
			});

			const card: CardDetails = {
				id: issued.providerCardID,
				account,
				createdBy: caller.signer.publicKeyString.get(),
				status: 'active',
				last4: issued.last4,
				expiry: issued.expiry,
				wallet: request.wallet,
				walletSource: caller.isOwner ? 'owner' : 'registered',
				controls,
				spentCents: 0,
				createdAt: new Date().toISOString(),
				...(request.label !== undefined ? { label: request.label } : {}),
				...(issued.deposit !== undefined ? { deposit: issued.deposit } : {})
			};
			await this.store.put(card);
			if (caller.isOwner) {
				await this.#registerWallet(caller, request.wallet);
			}

			return(json({ ok: true, card }));
		};

		routes['POST /api/cards/wallets'] = async (_ignore_params, body) => {
			const request = parseBody(assertKeetaCardsRegisterWalletRequestJSON, body);
			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getRegisterWalletSignable(request), 'registerWallet');
			if (!caller.isOwner) {
				throw(new KeetaAnchorUserError('Only the owner can register a funding wallet'));
			}

			try {
				assertValidFundingWallet(request.wallet);
			} catch (error) {
				throw(new KeetaAnchorUserError(error instanceof Error ? error.message : 'Invalid wallet'));
			}

			await this.#registerWallet(caller, request.wallet);
			return(json({ ok: true, wallets: await this.store.listWallets(caller.storage.publicKeyString.get()) }));
		};

		routes['GET /api/cards/wallets'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
			const parsed = parseSignatureFromURL(url, { assertKeyed: false });
			const caller = await this.#authenticate(parsed.account?.publicKeyString.get(), parsed.signedField, getListWalletsSignable(), 'listWallets');
			return(json({ ok: true, wallets: await this.store.listWallets(caller.storage.publicKeyString.get()) }));
		};

		routes['GET /api/cards'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
			const parsed = parseSignatureFromURL(url, { assertKeyed: false });
			const caller = await this.#authenticate(parsed.account?.publicKeyString.get(), parsed.signedField, getListCardsSignable(), 'listCards');
			const account = caller.storage.publicKeyString.get();
			const cards = await this.store.listByAccount(account);
			/* Catch cards of an agent revoked without the wallet's follow-up freeze */
			await this.#freezeCardsOfRevokedAgents(account, cards);
			return(json({ ok: true, cards: cards.filter((card) => {
				return(this.#canSee(caller, card));
			}) }));
		};

		routes['POST /api/cards/agents/:agent/freeze'] = async (params, body) => {
			const request = parseBody(assertKeetaCardsFreezeAgentCardsRequestJSON, body);
			if (request.agent !== params.get('agent')) {
				throw(new KeetaAnchorUserError('Agent does not match the URL'));
			}

			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getFreezeAgentCardsSignable(request), 'freezeAgentCards');
			if (!caller.isOwner) {
				throw(new KeetaAnchorUserError('Only the owner can freeze an agent\'s cards'));
			}

			let agent: string;
			try {
				/* Canonical form, so it matches how cards record their creator */
				agent = KeetaNet.lib.Account.fromPublicKeyString(request.agent).publicKeyString.get();
			} catch {
				throw(new KeetaAnchorUserError('Invalid agent public key'));
			}

			if (agent === caller.owner.publicKeyString.get()) {
				throw(new KeetaAnchorUserError('Name the agent, not the owner'));
			}

			const account = caller.storage.publicKeyString.get();
			const isAuthorized = await this.#authorityFor(account);
			const stillAuthorized = isAuthorized(agent);

			const result: KeetaCardsFreezeAgentCardsResult = { cards: [], failed: [] };
			const cards = await this.store.listByAccount(account);
			await this.#trackRevokeFreeze(account, async () => {
				for (const card of cards) {
					if (card.createdBy !== agent || card.status === 'closed') {
						continue;
					}

					try {
						if (stillAuthorized) {
							/* The owner is pausing an agent it has not revoked: an ordinary freeze */
							if (card.status === 'active') {
								await this.provider.freezeCard(card.id);
								Object.assign(card, await this.store.update(card.id, function(fresh) {
									if (fresh.status === 'active') {
										fresh.status = 'frozen';
										fresh.statusReason = 'requested';
									}
								}));
							}
						} else {
							await this.#freezeForRevokedAgent(card);
						}

						result.cards.push(card);
					} catch (error) {
						this.logger.error('KeetaNetCardsAnchorHTTPServer', 'failed to freeze an agent card', card.id, error);
						result.failed.push(card.id);
					}
				}
			});

			return(json({ ok: true, ...result }));
		};

		routes['GET /api/cards/:id'] = async (params, _ignore_body, _ignore_headers, url) => {
			const id = params.get('id') ?? '';
			const parsed = parseSignatureFromURL(url, { assertKeyed: false });
			const caller = await this.#authenticate(parsed.account?.publicKeyString.get(), parsed.signedField, getCardActionSignable('get', { id }), 'getCard');
			const card = await this.#cardFor(caller, id);
			return(json({ ok: true, card }));
		};

		/*
		 * `apply` makes the change at the issuer and returns how to record it
		 * on the stored card, which is then changed atomically.
		 */
		const action = (name: 'freeze' | 'unfreeze' | 'close', operation: CardsOperationName, apply: (card: CardDetails) => Promise<(card: CardDetails) => void>) => {
			routes[`POST /api/cards/:id/${name}`] = async (params, body) => {
				const request = parseBody(assertKeetaCardsCardActionRequestJSON, body);
				if (request.id !== params.get('id')) {
					throw(new KeetaAnchorUserError('Card ID does not match the URL'));
				}

				const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getCardActionSignable(name, request), operation);
				const card = await this.#cardFor(caller, request.id);
				if (card.status === 'closed') {
					throw(new KeetaAnchorUserError('The card is closed'));
				}

				const change = await apply(card);
				const saved = await this.store.update(card.id, change);
				return(json({ ok: true, card: saved }));
			};
		};

		action('freeze', 'freezeCard', async (card) => {
			await this.provider.freezeCard(card.id);
			return(function(fresh) {
				if (fresh.status !== 'closed') {
					fresh.status = 'frozen';
					/* Keep a revoked agent's card marked as such: it still only closes */
					if (fresh.statusReason !== 'delegate_revoked') {
						fresh.statusReason = 'requested';
					}
				}
			});
		});

		action('unfreeze', 'unfreezeCard', async (card) => {
			/*
			 * Let a revoke finish freezing the agent's cards first, then read
			 * the grants fresh: the card spends again only if the agent that
			 * holds its number may act for the account again.
			 */
			await this.#revokeFreezesSettled(card.account);
			const isAuthorized = await this.#authorityFor(card.account);
			if (!isAuthorized(card.createdBy)) {
				throw(new KeetaAnchorUserError('This card\'s agent was revoked.  Grant the agent access again to unfreeze it, or replace the card with a new number'));
			}

			await this.provider.unfreezeCard(card.id);
			return(function(fresh) {
				if (fresh.status === 'frozen') {
					fresh.status = 'active';
					delete fresh.statusReason;
				}
			});
		});

		action('close', 'closeCard', async (card) => {
			await this.provider.closeCard(card.id);
			return(function(fresh) {
				if (fresh.status !== 'closed') {
					fresh.status = 'closed';
					fresh.statusReason = 'requested';
				}
			});
		});

		routes['POST /api/cards/:id/replace'] = async (params, body) => {
			const request = parseBody(assertKeetaCardsReplaceCardRequestJSON, body);
			if (request.id !== params.get('id')) {
				throw(new KeetaAnchorUserError('Card ID does not match the URL'));
			}

			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getReplaceCardSignable(request), 'replaceCard');
			if (!caller.isOwner) {
				throw(new KeetaAnchorUserError('Only the owner can replace a card'));
			}

			const old = await this.#cardFor(caller, request.id);
			if (old.status === 'closed') {
				throw(new KeetaAnchorUserError('The card is closed'));
			}

			const holder = request.agent === undefined ? caller.owner.publicKeyString.get() : await this.#activeAgent(caller, request.agent);

			/* Close the old number first, so a failure never leaves it working */
			await this.provider.closeCard(old.id);
			const closed = await this.store.update(old.id, function(fresh) {
				fresh.status = 'closed';
				fresh.statusReason = 'replaced';
			});

			const issued = await this.provider.createCard({
				owner: caller.owner,
				storage: caller.storage,
				wallet: old.wallet,
				controls: old.controls,
				...(old.label !== undefined ? { label: old.label } : {})
			});

			const card: CardDetails = {
				id: issued.providerCardID,
				account: old.account,
				createdBy: holder,
				status: 'active',
				last4: issued.last4,
				expiry: issued.expiry,
				wallet: old.wallet,
				walletSource: 'owner',
				controls: old.controls,
				/* Carried over, so the lifetime limit still counts the old card's spend */
				spentCents: closed?.spentCents ?? old.spentCents,
				replaces: old.id,
				createdAt: new Date().toISOString(),
				...(old.label !== undefined ? { label: old.label } : {}),
				...(issued.deposit !== undefined ? { deposit: issued.deposit } : {})
			};
			await this.store.put(card);
			await this.#registerWallet(caller, old.wallet);

			return(json({ ok: true, card }));
		};

		routes['POST /api/cards/:id/controls'] = async (params, body) => {
			const request = parseBody(assertKeetaCardsUpdateControlsRequestJSON, body);
			if (request.id !== params.get('id')) {
				throw(new KeetaAnchorUserError('Card ID does not match the URL'));
			}

			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getUpdateControlsSignable(request), 'updateControls');
			const card = await this.#cardFor(caller, request.id);
			if (card.status === 'closed') {
				throw(new KeetaAnchorUserError('The card is closed'));
			}

			try {
				assertValidCardControls(request.controls);
			} catch (error) {
				throw(new KeetaAnchorUserError(error instanceof Error ? error.message : 'Invalid controls'));
			}

			await this.provider.updateControls(card.id, request.controls);
			const saved = await this.store.update(card.id, function(fresh) {
				fresh.controls = request.controls;
			});
			return(json({ ok: true, card: saved }));
		};

		routes['POST /api/cards/:id/reveal'] = async (params, body) => {
			const request = parseBody(assertKeetaCardsRevealRequestJSON, body);
			if (request.id !== params.get('id')) {
				throw(new KeetaAnchorUserError('Card ID does not match the URL'));
			}

			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getRevealCardSignable(request), 'revealCard');
			const card = await this.#cardFor(caller, request.id);
			if (card.status !== 'active') {
				throw(new KeetaAnchorUserError('Only an active card can be revealed'));
			}

			const reveal = await this.provider.createRevealToken(card.id, request.clientNonce);
			return(json({ ok: true, reveal }));
		};

		return(routes);
	}
}
