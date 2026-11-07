/**
 * Helpers for the stablecoin wallet that funds an agent's card.
 *
 * The owner holds the wallet's key.  Funds reach it from the agent spending
 * account through an asset-movement transfer (Keeta USDC to Base), the card
 * issuer pulls only what is spent, and the rest is swept back to the
 * spending account after settlement or kept for the next purchase, as the
 * owner prefers.
 *
 * Everything here is pure: it builds calldata and plans amounts, and leaves
 * signing and sending to the wallet.
 */
import { USDC_UNITS_PER_CENT } from './mock-provider.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT256_MAX = (1n << 256n) - 1n;

/* First four bytes of keccak256 of each signature */
const SELECTOR_APPROVE = '095ea7b3'; /* approve(address,uint256) */
const SELECTOR_TRANSFER = 'a9059cbb'; /* transfer(address,uint256) */

function encodeAddress(address: string): string {
	if (!ADDRESS_PATTERN.test(address)) {
		throw(new Error(`Not a 20-byte address: ${address}`));
	}

	return(address.slice(2).toLowerCase().padStart(64, '0'));
}

function encodeUint256(value: bigint): string {
	if (value < 0n || value > UINT256_MAX) {
		throw(new Error('Amount does not fit in a uint256'));
	}

	return(value.toString(16).padStart(64, '0'));
}

/**
 * Calldata for `approve(spender, units)` on the stablecoin contract, which
 * lets the card issuer's spender contract pull up to `units` at
 * authorization.  Approving the funded amount, not an unlimited allowance,
 * keeps the approval itself a limit.
 */
export function encodeERC20Approve(spender: string, units: bigint): string {
	return(`0x${SELECTOR_APPROVE}${encodeAddress(spender)}${encodeUint256(units)}`);
}

/** Calldata for `transfer(to, units)`, used to sweep leftovers back */
export function encodeERC20Transfer(to: string, units: bigint): string {
	return(`0x${SELECTOR_TRANSFER}${encodeAddress(to)}${encodeUint256(units)}`);
}

export type CardFundingPolicy = {
	/** The buffer as a share of the cart, in basis points (default 1000, 10%) */
	bufferBasisPoints?: number;
	/** The smallest buffer, in cents (default 500, $5) */
	minimumBufferCents?: number;
	/** The largest buffer, in cents (default 5000, $50) */
	maximumBufferCents?: number;
};

export type CardFundingPlan = {
	cartCents: number;
	bufferCents: number;
	/** What to move to the wallet now, after what it already holds */
	transferCents: number;
	/** What to approve for the issuer's spender: everything in the wallet */
	approveUnits: bigint;
};

function assertCents(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw(new Error(`${name} must be a whole, non-negative number of cents`));
	}
}

/**
 * How much to send to the card wallet before a purchase.  The issuer may
 * authorize a little more than the cart (tax, tip, currency conversion,
 * reserves), so the wallet gets the cart plus a buffer: the larger of a
 * share of the cart and a floor, capped.  Whatever the wallet already holds
 * counts toward it.
 */
export function planCardFunding(cartCents: number, walletBalanceCents: number, policy: CardFundingPolicy = {}): CardFundingPlan {
	assertCents('cartCents', cartCents);
	assertCents('walletBalanceCents', walletBalanceCents);

	const basisPoints = policy.bufferBasisPoints ?? 1000;
	const minimum = policy.minimumBufferCents ?? 500;
	const maximum = policy.maximumBufferCents ?? 5000;
	if (minimum > maximum) {
		throw(new Error('minimumBufferCents is larger than maximumBufferCents'));
	}

	const share = Math.ceil(cartCents * basisPoints / 10_000);
	const bufferCents = Math.min(Math.max(share, minimum), maximum);
	const needed = cartCents + bufferCents;
	const transferCents = Math.max(needed - walletBalanceCents, 0);

	return({
		cartCents,
		bufferCents,
		transferCents,
		approveUnits: BigInt(walletBalanceCents + transferCents) * USDC_UNITS_PER_CENT
	});
}

export type CardSweepPolicy = {
	/**
	 * Keep up to this much on the wallet for the next purchase instead of
	 * sweeping it back, so the owner does not pay the transfer fee twice.
	 * Zero (the default) sweeps everything.
	 */
	keepUpToCents?: number;
	/**
	 * Do not sweep amounts at or below this, because the transfer fee would
	 * eat most of it.  Defaults to zero.
	 */
	minimumSweepCents?: number;
};

export type CardSweepPlan = {
	action: 'wait' | 'keep' | 'sweep';
	sweepCents: number;
	keepCents: number;
	reason: string;
};

/**
 * What to do with what is left on the wallet.  Nothing moves while
 * purchases are still pending settlement, because a final capture can be
 * larger than its authorization and refunds land on the wallet.
 */
export function planCardSweep(walletBalanceCents: number, pendingAuthorizations: number, policy: CardSweepPolicy = {}): CardSweepPlan {
	assertCents('walletBalanceCents', walletBalanceCents);
	const keepUpTo = policy.keepUpToCents ?? 0;
	const minimumSweep = policy.minimumSweepCents ?? 0;

	if (pendingAuthorizations > 0) {
		return({ action: 'wait', sweepCents: 0, keepCents: walletBalanceCents, reason: 'purchases are still settling' });
	}

	const toSweep = Math.max(walletBalanceCents - keepUpTo, 0);
	if (toSweep === 0) {
		return({ action: 'keep', sweepCents: 0, keepCents: walletBalanceCents, reason: 'within what the owner keeps on the card' });
	}

	if (toSweep <= minimumSweep) {
		return({ action: 'keep', sweepCents: 0, keepCents: walletBalanceCents, reason: 'too small to be worth the transfer fee' });
	}

	return({ action: 'sweep', sweepCents: toSweep, keepCents: walletBalanceCents - toSweep, reason: 'returning leftovers to the spending account' });
}
