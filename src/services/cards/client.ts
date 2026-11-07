/**
 * A client for the cards anchor.
 *
 * It acts for one storage account (an agent spending account).  Give it a
 * UserClient whose account is the storage account and whose signer is the
 * owner or the agent, such as one from `agentSpendingClient`.  Every request
 * is signed over the storage account followed by the operation, which is
 * what the server checks.
 */
import type * as KeetaNet from '@keetanetwork/keetanet-client';
import { addSignatureToURL } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import { SignData } from '../../lib/utils/signing.js';
import type {
	CardControls,
	CardDetails,
	CardRevealToken,
	KeetaCardsCreateRequest,
	KeetaCardsFreezeAgentCardsResult,
	KeetaCardsResponse
} from './common.js';
import {
	getCardActionSignable,
	getCreateCardSignable,
	getFreezeAgentCardsSignable,
	getListCardsSignable,
	getRevealCardSignable,
	getUpdateControlsSignable
} from './common.js';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type Account = InstanceType<typeof KeetaNet.lib.Account>;

export class KeetaCardsAnchorError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'KeetaCardsAnchorError';
		this.status = status;
	}
}

export type KeetaCardsAnchorClientConfig = {
	/** The cards anchor's base URL, such as https://cards.example.com */
	baseURL: string | URL;
	/** Acts for `client.account` (the storage account), signing with `client.signer` */
	client: UserClient;
};

export class KeetaCardsAnchorClient {
	readonly #baseURL: URL;
	readonly #account: Account;
	readonly #signer: Account;

	constructor(config: KeetaCardsAnchorClientConfig) {
		this.#baseURL = new URL(config.baseURL.toString());
		this.#account = config.client.account;
		this.#signer = config.client.signer ?? config.client.account;

		if (!this.#account.isStorage()) {
			throw(new Error('The cards client acts for a storage account; pass a client whose account is the agent spending account'));
		}
	}

	get account(): Account {
		return(this.#account);
	}

	async #sign(signable: Signable) {
		return(await SignData(this.#signer.assertAccount(), [this.#account, ...signable]));
	}

	async #parse<T>(response: Response): Promise<T> {
		let parsed: KeetaCardsResponse<T>;
		try {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			parsed = await response.json() as KeetaCardsResponse<T>;
		} catch {
			throw(new KeetaCardsAnchorError(`Cards anchor returned a non-JSON response (HTTP ${response.status})`, response.status));
		}

		if (!parsed.ok) {
			throw(new KeetaCardsAnchorError(parsed.error, response.status));
		}

		return(parsed);
	}

	async #post<T>(path: string, request: object, signable: Signable): Promise<T> {
		const signed = await this.#sign(signable);
		const response = await fetch(new URL(path, this.#baseURL), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ ...request, account: this.#account.publicKeyString.get(), signed })
		});

		return(await this.#parse<T>(response));
	}

	async #get<T>(path: string, signable: Signable): Promise<T> {
		const signed = await this.#sign(signable);
		const url = addSignatureToURL(new URL(path, this.#baseURL), { signedField: signed, account: this.#account });
		const response = await fetch(url, { headers: { 'Accept': 'application/json' }});
		return(await this.#parse<T>(response));
	}

	async createCard(request: KeetaCardsCreateRequest): Promise<CardDetails> {
		const { card } = await this.#post<{ card: CardDetails; }>('/api/cards', request, getCreateCardSignable(request));
		return(card);
	}

	async listCards(): Promise<CardDetails[]> {
		const { cards } = await this.#get<{ cards: CardDetails[]; }>('/api/cards', getListCardsSignable());
		return(cards);
	}

	async getCard(id: string): Promise<CardDetails> {
		const { card } = await this.#get<{ card: CardDetails; }>(`/api/cards/${encodeURIComponent(id)}`, getCardActionSignable('get', { id }));
		return(card);
	}

	async #action(action: 'freeze' | 'unfreeze' | 'close', id: string): Promise<CardDetails> {
		const { card } = await this.#post<{ card: CardDetails; }>(`/api/cards/${encodeURIComponent(id)}/${action}`, { id }, getCardActionSignable(action, { id }));
		return(card);
	}

	freezeCard(id: string): Promise<CardDetails> {
		return(this.#action('freeze', id));
	}

	/** Owner only by default */
	unfreezeCard(id: string): Promise<CardDetails> {
		return(this.#action('unfreeze', id));
	}

	closeCard(id: string): Promise<CardDetails> {
		return(this.#action('close', id));
	}

	/**
	 * Owner only.  Freeze every card the agent made for this account, at
	 * the issuer, right after revoking it.  Cards the issuer could not
	 * freeze come back in `failed`; calling again retries them.
	 */
	async freezeAgentCards(agent: Account | string): Promise<KeetaCardsFreezeAgentCardsResult> {
		const request = { agent: typeof agent === 'string' ? agent : agent.publicKeyString.get() };
		const { cards, failed } = await this.#post<KeetaCardsFreezeAgentCardsResult>(`/api/cards/agents/${encodeURIComponent(request.agent)}/freeze`, request, getFreezeAgentCardsSignable(request));
		return({ cards, failed });
	}

	/** Owner only by default */
	async updateControls(id: string, controls: CardControls): Promise<CardDetails> {
		const request = { id, controls };
		const { card } = await this.#post<{ card: CardDetails; }>(`/api/cards/${encodeURIComponent(id)}/controls`, request, getUpdateControlsSignable(request));
		return(card);
	}

	/**
	 * Get a short-lived token for the issuer's secure card display.  The
	 * card number never passes through the anchor.
	 */
	async revealCard(id: string, clientNonce: string): Promise<CardRevealToken> {
		const request = { id, clientNonce };
		const { reveal } = await this.#post<{ reveal: CardRevealToken; }>(`/api/cards/${encodeURIComponent(id)}/reveal`, request, getRevealCardSignable(request));
		return(reveal);
	}
}
