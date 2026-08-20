import { describe, expect, it } from 'vitest';

import type { AmountLocation } from './amount.js';
import { KeetaAnchorAmount } from './amount.js';
import { KeetaAssetMovementTransferError } from './transfer-error.js';
import { KeetaNet } from '../../../client/index.js';

const USD_ASSET = '$USD';

const TOKEN_ASSET = KeetaNet.lib.Account
	.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0)
	.generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 1)
	.publicKeyString.get();

const BANK_LOCATION: AmountLocation = {
	assets: [ { id: USD_ASSET, decimals: 2 } ]
};

const CHAIN_LOCATION: AmountLocation = {
	assets: [ { id: USD_ASSET, decimals: 6 } ]
};

/**
 * The transfer error code `fn` throws, `'NONE'` when it returns.
 */
function thrownErrorCode(fn: () => unknown): string {
	try {
		fn();
		return('NONE');
	} catch (error) {
		if (KeetaAssetMovementTransferError.isInstance(error)) {
			return(error.code);
		}

		return('OTHER');
	}
}

describe('KeetaAnchorAmount', function() {
	it('carries value, decimals, and asset', function() {
		const amount = new KeetaAnchorAmount(100n, 2, USD_ASSET);
		expect(amount.value).toBe(100n);
		expect(amount.decimals).toBe(2);
		expect(amount.asset).toBe(USD_ASSET);
	});

	it('rejects a fractional or negative precision', function() {
		expect(thrownErrorCode(function() {
			return(new KeetaAnchorAmount(1n, 1.5, USD_ASSET));
		})).toBe('INVALID_AMOUNT');

		expect(thrownErrorCode(function() {
			return(new KeetaAnchorAmount(1n, -1, USD_ASSET));
		})).toBe('INVALID_AMOUNT');
	});

	it('adopts a token amount at the token precision', function() {
		const amount = KeetaAnchorAmount.fromToken(1_000_000n, {
			tokenPublicKey: TOKEN_ASSET,
			decimals: 6
		});
		expect(amount.value).toBe(1_000_000n);
		expect(amount.decimals).toBe(6);
		expect(amount.asset).toBe(TOKEN_ASSET);
		expect(amount.toMajor()).toBe('1.000000');
	});

	it('rescales up without loss and back down', function() {
		const cents = new KeetaAnchorAmount(100n, 2, USD_ASSET);
		const micro = cents.toDecimals(6);
		expect(micro.value).toBe(1_000_000n);
		expect(micro.decimals).toBe(6);
		expect(micro.toDecimals(2).value).toBe(100n);
	});

	it('rejects a downscale that would lose precision', function() {
		const micro = new KeetaAnchorAmount(1_000_001n, 6, USD_ASSET);
		expect(thrownErrorCode(function() {
			return(micro.toDecimals(2));
		})).toBe('INVALID_AMOUNT');
	});

	it('converts to a location precision and transport value', function() {
		const cents = new KeetaAnchorAmount(100n, 2, USD_ASSET);
		expect(cents.toLocationValue(BANK_LOCATION)).toBe('100');
		expect(cents.toLocationValue(CHAIN_LOCATION)).toBe('1000000');
		expect(cents.toLocationDecimals(CHAIN_LOCATION).decimals).toBe(6);
	});

	it('rejects a location that does not serve the asset', function() {
		const tokenAmount = new KeetaAnchorAmount(1n, 6, TOKEN_ASSET);
		expect(thrownErrorCode(function() {
			return(tokenAmount.toLocationValue(BANK_LOCATION));
		})).toBe('UNSUPPORTED_LOCATION_ASSET');
	});

	it('compares equal across precisions of the same asset', function() {
		const cents = new KeetaAnchorAmount(100n, 2, USD_ASSET);
		const micro = new KeetaAnchorAmount(1_000_000n, 6, USD_ASSET);
		const other = new KeetaAnchorAmount(1_000_000n, 6, TOKEN_ASSET);
		expect(cents.equals(micro)).toBe(true);
		expect(micro.equals(cents)).toBe(true);
		expect(micro.equals(other)).toBe(false);
		expect(cents.equals(new KeetaAnchorAmount(101n, 2, USD_ASSET))).toBe(false);
	});
});
