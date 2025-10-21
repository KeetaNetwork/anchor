import { expect, test } from 'vitest';
import { assertKeetaURIString, encodeKeetaURI, type KeetaURIActions, parseKeetaURI } from './uri.js';
import { KeetaNet } from '../client/index.js';

function getAccount() {
	return(KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed(), 0));
}

function getToken() {
	return(getAccount().generateIdentifier(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN, undefined, 0));
}

function serializeAction(input: KeetaURIActions) {
	return({
		external: [],
		...input,
		to: input.to?.publicKeyString.get(),
		token: input.token?.publicKeyString.get()
	})
}

test('Basic URI tests', async function() {
	const staticToken = getToken();
	const staticAccount = getAccount();

	const testCases: (KeetaURIActions | KeetaURIActions[])[] = [
		{ type: 'send' },
		{ type: 'send', to: getAccount() },
		{ type: 'send', token: getToken() },
		{ type: 'send', value: 5n },
		{ type: 'send', external: ['note1', 'note2'] },
		{ type: 'send', to: getAccount(), token: getToken(), value: 10n, external: ['noteA', 'noteB'] },
		[
			{ type: 'send', to: staticAccount, token: staticToken, value: 10n },
			{ type: 'send', to: staticAccount, token: staticToken, value: 10n, external: [] }
		]
	];

	for (const testCase of testCases) {
		let innerItems;
		if (Array.isArray(testCase)) {
			innerItems = testCase;
		} else {
			innerItems = [testCase];
		}

		let first: KeetaURIActions | null = null;

		for (const item of innerItems) {
			const encoded = encodeKeetaURI(item);
			const decoded = parseKeetaURI(encoded);
			expect(serializeAction(decoded)).toEqual(serializeAction(item));
			expect(encoded).toEqual(encodeKeetaURI(decoded));
			assertKeetaURIString(encoded);

			if (first === null) {
				first = decoded;
			} else {
				expect(serializeAction(decoded)).toEqual(serializeAction(first));
			}
		}
	}

	const invalidURIs: unknown[] = [
		123,
		'https://actions/send',
		'keeta://',
		'keeta://wrongpath/send',
		'keeta://actions/unknownaction',
		'keeta://actions/send/extra/path',
		'keeta://actions/send?value=notanumber'
	];

	for (const invalidURI of invalidURIs) {
		// @ts-expect-error
		expect(() => parseKeetaURI(invalidURI)).toThrow();
		expect(() => assertKeetaURIString(invalidURI)).toThrow();
	}
});
