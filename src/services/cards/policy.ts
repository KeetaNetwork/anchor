/**
 * The rules the cards anchor applies when the issuer asks, in real time,
 * whether to approve a purchase.  Pure, so it can be tested on its own and
 * reused by any provider integration.
 */
import type { CardAuthorizationDecision, CardAuthorizationRequest, CardDetails } from './common.js';

export type CardAuthorizationContext = {
	card: CardDetails | null;
	/**
	 * Whether the account that created the card can still act for the
	 * storage account.  False once the owner revokes the agent, which stops
	 * its cards at the next purchase.
	 */
	creatorStillAuthorized: boolean;
	now: Date;
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

	return({ approved: true });
}
