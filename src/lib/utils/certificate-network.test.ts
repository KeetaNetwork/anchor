import { test, expect } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import {
	certificateChainConfigFromBundle,
	DEFAULT_CERTIFICATE_BUNDLE_DELIMITER
} from './certificate-network.js';
import { buildChain, testSeed } from './tests/certificates.js';

const VALID_NETWORK = 'test';

async function makeRootPEM(seedOffset: number): Promise<string> {
	const { root } = await buildChain({
		rootIssuer: KeetaNet.lib.Account.fromSeed(testSeed, seedOffset),
		leafSubject: KeetaNet.lib.Account.fromSeed(testSeed, seedOffset + 1)
	});
	return(root.toPEM());
}

const [singleRoot, multiRootA, multiRootB, customRootA, customRootB, padRoot] = await Promise.all([
	makeRootPEM(0),
	makeRootPEM(10),
	makeRootPEM(20),
	makeRootPEM(30),
	makeRootPEM(40),
	makeRootPEM(50)
]);

test.each([
	{
		name: 'single cert, default delimiter',
		args: { pemBundle: singleRoot },
		expected: 1
	},
	{
		name: 'multi cert, default delimiter',
		args: { pemBundle: [multiRootA, multiRootB].join(DEFAULT_CERTIFICATE_BUNDLE_DELIMITER) },
		expected: 2
	},
	{
		name: 'custom delimiter',
		args: { pemBundle: [customRootA, customRootB].join('###'), delimiter: '###' },
		expected: 2
	},
	{
		name: 'trims whitespace and discards empty entries',
		args: { pemBundle: `   ${padRoot}   ${DEFAULT_CERTIFICATE_BUNDLE_DELIMITER}${DEFAULT_CERTIFICATE_BUNDLE_DELIMITER}   ` },
		expected: 1
	}
])('certificateChainConfigFromBundle: $name', function({ args, expected }) {
	const config = certificateChainConfigFromBundle({ network: VALID_NETWORK, ...args });
	expect(config.trustedIssuers).toHaveLength(expected);
	expect(config.client).toBeDefined();
});

test('certificateChainConfigFromBundle: throws when bundle yields zero certificates', function() {
	expect(function() {
		certificateChainConfigFromBundle({
			pemBundle: `   ${DEFAULT_CERTIFICATE_BUNDLE_DELIMITER}   `,
			network: VALID_NETWORK
		});
	}).toThrow(/no certificates/);
});
