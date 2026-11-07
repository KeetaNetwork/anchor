/**
 * A card provider for Lithic (https://docs.lithic.com).
 *
 * Lithic cards are prepaid: each Lithic account has an ISSUING financial
 * account, and with Lithic's stablecoin funding (a per-program pilot) that
 * financial account has a USDC deposit address on Base, Ethereum or
 * Solana.  Funds sent there become the card balance, so this provider
 * reports the address as the card's `deposit`, and the owner's wallet
 * moves only what a purchase needs to it.
 *
 * Every purchase reaches the anchor through Lithic's Auth Stream Access
 * (ASA) webhook, which this provider serves at `POST /api/cards/lithic/asa`.
 * Lithic declines a purchase if the webhook does not answer within six
 * seconds.  Requests are signed with Lithic's ASA HMAC secret in the
 * Standard Webhooks format (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`).
 *
 * The anchor's owners are Lithic account holders the program has already
 * verified (KYC or KYB); `accountFor` maps an owner and storage account to
 * the Lithic account the card is issued under.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Routes } from '../../lib/http-server/index.js';
import { Buffer } from '../../lib/utils/buffer.js';
import type { CardAuthorizationDecision, CardAuthorizationRequest, CardControls, CardDeclineReason, CardFundingWallet, CardRevealToken } from './common.js';
import type { CardProvider, CardProviderCard, CardProviderCreateInput } from './provider.js';

export const LITHIC_SANDBOX_URL = 'https://sandbox.lithic.com';
export const LITHIC_PRODUCTION_URL = 'https://api.lithic.com';

/** Lithic's names for the chains a deposit address can be on */
export type LithicNetwork = 'BASE' | 'ETHEREUM' | 'SOLANA';

const NETWORK_CHAINS: { [network in LithicNetwork]: string } = {
	BASE: 'base',
	ETHEREUM: 'ethereum',
	SOLANA: 'solana'
};

/** How far a webhook timestamp may be from now, in seconds */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** Retries of a request Lithic rate-limited (429), and the longest wait between them */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 5000;

/** Embed sessions last at most ten minutes */
const REVEAL_SECONDS = 5 * 60;

export type LithicCardProviderOptions = {
	/** A Lithic API key, sent as the `Authorization` header */
	apiKey?: string;
	/** Defaults to the sandbox */
	baseURL?: string;
	/** The Lithic account a card for this owner and storage account goes under */
	accountFor: (input: Pick<CardProviderCreateInput, 'owner' | 'storage'>) => Promise<string>;
	/**
	 * The ASA HMAC secret (`whsec_...`).  Without it, unsigned webhook
	 * requests are accepted, which is only for local tests.
	 */
	asaSecret?: string;
	/**
	 * The HTTPS origin of the page that shows revealed card details (the
	 * wallet).  Lithic's embed iframe only renders inside this origin, and
	 * reveal tokens cannot be made without it.
	 */
	embedOrigin?: string;
	/** Which deposit address to report.  Defaults to Base. */
	depositNetwork?: LithicNetwork;
	fetch?: typeof fetch;
};

type LithicSpendLimit = { spend_limit: number; spend_limit_duration: 'FOREVER' | 'TRANSACTION' };

export type LithicASAResult = 'APPROVED' | 'CARD_PAUSED' | 'INSUFFICIENT_FUNDS' | 'UNAUTHORIZED_MERCHANT' | 'VELOCITY_EXCEEDED' | 'SUSPECTED_FRAUD';

function isRecord(value: unknown): value is { [key: string]: unknown } {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function stringField(record: { [key: string]: unknown }, key: string): string | undefined {
	const value = record[key];
	return(typeof value === 'string' ? value : undefined);
}

function numberField(record: { [key: string]: unknown }, key: string): number | undefined {
	const value = record[key];
	return(typeof value === 'number' && Number.isFinite(value) ? value : undefined);
}

/**
 * The one issuer-side limit Lithic keeps per card.  A per-purchase limit is
 * the tighter everyday check, so it wins; the anchor enforces both anyway.
 * A limit of 0 removes it.
 */
export function lithicSpendLimit(controls: CardControls): LithicSpendLimit {
	if (controls.perPurchaseLimitCents !== undefined) {
		return({ spend_limit: controls.perPurchaseLimitCents, spend_limit_duration: 'TRANSACTION' });
	}

	if (controls.lifetimeLimitCents !== undefined) {
		return({ spend_limit: controls.lifetimeLimitCents, spend_limit_duration: 'FOREVER' });
	}

	return({ spend_limit: 0, spend_limit_duration: 'FOREVER' });
}

export function lithicASAResult(decision: CardAuthorizationDecision): LithicASAResult {
	if (decision.approved) {
		return('APPROVED');
	}

	const results: { [reason in CardDeclineReason]: LithicASAResult } = {
		card_not_found: 'SUSPECTED_FRAUD',
		card_not_active: 'CARD_PAUSED',
		card_expired: 'CARD_PAUSED',
		delegate_revoked: 'CARD_PAUSED',
		over_per_purchase_limit: 'VELOCITY_EXCEEDED',
		over_lifetime_limit: 'VELOCITY_EXCEEDED',
		merchant_category_not_allowed: 'UNAUTHORIZED_MERCHANT',
		merchant_category_blocked: 'UNAUTHORIZED_MERCHANT',
		insufficient_funds: 'INSUFFICIENT_FUNDS'
	};

	return(results[decision.reason]);
}

/**
 * The anchor's question from a Lithic ASA request, or undefined when the
 * request needs no decision (refunds, credits and balance inquiries).
 */
export function lithicAuthorizationRequest(body: unknown): { token: string; request: CardAuthorizationRequest | undefined; } {
	if (!isRecord(body) || !isRecord(body.card) || !isRecord(body.merchant)) {
		throw(new Error('Not a Lithic ASA request'));
	}

	const token = stringField(body, 'token');
	const cardID = stringField(body.card, 'token');
	if (!token || !cardID) {
		throw(new Error('Lithic ASA request is missing its token or card'));
	}

	const status = stringField(body, 'status');
	if (status !== 'AUTHORIZATION' && status !== 'FINANCIAL_AUTHORIZATION') {
		return({ token, request: undefined });
	}

	/* What the cardholder is charged, in cents of their (USD) currency */
	let amountCents: number | undefined;
	if (isRecord(body.amounts) && isRecord(body.amounts.cardholder)) {
		amountCents = numberField(body.amounts.cardholder, 'amount');
	}

	amountCents ??= numberField(body, 'authorization_amount') ?? numberField(body, 'amount');
	if (amountCents === undefined || amountCents < 0) {
		throw(new Error('Lithic ASA request has no amount'));
	}

	const country = stringField(body.merchant, 'country');
	return({
		token,
		request: {
			cardID,
			amountCents,
			merchant: {
				name: stringField(body.merchant, 'descriptor') ?? '',
				categoryCode: stringField(body.merchant, 'mcc') ?? '',
				...(country !== undefined ? { country } : {})
			}
		}
	});
}

/**
 * Check a Standard Webhooks signature: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the secret after `whsec_`, base64, in a
 * space-separated list of `v1,<signature>` entries.
 */
export function verifyLithicWebhook(secret: string, headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined; }, body: Buffer, now: Date = new Date()): boolean {
	if (!headers.id || !headers.timestamp || !headers.signature) {
		return(false);
	}

	const timestamp = Number(headers.timestamp);
	if (!Number.isInteger(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
		return(false);
	}

	const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
	const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.`).update(body).digest();
	for (const entry of headers.signature.split(' ')) {
		const [version, value] = entry.split(',', 2);
		if (version !== 'v1' || !value) {
			continue;
		}

		const given = Buffer.from(value, 'base64');
		if (given.length === expected.length && timingSafeEqual(given, expected)) {
			return(true);
		}
	}

	return(false);
}

/** A Lithic API call that did not succeed */
export class LithicAPIError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'LithicAPIError';
		this.status = status;
	}
}

function header(headers: { [name: string]: string | string[] | undefined }, name: string): string | undefined {
	const value = headers[name];
	return(Array.isArray(value) ? value[0] : value);
}

export class LithicCardProvider implements CardProvider {
	readonly name = 'lithic';
	readonly baseURL: string;
	readonly depositNetwork: LithicNetwork;

	readonly #apiKey: string | undefined;
	readonly #asaSecret: string | undefined;
	readonly #embedOrigin: string | undefined;
	readonly #accountFor: LithicCardProviderOptions['accountFor'];
	readonly #fetch: typeof fetch;
	#authorizer: ((request: CardAuthorizationRequest) => Promise<CardAuthorizationDecision>) | null = null;

	constructor(options: LithicCardProviderOptions) {
		this.baseURL = (options.baseURL ?? LITHIC_SANDBOX_URL).replace(/\/+$/, '');
		this.depositNetwork = options.depositNetwork ?? 'BASE';
		this.#apiKey = options.apiKey;
		this.#asaSecret = options.asaSecret;
		this.#embedOrigin = options.embedOrigin !== undefined ? new URL(options.embedOrigin).origin : undefined;
		this.#accountFor = options.accountFor;
		this.#fetch = options.fetch ?? fetch;
	}

	setAuthorizer(authorizer: (request: CardAuthorizationRequest) => Promise<CardAuthorizationDecision>): void {
		this.#authorizer = authorizer;
	}

	async #call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
		const headers: { [name: string]: string } = { 'Accept': 'application/json' };
		/* Behind a proxy that adds the key, no key is configured here */
		if (this.#apiKey !== undefined) {
			headers['Authorization'] = this.#apiKey;
		}

		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		let response: Response;
		for (let attempt = 0; ; attempt++) {
			response = await this.#fetch(`${this.baseURL}${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {})
			});

			/* The sandbox allows about one write a second; wait as Lithic asks */
			if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
				break;
			}

			const retryAfter = Number(response.headers.get('retry-after'));
			const waitMS = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT_MS) : 1000;
			await response.body?.cancel();
			await new Promise(function(resolve) { setTimeout(resolve, waitMS); });
		}

		const text = await response.text();
		if (!response.ok) {
			throw(new LithicAPIError(`Lithic ${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`, response.status));
		}

		const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;
		return(parsed);
	}

	/**
	 * The account's USDC deposit address.  Accounts outside a
	 * program-managed (ledger) program have no financial accounts, and
	 * Lithic answers 400 for them; those cards have no deposit address.
	 */
	async #deposit(accountToken: string): Promise<CardFundingWallet | undefined> {
		let listing: unknown;
		try {
			listing = await this.#call('GET', `/v1/financial_accounts?account_token=${encodeURIComponent(accountToken)}&type=ISSUING`);
		} catch (error) {
			if (error instanceof LithicAPIError && error.status === 400) {
				return(undefined);
			}

			throw(error);
		}

		if (!isRecord(listing) || !Array.isArray(listing.data)) {
			return(undefined);
		}

		for (const entry of listing.data) {
			if (!isRecord(entry) || !isRecord(entry.blockchain_addresses)) {
				continue;
			}

			const address = stringField(entry.blockchain_addresses, this.depositNetwork);
			if (stringField(entry, 'type') === 'ISSUING' && address) {
				return({ chain: NETWORK_CHAINS[this.depositNetwork], currency: 'usdc', address });
			}
		}

		return(undefined);
	}

	async createCard(input: CardProviderCreateInput): Promise<CardProviderCard> {
		const accountToken = await this.#accountFor({ owner: input.owner, storage: input.storage });
		/* Before the card exists, so a failed lookup leaves no card behind */
		const deposit = await this.#deposit(accountToken);
		const created = await this.#call('POST', '/v1/cards', {
			type: input.controls.singleUse ? 'SINGLE_USE' : 'VIRTUAL',
			account_token: accountToken,
			state: 'OPEN',
			...(input.label !== undefined ? { memo: input.label } : {}),
			...lithicSpendLimit(input.controls),
			tags: { keeta_storage: input.storage.publicKeyString.get() }
		});

		const token = isRecord(created) ? stringField(created, 'token') : undefined;
		const last4 = isRecord(created) ? stringField(created, 'last_four') : undefined;
		if (!isRecord(created) || !token || !last4) {
			throw(new Error('Lithic returned a card without a token'));
		}

		const month = stringField(created, 'exp_month') ?? '--';
		const year = (stringField(created, 'exp_year') ?? '--').slice(-2);

		return({
			providerCardID: token,
			last4,
			expiry: `${month}/${year}`,
			...(deposit !== undefined ? { deposit } : {})
		});
	}

	async #setState(providerCardID: string, state: 'OPEN' | 'PAUSED' | 'CLOSED'): Promise<void> {
		await this.#call('PATCH', `/v1/cards/${encodeURIComponent(providerCardID)}`, { state });
	}

	async freezeCard(providerCardID: string): Promise<void> {
		await this.#setState(providerCardID, 'PAUSED');
	}

	async unfreezeCard(providerCardID: string): Promise<void> {
		await this.#setState(providerCardID, 'OPEN');
	}

	async closeCard(providerCardID: string): Promise<void> {
		await this.#setState(providerCardID, 'CLOSED');
	}

	async updateControls(providerCardID: string, controls: CardControls): Promise<void> {
		await this.#call('PATCH', `/v1/cards/${encodeURIComponent(providerCardID)}`, lithicSpendLimit(controls));
	}

	/**
	 * An embed session for Lithic's card display (the `lithic-embed` SDK
	 * mounts it in an iframe), so the card number never passes through us.
	 */
	async createRevealToken(providerCardID: string, _ignore_clientNonce: string): Promise<CardRevealToken> {
		if (this.#embedOrigin === undefined) {
			throw(new Error('The Lithic card provider needs embedOrigin to reveal cards'));
		}

		const expiration = Math.floor(Date.now() / 1000) + REVEAL_SECONDS;
		const session = await this.#call('POST', `/v1/cards/${encodeURIComponent(providerCardID)}/embed`, {
			type: 'CARD_EMBED',
			target_origin: this.#embedOrigin,
			expiration
		});
		const token = isRecord(session) ? stringField(session, 'session') : undefined;
		if (!token) {
			throw(new Error('Lithic returned no embed session'));
		}

		return({ provider: this.name, token, expiresAt: new Date(expiration * 1000).toISOString() });
	}

	/**
	 * Answer one ASA request: approve or decline with Lithic's result code,
	 * echoing the transaction token.  Refunds and balance inquiries are
	 * approved without asking the anchor.
	 */
	async answerASA(body: unknown): Promise<{ result: LithicASAResult; token: string; }> {
		const { token, request } = lithicAuthorizationRequest(body);
		if (request === undefined) {
			return({ result: 'APPROVED', token });
		}

		if (!this.#authorizer) {
			throw(new Error('No authorizer registered with the Lithic card provider'));
		}

		return({ result: lithicASAResult(await this.#authorizer(request)), token });
	}

	routes(): Routes {
		return({
			'POST /api/cards/lithic/asa': {
				bodyType: 'raw',
				maxBodySize: 256 * 1024,
				handler: async (_ignore_params, body, headers) => {
					if (this.#asaSecret !== undefined) {
						const signed = verifyLithicWebhook(this.#asaSecret, {
							id: header(headers, 'webhook-id'),
							timestamp: header(headers, 'webhook-timestamp'),
							signature: header(headers, 'webhook-signature')
						}, body);

						if (!signed) {
							return({ statusCode: 401, output: JSON.stringify({ error: 'Bad signature' }), contentType: 'application/json' });
						}
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(body.toString('utf-8'));
					} catch {
						return({ statusCode: 400, output: JSON.stringify({ error: 'Malformed request' }), contentType: 'application/json' });
					}

					/* A thrown error becomes a 5xx, which Lithic retries once */
					const answer = await this.answerASA(parsed);
					return({ output: JSON.stringify(answer), contentType: 'application/json' });
				}
			}
		});
	}
}
