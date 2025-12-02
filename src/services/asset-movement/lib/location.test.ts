import { test, expect } from 'vitest';
import type { AssetLocationString, ChainLocationType } from './location.js';
import { convertAssetLocationInputToCanonical, convertAssetLocationToString, isChainLocation, toAssetLocation, toAssetLocationFromString } from './location.js';

test('Asset Location Encoding/Decoding', async function() {
	const validTests: AssetLocationString[] = [
		'chain:keeta:1234',
		'chain:evm:1',
		'chain:solana:5eykt4UsFv8PxNnGf1x2oBo3qET8C4xQ3d9KZunbVFTL',
		'chain:bitcoin:0b110907',
		'chain:tron:mainnet',
		'bank-account:us'
	];

	for (const testStr of validTests) {
		const decoded = toAssetLocationFromString(testStr);
		const reEncoded = convertAssetLocationToString(decoded);

		expect(convertAssetLocationToString(toAssetLocation(testStr))).toBe(testStr);
		expect(convertAssetLocationToString(toAssetLocation(decoded))).toBe(testStr);
		expect(convertAssetLocationToString(testStr)).toBe(testStr);
		expect(convertAssetLocationInputToCanonical(testStr)).toBe(testStr);
		expect(convertAssetLocationInputToCanonical(decoded)).toBe(testStr);
		expect(reEncoded).toBe(testStr);
	}

	const invalidTests: string[] = [
		'chain',
		'chain:keeta:not-a-number',
		'chain:keeta:-1',
		'chain:evm:-1',
		'chain:solana:invalid-genesis-hash',
		'chain:bitcoin:invalid-magic-bytes',
		'chain:tron:invalid-network-alias',
		'bank-account',
		'bank-account:',
		'bank-account:invalid',
		'unknown-kind:data',
		'chain:unknown-chain:1234'
	];

	for (const testStr of invalidTests) {
		expect(() => toAssetLocationFromString(testStr)).toThrow();
	}
});


test('Location Utils', async function() {
	const isChainLocationTests: [ AssetLocationString, ChainLocationType | undefined, boolean ][] = [
		[ 'chain:keeta:1234', undefined, true ],
		[ 'chain:keeta:1234', 'keeta', true ],
		[ 'chain:keeta:1234', 'evm', false ],
		[ 'chain:evm:1', 'evm', true ],
		[ 'chain:solana:5eykt4UsFv8PxNnGf1x2oBo3qET8C4xQ3d9KZunbVFTL', 'solana', true ],
		[ 'chain:bitcoin:0b110907', 'bitcoin', true ],
		[ 'chain:tron:mainnet', 'tron', true ],
		[ 'bank-account:us', 'keeta', false ],
		[ 'bank-account:us', undefined, false ]
	];

	for (const [ testStr, checkType, expected ] of isChainLocationTests) {
		expect(isChainLocation(toAssetLocation(testStr), checkType)).toBe(expected);
	}
});
