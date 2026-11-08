/**
 * The rules the cards anchor applies when the issuer asks, in real time,
 * whether to approve a purchase.  Pure, so it can be tested on its own and
 * reused by any provider integration.
 */
import type { CardAuthorizationDecision, CardAuthorizationRequest, CardControls, CardDetails } from './common.js';

export type CardAuthorizationContext = {
	card: CardDetails | null;
	/**
	 * Whether the account that created the card can still act for the
	 * storage account.  False once the owner revokes the agent, which stops
	 * its cards at the next purchase.
	 */
	creatorStillAuthorized: boolean;
	now: Date;
	/**
	 * What the storage account holds for card purchases, in US cents, when
	 * the anchor is configured with funding tokens.  Undefined skips the
	 * check and leaves it to the card issuer.
	 */
	availableCents?: number;
};

export function decideCardAuthorization(request: CardAuthorizationRequest, context: CardAuthorizationContext): CardAuthorizationDecision {
	const { card } = context;
	if (card === null) {
		return({ approved: false, reason: 'card_not_found' });
	}

	if (card.status !== 'active') {
		return({ approved: false, reason: 'card_not_active' });
	}

	if (!context.creatorStillAuthorized) {
		return({ approved: false, reason: 'delegate_revoked' });
	}

	const { controls } = card;
	if (controls.expiresAt !== undefined && context.now.getTime() >= Date.parse(controls.expiresAt)) {
		return({ approved: false, reason: 'card_expired' });
	}

	if (controls.perPurchaseLimitCents !== undefined && request.amountCents > controls.perPurchaseLimitCents) {
		return({ approved: false, reason: 'over_per_purchase_limit' });
	}

	if (controls.lifetimeLimitCents !== undefined && card.spentCents + request.amountCents > controls.lifetimeLimitCents) {
		return({ approved: false, reason: 'over_lifetime_limit' });
	}

	const category = request.merchant.categoryCode;
	if (controls.allowedCategories !== undefined && !controls.allowedCategories.includes(category)) {
		return({ approved: false, reason: 'merchant_category_not_allowed' });
	}

	if (controls.blockedCategories?.includes(category)) {
		return({ approved: false, reason: 'merchant_category_blocked' });
	}

	if (context.availableCents !== undefined && request.amountCents > context.availableCents) {
		return({ approved: false, reason: 'insufficient_funds' });
	}

	return({ approved: true });
}

function smaller(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) {
		return(b);
	}

	return(b === undefined ? a : Math.min(a, b));
}

/**
 * The controls for a card an agent asks for, held within a ceiling the
 * operator set (the anchor's default controls): the lower of each limit,
 * only categories both allow, every category either blocks, the earlier
 * end date, and single use if either asks for it.  An agent can tighten
 * the ceiling but never loosen it.
 */
export function tightenCardControls(ceiling: CardControls, requested: CardControls): CardControls {
	const controls: CardControls = {};

	const perPurchase = smaller(ceiling.perPurchaseLimitCents, requested.perPurchaseLimitCents);
	if (perPurchase !== undefined) {
		controls.perPurchaseLimitCents = perPurchase;
	}

	const lifetime = smaller(ceiling.lifetimeLimitCents, requested.lifetimeLimitCents);
	if (lifetime !== undefined) {
		controls.lifetimeLimitCents = lifetime;
	}

	if (ceiling.allowedCategories !== undefined && requested.allowedCategories !== undefined) {
		const allowed = new Set(ceiling.allowedCategories);
		controls.allowedCategories = requested.allowedCategories.filter(function(code) {
			return(allowed.has(code));
		});
	} else {
		const allowed = ceiling.allowedCategories ?? requested.allowedCategories;
		if (allowed !== undefined) {
			controls.allowedCategories = [...allowed];
		}
	}

	if (ceiling.blockedCategories !== undefined || requested.blockedCategories !== undefined) {
		controls.blockedCategories = [...new Set([...(ceiling.blockedCategories ?? []), ...(requested.blockedCategories ?? [])])];
	}

	if (ceiling.singleUse === true || requested.singleUse === true) {
		controls.singleUse = true;
	}

	const ends = [ceiling.expiresAt, requested.expiresAt].filter(function(value): value is string {
		return(value !== undefined);
	}).sort(function(a, b) {
		return(Date.parse(a) - Date.parse(b));
	});
	if (ends[0] !== undefined) {
		controls.expiresAt = ends[0];
	}

	return(controls);
}
