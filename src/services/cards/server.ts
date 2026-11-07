/**
 * The cards anchor: issues and manages stablecoin-funded virtual cards for
 * agent spending accounts, and decides in real time whether each purchase
 * is approved.
 *
 * Requests are signed for a storage account by its owner or by an agent
 * holding SEND_ON_BEHALF, and resolve to the owner, the same way the asset
 * movement anchor treats storage accounts.  Agents get a narrower set of
 * operations by default ({@link DEFAULT_CARD_DELEGATE_OPERATIONS}).
 *
 * Revoking an agent on the network stops its cards: every authorization
 * re-reads the storage account's grants, and declines (and freezes the card)
 * once the agent that created it can no longer act for the account.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { JSONSerializable } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { assertHTTPSignedField, parseSignatureFromURL } from '../../lib/http-server/common.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { resolveStorageAccountAuthority, verifyStorageAccountSignature } from '../../lib/utils/storage-account.js';
import type {
	CardAuthorizationDecision,
	CardAuthorizationRequest,
	CardControls,
	CardDetails,
	CardsOperationName
} from './common.js';
import {
	DEFAULT_CARD_DELEGATE_OPERATIONS,
	assertValidCardControls,
	assertValidFundingWallet,
	getCardActionSignable,
	getCreateCardSignable,
	getListCardsSignable,
	getRevealCardSignable,
	getUpdateControlsSignable
} from './common.js';
import {
	assertKeetaCardsCardActionRequestJSON,
	assertKeetaCardsCreateRequestJSON,
	assertKeetaCardsRevealRequestJSON,
	assertKeetaCardsUpdateControlsRequestJSON
} from './common.server.generated.js';
import { decideCardAuthorization } from './policy.js';
import type { CardProvider } from './provider.js';

type Account = InstanceType<typeof KeetaNet.lib.Account>;
type KeetaNetClient = InstanceType<typeof KeetaNet.Client>;

/**
 * Where the anchor keeps its cards.  The in-memory store is for tests and
 * local runs; a deployed anchor backs this with its database.
 */
export interface CardStore {
	put(card: CardDetails): Promise<void>;
	get(id: string): Promise<CardDetails | null>;
	listByAccount(account: string): Promise<CardDetails[]>;
}

export class InMemoryCardStore implements CardStore {
	readonly #cards = new Map<string, CardDetails>();

	async put(card: CardDetails): Promise<void> {
		this.#cards.set(card.id, structuredClone(card));
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

	/** Controls applied to every new card unless the request sets them */
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

		const verified = await verifyStorageAccountSignature(this.#client, storage, [storage, ...signable], signed);
		if (verified === null) {
			throw(new KeetaAnchorUserError('Invalid signature'));
		}

		const isOwner = verified.signer.comparePublicKey(verified.owner);
		if (!isOwner && !this.delegateOperations.includes(operation)) {
			throw(new KeetaAnchorUserError('This operation is not available to storage account delegates'));
		}

		return({ storage, owner: verified.owner, signer: verified.signer, isOwner });
	}

	async #cardFor(caller: Caller, id: string): Promise<CardDetails> {
		const card = await this.store.get(id);
		if (card === null || card.account !== caller.storage.publicKeyString.get()) {
			throw(new KeetaAnchorUserError('Card not found'));
		}

		return(card);
	}

	/**
	 * The real-time decision for a purchase.  A provider's webhook route
	 * calls this and answers the issuer with the result.
	 */
	async authorize(request: CardAuthorizationRequest): Promise<CardAuthorizationDecision> {
		const card = await this.store.get(request.cardID);

		let creatorStillAuthorized = false;
		if (card !== null) {
			try {
				const storage = KeetaNet.lib.Account.fromPublicKeyString(card.account);
				const authority = await resolveStorageAccountAuthority(this.#client, storage);
				const creator = KeetaNet.lib.Account.fromPublicKeyString(card.createdBy);
				creatorStillAuthorized = authority.owner.comparePublicKey(creator) || authority.delegates.some(function(delegate) {
					return(delegate.comparePublicKey(creator));
				});
			} catch (error) {
				this.logger.debug('KeetaNetCardsAnchorHTTPServer', 'could not resolve storage account authority', error);
				creatorStillAuthorized = false;
			}
		}

		const decision = decideCardAuthorization(request, { card, creatorStillAuthorized, now: new Date() });
		if (card === null) {
			return(decision);
		}

		if (!decision.approved && decision.reason === 'delegate_revoked' && card.status === 'active') {
			/* The agent lost access: stop the card at the issuer too */
			await this.provider.freezeCard(card.id);
			card.status = 'frozen';
			card.statusReason = 'delegate_revoked';
			await this.store.put(card);
		}

		if (decision.approved) {
			card.spentCents += request.amountCents;
			if (card.controls.singleUse) {
				card.status = 'closed';
				card.statusReason = 'single_use';
			}

			await this.store.put(card);

			if (card.controls.singleUse) {
				/*
				 * Close at the issuer after answering, so the purchase
				 * being approved now still completes.
				 */
				setImmediate(() => {
					this.provider.closeCard(card.id).catch((error: unknown) => {
						this.logger.error('KeetaNetCardsAnchorHTTPServer', 'failed to close single-use card', card.id, error);
					});
				});
			}
		}

		return(decision);
	}

	protected async initRoutes(_ignore_config: KeetaAnchorCardsServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = { ...(this.provider.routes?.() ?? {}) };

		routes['POST /api/cards'] = async (_ignore_params, body) => {
			const request = parseBody(assertKeetaCardsCreateRequestJSON, body);
			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getCreateCardSignable(request), 'createCard');

			const controls = { ...this.defaultControls, ...(request.controls ?? {}) };
			try {
				assertValidFundingWallet(request.wallet);
				assertValidCardControls(controls);
			} catch (error) {
				throw(new KeetaAnchorUserError(error instanceof Error ? error.message : 'Invalid request'));
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
				account: caller.storage.publicKeyString.get(),
				createdBy: caller.signer.publicKeyString.get(),
				status: 'active',
				last4: issued.last4,
				expiry: issued.expiry,
				wallet: request.wallet,
				controls,
				spentCents: 0,
				createdAt: new Date().toISOString(),
				...(request.label !== undefined ? { label: request.label } : {}),
				...(issued.deposit !== undefined ? { deposit: issued.deposit } : {})
			};
			await this.store.put(card);

			return(json({ ok: true, card }));
		};

		routes['GET /api/cards'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
			const parsed = parseSignatureFromURL(url, { assertKeyed: false });
			const caller = await this.#authenticate(parsed.account?.publicKeyString.get(), parsed.signedField, getListCardsSignable(), 'listCards');
			const cards = await this.store.listByAccount(caller.storage.publicKeyString.get());
			return(json({ ok: true, cards }));
		};

		routes['GET /api/cards/:id'] = async (params, _ignore_body, _ignore_headers, url) => {
			const id = params.get('id') ?? '';
			const parsed = parseSignatureFromURL(url, { assertKeyed: false });
			const caller = await this.#authenticate(parsed.account?.publicKeyString.get(), parsed.signedField, getCardActionSignable('get', { id }), 'getCard');
			const card = await this.#cardFor(caller, id);
			return(json({ ok: true, card }));
		};

		const action = (name: 'freeze' | 'unfreeze' | 'close', operation: CardsOperationName, apply: (card: CardDetails) => Promise<void>) => {
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

				await apply(card);
				await this.store.put(card);
				return(json({ ok: true, card }));
			};
		};

		action('freeze', 'freezeCard', async (card) => {
			await this.provider.freezeCard(card.id);
			card.status = 'frozen';
			card.statusReason = 'requested';
		});

		action('unfreeze', 'unfreezeCard', async (card) => {
			await this.provider.unfreezeCard(card.id);
			card.status = 'active';
			delete card.statusReason;
		});

		action('close', 'closeCard', async (card) => {
			await this.provider.closeCard(card.id);
			card.status = 'closed';
			card.statusReason = 'requested';
		});

		routes['POST /api/cards/:id/controls'] = async (params, body) => {
			const request = parseBody(assertKeetaCardsUpdateControlsRequestJSON, body);
			if (request.id !== params.get('id')) {
				throw(new KeetaAnchorUserError('Card ID does not match the URL'));
			}

			const caller = await this.#authenticate(request.account, assertHTTPSignedField(request.signed), getUpdateControlsSignable(request), 'updateControls');
			const card = await this.#cardFor(caller, request.id);
			try {
				assertValidCardControls(request.controls);
			} catch (error) {
				throw(new KeetaAnchorUserError(error instanceof Error ? error.message : 'Invalid controls'));
			}

			await this.provider.updateControls(card.id, request.controls);
			card.controls = request.controls;
			await this.store.put(card);
			return(json({ ok: true, card }));
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
