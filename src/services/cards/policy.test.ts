import { expect, test } from 'vitest';
import type { CardDetails } from './common.js';
import { assertValidCardControls, assertValidFundingWallet, canonicalControls } from './common.js';
import { decideCardAuthorization } from './policy.js';

const now = new Date('2026-11-07T12:00:00Z');

function card(overrides: Partial<CardDetails> = {}): CardDetails {
	return({
		id: 'ic_test',
		account: 'keeta_storage',
		createdBy: 'keeta_agent',
		status: 'active',
		last4: '4242',
		expiry: '11/29',
		wallet: { chain: 'base', currency: 'usdc', address: '0x' + '1'.repeat(40) },
		controls: {},
		spentCents: 0,
		createdAt: now.toISOString(),
		...overrides
	});
}

const groceries = { name: 'Corner Grocer', categoryCode: '5411' };

function decide(details: CardDetails | null, amountCents: number, options: { creatorStillAuthorized?: boolean; merchant?: typeof groceries; } = {}) {
	return(decideCardAuthorization(
		{ cardID: 'ic_test', amountCents, merchant: options.merchant ?? groceries },
		{ card: details, creatorStillAuthorized: options.creatorStillAuthorized ?? true, now }
	));
}

test('approves a purchase on an active card with no controls', function() {
	expect(decide(card(), 12_00)).toEqual({ approved: true });
});

test('declines in a fixed order of checks', function() {
	expect(decide(null, 1)).toEqual({ approved: false, reason: 'card_not_found' });
	expect(decide(card({ status: 'frozen' }), 1)).toEqual({ approved: false, reason: 'card_not_active' });
	expect(decide(card({ status: 'closed' }), 1, { creatorStillAuthorized: false })).toEqual({ approved: false, reason: 'card_not_active' });
	expect(decide(card(), 1, { creatorStillAuthorized: false })).toEqual({ approved: false, reason: 'delegate_revoked' });
	expect(decide(card({ controls: { expiresAt: '2026-11-07T11:59:59Z' }}), 1)).toEqual({ approved: false, reason: 'card_expired' });
	expect(decide(card({ controls: { expiresAt: '2026-11-07T12:00:01Z' }}), 1)).toEqual({ approved: true });
});

test('enforces per-purchase and lifetime limits', function() {
	const limited = card({ controls: { perPurchaseLimitCents: 50_00, lifetimeLimitCents: 100_00 }, spentCents: 60_00 });
	expect(decide(limited, 50_01)).toEqual({ approved: false, reason: 'over_per_purchase_limit' });
	expect(decide(limited, 40_01)).toEqual({ approved: false, reason: 'over_lifetime_limit' });
	expect(decide(limited, 40_00)).toEqual({ approved: true });
});

test('enforces merchant categories', function() {
	const allowList = card({ controls: { allowedCategories: ['5411'] }});
	expect(decide(allowList, 1)).toEqual({ approved: true });
	expect(decide(allowList, 1, { merchant: { name: 'Casino', categoryCode: '7995' }})).toEqual({ approved: false, reason: 'merchant_category_not_allowed' });

	const blockList = card({ controls: { blockedCategories: ['7995'] }});
	expect(decide(blockList, 1)).toEqual({ approved: true });
	expect(decide(blockList, 1, { merchant: { name: 'Casino', categoryCode: '7995' }})).toEqual({ approved: false, reason: 'merchant_category_blocked' });
});

test('canonical controls do not depend on field or list order', function() {
	expect(canonicalControls({ singleUse: true, allowedCategories: ['5812', '5411'] })).toBe(canonicalControls({ allowedCategories: ['5411', '5812'], singleUse: true }));
	expect(canonicalControls({})).toBe('{}');
});

test('rejects invalid controls and wallets', function() {
	expect(function() { assertValidCardControls({ perPurchaseLimitCents: 0 }); }).toThrow(/positive whole number/);
	expect(function() { assertValidCardControls({ lifetimeLimitCents: 1.5 }); }).toThrow(/positive whole number/);
	expect(function() { assertValidCardControls({ allowedCategories: ['54'] }); }).toThrow(/four-digit/);
	expect(function() { assertValidCardControls({ expiresAt: 'tomorrow' }); }).toThrow(/ISO 8601/);
	expect(function() { assertValidCardControls({ perPurchaseLimitCents: 100, blockedCategories: ['7995'] }); }).not.toThrow();

	expect(function() { assertValidFundingWallet({ chain: 'base', currency: 'usdc', address: '0x123' }); }).toThrow(/20-byte/);
	expect(function() { assertValidFundingWallet({ chain: 'Base Mainnet', currency: 'usdc', address: '0x' + 'a'.repeat(40) }); }).toThrow(/chain/);
	expect(function() { assertValidFundingWallet({ chain: 'base', currency: 'usdc', address: '0x' + 'a'.repeat(40) }); }).not.toThrow();
});
