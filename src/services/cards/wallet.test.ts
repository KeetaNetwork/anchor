import { expect, test } from 'vitest';
import { encodeERC20Approve, encodeERC20Transfer, planCardFunding, planCardSweep } from './wallet.js';

const spender = '0x8CC0D9e8a157b73d1172a22f5066048Bda46c0e3';

test('encodes ERC-20 approve and transfer calldata', function() {
	expect(encodeERC20Approve(spender, 1_000_000n)).toBe(
		'0x095ea7b3' +
		'0000000000000000000000008cc0d9e8a157b73d1172a22f5066048bda46c0e3' +
		'00000000000000000000000000000000000000000000000000000000000f4240'
	);
	expect(encodeERC20Transfer(spender, 1n).slice(0, 10)).toBe('0xa9059cbb');
	expect(encodeERC20Transfer(spender, 1n)).toHaveLength(2 + 8 + 64 + 64);
	expect(function() { encodeERC20Approve('0x1234', 1n); }).toThrow(/20-byte/);
	expect(function() { encodeERC20Approve(spender, -1n); }).toThrow(/uint256/);
});

test('funds the cart plus a buffer of the larger of 10% and $5, capped', function() {
	expect(planCardFunding(20_00, 0)).toMatchObject({ bufferCents: 5_00, transferCents: 25_00, approveUnits: 25_00n * 10_000n });
	expect(planCardFunding(200_00, 0)).toMatchObject({ bufferCents: 20_00, transferCents: 220_00 });
	expect(planCardFunding(2_000_00, 0)).toMatchObject({ bufferCents: 50_00, transferCents: 2_050_00 });
});

test('counts what the wallet already holds', function() {
	expect(planCardFunding(20_00, 10_00)).toMatchObject({ transferCents: 15_00, approveUnits: 25_00n * 10_000n });
	expect(planCardFunding(20_00, 40_00)).toMatchObject({ transferCents: 0, approveUnits: 40_00n * 10_000n });
	expect(function() { planCardFunding(1.5, 0); }).toThrow(/whole/);
});

test('sweeps only after settlement and respects what the owner keeps', function() {
	expect(planCardSweep(5_00, 1)).toMatchObject({ action: 'wait' });
	expect(planCardSweep(5_00, 0)).toMatchObject({ action: 'sweep', sweepCents: 5_00, keepCents: 0 });
	expect(planCardSweep(5_00, 0, { keepUpToCents: 10_00 })).toMatchObject({ action: 'keep', keepCents: 5_00 });
	expect(planCardSweep(25_00, 0, { keepUpToCents: 10_00 })).toMatchObject({ action: 'sweep', sweepCents: 15_00, keepCents: 10_00 });
	expect(planCardSweep(1_00, 0, { minimumSweepCents: 2_00 })).toMatchObject({ action: 'keep', reason: /transfer fee/ });
});
