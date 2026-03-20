import { test } from 'vitest';
import type { TokenMetadataJSON } from './token-metadata.js';
import { decodeTokenMetadata, encodeTokenMetadata } from './token-metadata.js';

test('Token metadata encoding / decoding', async function({ expect }) {
	const tests: [TokenMetadataJSON   | string, string][] = [
		[
			{
				decimalPlaces: 6,
				logoURI: "https://example.com/logo.png"
			},
			"eyJsb2dvVVJJIjoiaHR0cHM6Ly9leGFtcGxlLmNvbS9sb2dvLnBuZyIsImRlY2ltYWxQbGFjZXMiOjZ9"
		],
		[
			{ decimalPlaces: 18 },
			'eyJkZWNpbWFsUGxhY2VzIjoxOH0='
		],
		[
			{ decimalPlaces: '18' },
			'eyJkZWNpbWFsUGxhY2VzIjoxOH0='
		]
	] as const;

	for (const test of tests) {
		const decoded = decodeTokenMetadata(test[0]);
		const encoded = encodeTokenMetadata(decoded);

		expect(decodeTokenMetadata(encoded)).toEqual(decodeTokenMetadata(test[1]));
		expect(encoded).toEqual(test[1]);
	}
})
