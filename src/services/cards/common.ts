/**
 * Agent cards: the types shared by the cards anchor server, its client and
 * card providers.
 *
 * A card belongs to an agent spending account (a storage account).  Its
 * owner, or an agent the owner granted SEND_ON_BEHALF, manages it by signing
 * requests with their own key, exactly as for asset movement.  The anchor
 * resolves every request to the owner, so the card sits under the owner's
 * KYC/KYB with the card issuer.
 *
 * The card spends stablecoin from a wallet the owner controls (for Bridge
 * and Stripe Issuing, a non-custodial wallet with an onchain approval).  The
 * anchor never holds the funds.  Money reaches that wallet from the storage
 * account through an asset-movement transfer, so the storage account's
 * balance and spending limit cap what the card can ever spend.
 *
 * Amounts are integer US cents, the unit card networks settle in.
 */
import type { Signable } from '../../lib/utils/signing.js';

/**
 * The wallet a card draws funds from.  For Stripe Issuing this maps to the
 * card's `crypto_wallet` parameter with `type: 'standard'`.
 */
export type CardFundingWallet = {
	chain: string;
	currency: string;
	address: string;
};

/**
 * Limits the anchor enforces when the card issuer asks whether to approve a
 * purchase.  Every field is optional; an empty object approves any purchase
 * the wallet can cover.
 */
export type CardControls = {
	/** Largest single purchase, in cents */
	perPurchaseLimitCents?: number;
	/** Most the card may ever spend, in cents */
	lifetimeLimitCents?: number;
	/** Merchant category codes the card may be used at (all others refused) */
	allowedCategories?: string[];
	/** Merchant category codes the card may not be used at */
	blockedCategories?: string[];
	/** Close the card after its first approved purchase */
	singleUse?: boolean;
	/** ISO 8601; purchases after this are refused */
	expiresAt?: string;
};

export type CardStatus = 'active' | 'frozen' | 'closed';

/**
 * A card as the anchor reports it.  It never contains the card number:
 * details are revealed through the issuer's own secure display.
 */
export type CardDetails = {
	id: string;
	/** The storage account the card belongs to */
	account: string;
	/** The account that created the card (the owner or an agent) */
	createdBy: string;
	status: CardStatus;
	statusReason?: string;
	label?: string;
	last4: string;
	expiry: string;
	wallet: CardFundingWallet;
	controls: CardControls;
	spentCents: number;
	createdAt: string;
};

export type CardMerchant = {
	name: string;
	categoryCode: string;
	country?: string;
};

/**
 * A card issuer's real-time question: may this card make this purchase?
 */
export type CardAuthorizationRequest = {
	cardID: string;
	amountCents: number;
	merchant: CardMerchant;
};

export type CardAuthorizationDecision = {
	approved: true;
} | {
	approved: false;
	reason: CardDeclineReason;
};

export type CardDeclineReason =
	'card_not_found' |
	'card_not_active' |
	'card_expired' |
	'delegate_revoked' |
	'over_per_purchase_limit' |
	'over_lifetime_limit' |
	'merchant_category_not_allowed' |
	'merchant_category_blocked' |
	'insufficient_funds';

/*
 * Requests.  Each POST body carries the storage account and a signature made
 * by the owner or an agent over the storage account followed by the
 * operation's signable (see `get*Signable` below).
 */
type SignedRequest = {
	account: string;
	signed: { nonce: string; timestamp: string; signature: string; };
};

export type KeetaCardsCreateRequest = {
	wallet: CardFundingWallet;
	controls?: CardControls;
	label?: string;
};
export type KeetaCardsCreateRequestJSON = KeetaCardsCreateRequest & SignedRequest;

export type KeetaCardsCardActionRequest = {
	id: string;
};
export type KeetaCardsCardActionRequestJSON = KeetaCardsCardActionRequest & SignedRequest;

export type KeetaCardsUpdateControlsRequest = {
	id: string;
	controls: CardControls;
};
export type KeetaCardsUpdateControlsRequestJSON = KeetaCardsUpdateControlsRequest & SignedRequest;

export type KeetaCardsRevealRequest = {
	id: string;
	/** Nonce the client generated for the issuer's secure card display */
	clientNonce: string;
};
export type KeetaCardsRevealRequestJSON = KeetaCardsRevealRequest & SignedRequest;

/**
 * A short-lived token for the issuer's secure card display (for Stripe
 * Issuing, an ephemeral key used with Issuing Elements).  The anchor never
 * sees or returns the card number.
 */
export type CardRevealToken = {
	provider: string;
	token: string;
	expiresAt: string;
};

export type KeetaCardsResponse<T> = ({ ok: true; } & T) | { ok: false; error: string; };

/**
 * Every operation the cards anchor exposes.
 */
export type CardsOperationName =
	'createCard' |
	'listCards' |
	'getCard' |
	'freezeCard' |
	'unfreezeCard' |
	'closeCard' |
	'updateControls' |
	'revealCard';

/**
 * What an agent may do with its own storage account's cards by default:
 * create and close cards, freeze one it suspects is compromised, read them,
 * and open the issuer's secure display to pay.  Unfreezing and changing
 * limits stay with the owner.
 */
export const DEFAULT_CARD_DELEGATE_OPERATIONS: readonly CardsOperationName[] = Object.freeze([
	'createCard',
	'listCards',
	'getCard',
	'freezeCard',
	'closeCard',
	'revealCard'
]);

/**
 * A stable string for a controls object, so the client and server sign the
 * same bytes whatever order the fields arrive in.
 */
export function canonicalControls(controls: CardControls): string {
	const ordered: { [key: string]: unknown } = {};
	for (const key of Object.keys(controls).sort()) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const value = controls[key as keyof CardControls];
		if (value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			ordered[key] = [...value].sort();
		} else {
			ordered[key] = value;
		}
	}

	return(JSON.stringify(ordered));
}

export function getCreateCardSignable(request: KeetaCardsCreateRequest): Signable {
	return([
		'cards:create',
		request.wallet.chain,
		request.wallet.currency,
		request.wallet.address,
		canonicalControls(request.controls ?? {}),
		request.label ?? ''
	]);
}

export function getCardActionSignable(action: 'get' | 'freeze' | 'unfreeze' | 'close', request: KeetaCardsCardActionRequest): Signable {
	return([`cards:${action}`, request.id]);
}

export function getListCardsSignable(): Signable {
	return(['cards:list']);
}

export function getUpdateControlsSignable(request: KeetaCardsUpdateControlsRequest): Signable {
	return(['cards:controls', request.id, canonicalControls(request.controls)]);
}

export function getRevealCardSignable(request: KeetaCardsRevealRequest): Signable {
	return(['cards:reveal', request.id, request.clientNonce]);
}

/**
 * Check a controls object for values a card issuer would reject or that make
 * no sense.  Throws with a message suitable for the caller.
 */
export function assertValidCardControls(controls: CardControls): void {
	const cents = ['perPurchaseLimitCents', 'lifetimeLimitCents'] as const;
	for (const key of cents) {
		const value = controls[key];
		if (value === undefined) {
			continue;
		}

		if (!Number.isSafeInteger(value) || value <= 0) {
			throw(new Error(`${key} must be a positive whole number of cents`));
		}
	}

	const categoryPattern = /^[0-9]{4}$/;
	for (const key of ['allowedCategories', 'blockedCategories'] as const) {
		for (const code of controls[key] ?? []) {
			if (!categoryPattern.test(code)) {
				throw(new Error(`${key} must contain four-digit merchant category codes`));
			}
		}
	}

	if (controls.expiresAt !== undefined && Number.isNaN(Date.parse(controls.expiresAt))) {
		throw(new Error('expiresAt must be an ISO 8601 date'));
	}
}

/**
 * Check a funding wallet address.  Only EVM-style addresses are accepted for
 * now, which covers Base, Ethereum and Tempo.
 */
export function assertValidFundingWallet(wallet: CardFundingWallet): void {
	if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) {
		throw(new Error('wallet.address must be a 0x-prefixed 20-byte address'));
	}

	if (!/^[a-z0-9_-]{1,32}$/.test(wallet.chain)) {
		throw(new Error('wallet.chain is not valid'));
	}

	if (!/^[a-z0-9]{1,16}$/.test(wallet.currency)) {
		throw(new Error('wallet.currency is not valid'));
	}
}
