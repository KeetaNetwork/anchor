import { test } from 'vitest';
import type { TokenMetadataJSON } from './token-metadata.js';
import { decodeTokenMetadata, encodeTokenMetadata } from './token-metadata.js';
import { KeetaAnchorUserValidationError } from './error.js';

test('Token metadata encoding / decoding', async function({ expect }) {
	const tests: [TokenMetadataJSON   | string, string][] = [
		[
			{
				decimalPlaces: 6,
				logoURI: 'https://example.com/logo.png'
			},
			'eyJsb2dvVVJJIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9sb2dvLnBuZyIsImRlY2ltYWxQbGFjZXMiOjZ9' // cspell:disable-line
		],
		[ { decimalPlaces: 18 }, 'eyJkZWNpbWFsUGxhY2VzIjoxOH0=' ], // cspell:disable-line
		[ { decimalPlaces: '18' }, 'eyJkZWNpbWFsUGxhY2VzIjoxOH0=' ] // cspell:disable-line
	] as const;

	let testIndex = -1;
	for (const test of tests) {
		testIndex++;


		let decoded;
		let encoded;
		try {
			decoded = decodeTokenMetadata(test[0]);
			encoded = encodeTokenMetadata(decoded);
			expect(decodeTokenMetadata(encoded)).toEqual(decodeTokenMetadata(test[1]));
		} catch (error) {
			console.error(`Decoding failed for test #${testIndex}`, test);
			throw(error);
		}

		try {
			expect(encoded).toEqual(test[1]);
		} catch (error) {
			console.error(`Re-encoding failed for test #${testIndex}`, test);
			throw(error);
		}
	}

	const invalidTests: (TokenMetadataJSON | string)[] = [
		{ decimalPlaces: -1 },
		{ decimalPlaces: 'abc' },
		{ decimalPlaces: 1.5 },
		{ decimalPlaces: '' }
	];

	for (const test of invalidTests) {
		try {
			decodeTokenMetadata(test);
			expect(false).toBe(true); // Should not reach this line
		} catch (error) {
			if (!(error instanceof KeetaAnchorUserValidationError)) {
				throw(error);
			}

			expect(error.fields[0]?.path).toBe('decimalPlaces');
		}
	}
})
