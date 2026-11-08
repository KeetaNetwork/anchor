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
 * A funding wallet the owner registered for a storage account's cards.
 * Agents may only create cards that draw on one of these, so an agent can't
 * attach a card in the owner's name to a wallet the owner never approved.
 */
export type RegisteredCardWallet = CardFundingWallet & {
	/** The owner's public key */
	registeredBy: string;
	registeredAt: string;
};

/**
 * Whether two funding wallets are the same.  EVM addresses are compared
 * without regard to case, since the checksum casing is optional.
 */
export function isSameFundingWallet(a: CardFundingWallet, b: CardFundingWallet): boolean {
	return(a.chain === b.chain && a.currency === b.currency && a.address.toLowerCase() === b.address.toLowerCase());
}

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
	/**
	 * Who approved the funding wallet: the owner named it on a card they
	 * made or replaced (`owner`), or an agent picked a wallet the owner
	 * registered (`registered`).  Agents can't name any other wallet.
	 */
	walletSource?: 'owner' | 'registered';
	/** The card this one replaced, when the owner reissued a card with a new number */
	replaces?: string;
	/** For prepaid issuers: where to send funds before the card can spend them */
	deposit?: CardFundingWallet;
	controls: CardControls;
	/**
	 * What the anchor has approved on the card.  It counts authorizations
	 * and is not reduced by reversals, refunds or a smaller final clearing
	 * amount, so the lifetime limit errs on the side of declining.
	 */
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
	/**
	 * The issuer's ID for this authorization (Lithic's ASA `token`).  A
	 * retried or replayed request with the same ID gets the first answer
	 * again and is counted once.
	 */
	authorizationID?: string;
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
	/*
	 * The purchase is more than the storage account holds in the anchor's
	 * funding tokens (only checked when the anchor is given them).
	 */
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
 * Register a funding wallet agents may use for the storage account's cards.
 * Only the owner can.  A card the owner creates registers its wallet too.
 */
export type KeetaCardsRegisterWalletRequest = {
	wallet: CardFundingWallet;
};
export type KeetaCardsRegisterWalletRequestJSON = KeetaCardsRegisterWalletRequest & SignedRequest;

/**
 * Reissue a card with a new number: the old card closes at the issuer and a
 * new one takes its limits, label, wallet and spend so far.  Only the owner
 * can.  The new card goes to `agent` (which must hold a grant on the storage
 * account now) or, without one, to the owner.  This is how a card frozen by
 * a revoke goes back into use without the revoked agent's copy of the
 * number working.
 */
export type KeetaCardsReplaceCardRequest = {
	id: string;
	/** The agent's public key; omit to give the new card to the owner */
	agent?: string;
};
export type KeetaCardsReplaceCardRequestJSON = KeetaCardsReplaceCardRequest & SignedRequest;

/**
 * Freeze every card an agent made for the storage account.  The owner's
 * wallet sends this right after revoking the agent on the network, so its
 * cards stop at the issuer at once rather than at their next purchase.
 */
export type KeetaCardsFreezeAgentCardsRequest = {
	/** The agent's public key */
	agent: string;
};
export type KeetaCardsFreezeAgentCardsRequestJSON = KeetaCardsFreezeAgentCardsRequest & SignedRequest;

export type KeetaCardsFreezeAgentCardsResult = {
	/** The agent's cards that are now frozen, including any that already were */
	cards: CardDetails[];
	/** Cards the issuer could not freeze; retrying the request tries them again */
	failed: string[];
};

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
	'revealCard' |
	'freezeAgentCards' |
	'registerWallet' |
	'listWallets' |
	'replaceCard';

/**
 * What an agent needs to pay by card: create and close cards, freeze one it
 * suspects is compromised, read them and the owner's registered wallets,
 * and open the issuer's secure display.  Unfreezing, changing limits,
 * registering wallets, replacing cards and freezing an agent's cards stay
 * with the owner.  Pass this as `delegateOperations` to switch agent
 * signing on.
 */
export const CARD_AGENT_OPERATIONS: readonly CardsOperationName[] = Object.freeze([
	'createCard',
	'listCards',
	'getCard',
	'freezeCard',
	'closeCard',
	'revealCard',
	'listWallets'
]);

/**
 * By default no operation is open to agents, as for asset movement: only
 * the owner can sign for a storage account until the operator switches
 * agent signing on.
 */
export const DEFAULT_CARD_DELEGATE_OPERATIONS: readonly CardsOperationName[] = Object.freeze([]);

/**
 * Orders strings by UTF-16 code unit, like the default sort, but explicit.
 * Not localeCompare: the signed bytes must not depend on the locale.
 */
function compareCodeUnits(a: unknown, b: unknown): number {
	const left = String(a);
	const right = String(b);
	if (left < right) {
		return(-1);
	}
	if (left > right) {
		return(1);
	}
	return(0);
}

/**
 * A stable string for a controls object, so the client and server sign the
 * same bytes whatever order the fields arrive in.
 */
export function canonicalControls(controls: CardControls): string {
	const ordered: { [key: string]: unknown } = {};
	for (const key of Object.keys(controls).sort(compareCodeUnits)) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const value = controls[key as keyof CardControls];
		if (value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			ordered[key] = [...value].sort(compareCodeUnits);
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

export function getFreezeAgentCardsSignable(request: KeetaCardsFreezeAgentCardsRequest): Signable {
	return(['cards:freeze-agent', request.agent]);
}

export function getRegisterWalletSignable(request: KeetaCardsRegisterWalletRequest): Signable {
	return(['cards:register-wallet', request.wallet.chain, request.wallet.currency, request.wallet.address]);
}

export function getListWalletsSignable(): Signable {
	return(['cards:list-wallets']);
}

export function getReplaceCardSignable(request: KeetaCardsReplaceCardRequest): Signable {
	return(['cards:replace', request.id, request.agent ?? '']);
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
