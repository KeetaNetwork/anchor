import { test, expect } from 'vitest';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import type {
	AnchorExternalAddOptions,
	AnchorExternalEntry,
	AnchorExternalErrorCode
} from './anchor-external.js';
import {
	AnchorExternal,
	AnchorExternalBuilder,
	AnchorExternalError,
	ANCHOR_EXTERNAL_VERSION
} from './anchor-external.js';
import { EncryptedContainer } from './encrypted-container.js';
import { KeetaAnchorError } from './error.js';
import { canonicalizeJson } from './utils/signing.js';
import { Buffer, arrayBufferToBuffer } from './utils/buffer.js';

const Account: typeof KeetaNetLib.Account = KeetaNetLib.Account;
type Account = InstanceType<typeof KeetaNetLib.Account>;

/*
 * Fixed-seed accounts: deterministic across test runs and across all
 * round-trip variants.
 */
const anchor1 = Account.fromSeed('A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1', 0);
const anchor2 = Account.fromSeed('B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2', 0);
const stranger = Account.fromSeed('C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3', 0);

const anchor1Key = anchor1.publicKeyString.get();
const anchor2Key = anchor2.publicKeyString.get();

/*
 * Fixed binding values used wherever a test requires a signed slice.
 */
const TEST_BINDING_PREVIOUS_BLOCK_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_BINDING_OPERATION_INDEX = 3;
const TEST_BINDING = { previousBlockHash: TEST_BINDING_PREVIOUS_BLOCK_HASH, operationIndex: TEST_BINDING_OPERATION_INDEX };
const TEST_ENCODED_BINDING = { p: TEST_BINDING_PREVIOUS_BLOCK_HASH, o: TEST_BINDING_OPERATION_INDEX };

type ModeSpec = {
	name: string;
	options: AnchorExternalAddOptions | undefined;
	decryptionKeys: Account[];
	expectedEncrypted: boolean;
	expectedSigned: boolean;
};

const modeSpecs: ModeSpec[] = [
	{
		name: 'plain-unsigned',
		options: undefined,
		decryptionKeys: [],
		expectedEncrypted: false,
		expectedSigned: false
	},
	{
		name: 'plain-signed',
		options: { signer: anchor1, binding: TEST_BINDING },
		decryptionKeys: [],
		expectedEncrypted: false,
		expectedSigned: true
	},
	{
		name: 'encrypted-unsigned',
		options: { encryptFor: [anchor2] },
		decryptionKeys: [anchor2],
		expectedEncrypted: true,
		expectedSigned: false
	},
	{
		name: 'encrypted-signed',
		options: { signer: anchor1, encryptFor: [anchor1], binding: TEST_BINDING },
		decryptionKeys: [anchor1],
		expectedEncrypted: true,
		expectedSigned: true
	}
];

const entryCases: { name: string; entry: AnchorExternalEntry }[] = [
	{ name: 'transactionId', entry: { transactionId: 'tx-12345' }},
	{ name: 'persistentForwardingId', entry: { persistentForwardingId: 'fwd-67890' }},
	{ name: 'destination', entry: { destination: '0x0000000000000000000000000000000000000000' }}
];

type RoundTripCase = {
	name: string;
	entry: AnchorExternalEntry;
	mode: ModeSpec;
};

const roundTripCases: RoundTripCase[] = entryCases.flatMap(function(entryCase) {
	return(modeSpecs.map(function(mode) {
		return({
			name: `${entryCase.name} / ${mode.name}`,
			entry: entryCase.entry,
			mode
		});
	}));
});

test.each(roundTripCases)('round-trips $name', async function({ entry, mode }) {
	const external = await new AnchorExternalBuilder().addAnchor(anchor1, entry, mode.options).build();

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys: mode.decryptionKeys });
	const slice = decoded.envelope.anchors[anchor1Key];
	expect(decoded.envelope.version).toBe(ANCHOR_EXTERNAL_VERSION);
	expect(slice?.entry).toEqual(entry);
	expect(slice?.encrypted).toBe(mode.expectedEncrypted);
	expect(slice?.kind).toBe('account');
	expect(slice?.signer?.comparePublicKey(anchor1) ?? false).toBe(mode.expectedSigned);
	expect(slice?.binding !== undefined).toBe(mode.expectedSigned);

	const peeked = await AnchorExternal.peek(external);
	expect(peeked).toEqual({ version: ANCHOR_EXTERNAL_VERSION, anchorIds: [anchor1Key] });
});

test('round-trip preserves multiple anchors with independent, mixed modes', async function() {
	const external = await new AnchorExternalBuilder()
		.addAnchor(anchor1, { transactionId: 'tx-1' })
		.addAnchor(anchor2, { persistentForwardingId: 'fwd-2' }, { signer: anchor2, encryptFor: [anchor2], binding: TEST_BINDING })
		.build();

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys: [anchor2] });

	const slice1 = decoded.envelope.anchors[anchor1Key];
	expect(slice1?.entry).toEqual({ transactionId: 'tx-1' });
	expect(slice1?.encrypted).toBe(false);
	expect(slice1?.signer).toBeUndefined();

	const slice2 = decoded.envelope.anchors[anchor2Key];
	expect(slice2?.entry).toEqual({ persistentForwardingId: 'fwd-2' });
	expect(slice2?.encrypted).toBe(true);
	expect(slice2?.binding).toEqual(TEST_BINDING);
	expect(slice2?.signer?.comparePublicKey(anchor2)).toBe(true);
});

test('encrypted slices without a matching key surface as opaque', async function() {
	const external = await new AnchorExternalBuilder()
		.addAnchor(anchor1, { transactionId: 'tx-1' })
		.addAnchor(anchor2, { persistentForwardingId: 'fwd-2' }, { encryptFor: [anchor2] })
		.build();

	const withoutKey = await AnchorExternal.fromExternal(external);
	expect(withoutKey.envelope.anchors[anchor1Key]?.entry).toEqual({ transactionId: 'tx-1' });
	expect(withoutKey.envelope.anchors[anchor2Key]).toEqual({ encrypted: true });

	const withKey = await AnchorExternal.fromExternal(external, { decryptionKeys: [anchor2] });
	expect(withKey.envelope.anchors[anchor2Key]?.entry).toEqual({ persistentForwardingId: 'fwd-2' });
	expect(withKey.envelope.anchors[anchor2Key]?.encrypted).toBe(true);
});

test('an encrypted slice stays opaque when only a non-recipient key is supplied', async function() {
	const external = await new AnchorExternalBuilder()
		.addAnchor(anchor1, { transactionId: 'tx-1' })
		.addAnchor(anchor2, { persistentForwardingId: 'fwd-2' }, { encryptFor: [anchor2] })
		.build();

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys: [stranger] });
	expect(decoded.envelope.anchors[anchor1Key]?.entry).toEqual({ transactionId: 'tx-1' });
	expect(decoded.envelope.anchors[anchor2Key]).toEqual({ encrypted: true });
});

const multiPrincipalCases: { name: string; key: Account }[] = [
	{ name: 'anchor1', key: anchor1 },
	{ name: 'anchor2', key: anchor2 }
];

test.each(multiPrincipalCases)('a slice encrypted for many opens for listed principal $name', async function({ key }) {
	const external = await new AnchorExternalBuilder()
		.addAnchor(anchor1, { transactionId: 'tx-multi' }, { encryptFor: [anchor1, anchor2] })
		.build();

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys: [key] });
	const slice = decoded.envelope.anchors[anchor1Key];
	expect(slice?.entry).toEqual({ transactionId: 'tx-multi' });
	expect(slice?.encrypted).toBe(true);
});

const PROVIDER_ID = 'fx-provider-1';

type ProviderRoundTripCase = {
	name: string;
	options: { encryptFor?: Account[] } | undefined;
	decryptionKeys: Account[];
	expectedEncrypted: boolean;
};

const providerRoundTripCases: ProviderRoundTripCase[] = [
	{ name: 'plaintext', options: undefined, decryptionKeys: [], expectedEncrypted: false },
	{ name: 'encrypted', options: { encryptFor: [anchor1] }, decryptionKeys: [anchor1], expectedEncrypted: true }
];

test.each(providerRoundTripCases)('round-trips a $name provider slice keyed by provider id', async function({ options, decryptionKeys, expectedEncrypted }) {
	const external = await new AnchorExternalBuilder().addProvider(PROVIDER_ID, { transactionId: 'tx-1' }, options).build();

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys });
	const slice = decoded.envelope.anchors[PROVIDER_ID];
	expect(slice?.entry).toEqual({ transactionId: 'tx-1' });
	expect(slice?.encrypted).toBe(expectedEncrypted);
	expect(slice?.kind).toBe('provider');
	expect(slice?.signer).toBeUndefined();

	const peeked = await AnchorExternal.peek(external);
	expect(peeked.anchorIds).toContain(PROVIDER_ID);
});

test('a provider slice and an account slice coexist in one envelope', async function() {
	const external = await new AnchorExternalBuilder()
		.addAnchor(anchor1, { transactionId: 'tx-account' })
		.addProvider(PROVIDER_ID, { destination: 'evm:0x1' })
		.build();

	const decoded = await AnchorExternal.fromExternal(external);
	expect(decoded.envelope.anchors[anchor1Key]?.kind).toBe('account');
	expect(decoded.envelope.anchors[PROVIDER_ID]?.kind).toBe('provider');
	expect(decoded.envelope.anchors[PROVIDER_ID]?.entry).toEqual({ destination: 'evm:0x1' });
});

type MisuseCase = {
	name: string;
	act: () => unknown;
};

const misuseCases: MisuseCase[] = [
	{
		name: 'signer is not the anchor the slice is filed under',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { signer: stranger, binding: TEST_BINDING }));
		}
	},
	{
		name: 'signer set without binding',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { signer: anchor1 }));
		}
	},
	{
		name: 'binding set without signer',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { binding: TEST_BINDING }));
		}
	},
	{
		name: 'encryptFor is an empty list',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { encryptFor: [] }));
		}
	},
	{
		name: 'addProvider with an empty provider id',
		act: function() {
			return(new AnchorExternalBuilder().addProvider('', { transactionId: 'x' }));
		}
	},
	{
		name: 'addProvider with an empty encryptFor list',
		act: function() {
			return(new AnchorExternalBuilder().addProvider(PROVIDER_ID, { transactionId: 'x' }, { encryptFor: [] }));
		}
	},
	{
		name: 'binding with empty previousBlockHash',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { signer: anchor1, binding: { previousBlockHash: '', operationIndex: 0 }}));
		}
	},
	{
		name: 'binding with negative operationIndex',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { signer: anchor1, binding: { previousBlockHash: TEST_BINDING_PREVIOUS_BLOCK_HASH, operationIndex: -1 }}));
		}
	},
	{
		name: 'binding with non-integer operationIndex',
		act: function() {
			return(new AnchorExternalBuilder().addAnchor(anchor1, { transactionId: 'x' }, { signer: anchor1, binding: { previousBlockHash: TEST_BINDING_PREVIOUS_BLOCK_HASH, operationIndex: 1.5 }}));
		}
	},
	{
		name: 'maxLength too tight for a signed payload',
		act: function() {
			return(new AnchorExternalBuilder()
				.addAnchor(anchor1, { transactionId: 'x' }, { signer: anchor1, binding: TEST_BINDING })
				.withMaxLength(64)
				.build());
		}
	},
	{
		name: 'withMaxLength rejects non-positive eagerly',
		act: function() { return(new AnchorExternalBuilder().withMaxLength(0)); }
	},
	{
		name: 'withMaxLength rejects non-integer eagerly',
		act: function() { return(new AnchorExternalBuilder().withMaxLength(1.5)); }
	}
];

test.each(misuseCases)('builder misuse throws KeetaAnchorError: $name', async function({ act }) {
	const result = (async function() { return(await act()); })();
	const error = await result.catch(function(caught: unknown) { return(caught); });
	expect(KeetaAnchorError.isInstance(error)).toBe(true);
	expect(AnchorExternalError.isInstance(error)).toBe(false);
});

/*
 * Build a single per-anchor slice container as base64, bypassing the
 * builder's invariants so decoder-side enforcement can be exercised.
 */
async function packSlice(encodedSlice: object, signer: Account | undefined, principals: Account[] | null): Promise<string> {
	const plaintext = Buffer.from(canonicalizeJson(encodedSlice), 'utf-8');
	let options: { signer?: Account } | undefined;
	if (signer !== undefined) {
		options = { signer };
	}

	const container = EncryptedContainer.fromPlaintext(plaintext, principals, options);
	const encoded = arrayBufferToBuffer(await container.getEncodedBuffer());
	const result = encoded.toString('base64');
	return(result);
}

type V1ExpectedSlice = {
	entry: AnchorExternalEntry;
	encrypted: boolean;
	signerKey?: string;
	binding?: typeof TEST_BINDING;
};

type V1DecodeCase = {
	name: string;
	encoded: object;
	signer?: Account;
	principals: Account[] | null;
	decryptionKeys: Account[];
	expected: { [anchorPublicKey: string]: V1ExpectedSlice };
	peekIds: string[];
};

const v1DecodeCases: V1DecodeCase[] = [
	{
		name: 'plaintext',
		encoded: { v: 1, a: { [anchor1Key]: { t: 'tx-1' }, [anchor2Key]: { p: 'fwd-2' }}},
		principals: null,
		decryptionKeys: [],
		expected: {
			[anchor1Key]: { entry: { transactionId: 'tx-1' }, encrypted: false },
			[anchor2Key]: { entry: { persistentForwardingId: 'fwd-2' }, encrypted: false }
		},
		peekIds: [ anchor1Key, anchor2Key ]
	},
	{
		name: 'signed',
		encoded: { v: 1, a: { [anchor1Key]: { t: 'tx-1' }, [anchor2Key]: { d: 'evm:0x1' }}, b: TEST_ENCODED_BINDING },
		signer: anchor1,
		principals: null,
		decryptionKeys: [],
		expected: {
			[anchor1Key]: { entry: { transactionId: 'tx-1' }, encrypted: false, signerKey: anchor1Key, binding: TEST_BINDING },
			[anchor2Key]: { entry: { destination: 'evm:0x1' }, encrypted: false }
		},
		peekIds: [ anchor1Key, anchor2Key ]
	},
	{
		name: 'encrypted',
		encoded: { v: 1, a: { [anchor1Key]: { t: 'tx-1' }}},
		principals: [ anchor1 ],
		decryptionKeys: [ anchor1 ],
		expected: {
			[anchor1Key]: { entry: { transactionId: 'tx-1' }, encrypted: true }
		},
		peekIds: []
	}
];

test.each(v1DecodeCases)('fromExternal decodes a v1 $name envelope', async function({ encoded, signer, principals, decryptionKeys, expected, peekIds }) {
	const external = await packSlice(encoded, signer, principals);

	const decoded = await AnchorExternal.fromExternal(external, { decryptionKeys });
	expect(decoded.envelope.version).toBe(1);

	for (const [ anchorPublicKey, slice ] of Object.entries(expected)) {
		const decodedSlice = decoded.envelope.anchors[anchorPublicKey];
		expect(decodedSlice?.entry).toEqual(slice.entry);
		expect(decodedSlice?.encrypted).toBe(slice.encrypted);
		expect(decodedSlice?.signer?.publicKeyString.get()).toBe(slice.signerKey);
		expect(decodedSlice?.binding).toEqual(slice.binding);
	}

	const peeked = await AnchorExternal.peek(external);
	expect(peeked.version).toBe(1);
	expect([ ...peeked.anchorIds ].sort()).toEqual([ ...peekIds ].sort());
});

test('a v1 encrypted envelope stays opaque without a matching key', async function() {
	const external = await packSlice({ v: 1, a: { [anchor1Key]: { t: 'tx-1' }}}, undefined, [ anchor1 ]);

	const locked = await AnchorExternal.fromExternal(external);
	expect(locked.envelope.version).toBe(1);
	expect(locked.envelope.anchors).toEqual({});

	const wrongKey = await AnchorExternal.fromExternal(external, { decryptionKeys: [ stranger ] });
	expect(wrongKey.envelope.anchors).toEqual({});
});

/*
 * Base64-encode a (possibly malformed) outer envelope object.
 */
function encodeOuter(outer: object): string {
	const result = Buffer.from(canonicalizeJson(outer), 'utf-8').toString('base64');
	return(result);
}

/*
 * Assemble a canonical outer envelope around prebuilt anchor slices.
 */
function packOuter(anchors: { [anchorPublicKey: string]: string }): string {
	const result = encodeOuter({ version: ANCHOR_EXTERNAL_VERSION, anchors: anchors });
	return(result);
}

type DecodeRejectionCase = {
	name: string;
	makeExternal: () => Promise<string>;
	expectedCode: AnchorExternalErrorCode;
};

const decodeRejectionCases: DecodeRejectionCase[] = [
	{
		name: 'outer is not valid base64',
		makeExternal: async function() { return('not base64!'); },
		expectedCode: 'BAD_BASE64'
	},
	{
		name: 'outer is not valid JSON',
		makeExternal: async function() { return(Buffer.from('not json', 'utf-8').toString('base64')); },
		expectedCode: 'NOT_AN_ENVELOPE'
	},
	{
		name: 'v2-shaped envelope with an unsupported version is rejected',
		makeExternal: async function() { return(encodeOuter({ version: 99, anchors: {}})); },
		expectedCode: 'UNSUPPORTED_VERSION'
	},
	{
		name: 'outer with an extra top-level key',
		makeExternal: async function() { return(encodeOuter({ version: ANCHOR_EXTERNAL_VERSION, anchors: {}, extra: 1 })); },
		expectedCode: 'NOT_AN_ENVELOPE'
	},
	{
		name: 'non-canonical outer JSON',
		makeExternal: async function() {
			const reshaped = canonicalizeJson({ version: ANCHOR_EXTERNAL_VERSION, anchors: {}}).replace(/,/g, ', ');
			return(Buffer.from(reshaped, 'utf-8').toString('base64'));
		},
		expectedCode: 'NON_CANONICAL'
	},
	{
		name: 'slice value is not a container',
		makeExternal: async function() { return(packOuter({ [anchor1Key]: Buffer.from([ 1, 2, 3, 4 ]).toString('base64') })); },
		expectedCode: 'INVALID_SLICE'
	},
	{
		name: 'slice entry has an extra key',
		makeExternal: async function() {
			const slice = await packSlice({ t: 'x', extra: 'y' }, undefined, null);
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'INVALID_SLICE'
	},
	{
		name: 'slice plaintext exceeds the size cap',
		makeExternal: async function() {
			const slice = await packSlice({ t: 'x'.repeat(5000) }, undefined, null);
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'PLAINTEXT_TOO_LARGE'
	},
	{
		name: 'non-canonical slice plaintext',
		makeExternal: async function() {
			const reshaped = canonicalizeJson({ t: 'x', b: TEST_ENCODED_BINDING }).replace(/,/g, ', ');
			const plaintext = Buffer.from(reshaped, 'utf-8');
			const container = EncryptedContainer.fromPlaintext(plaintext, null, undefined);
			const slice = arrayBufferToBuffer(await container.getEncodedBuffer()).toString('base64');
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'NON_CANONICAL'
	},
	{
		name: 'slice signer does not match the anchor id',
		makeExternal: async function() {
			const slice = await packSlice({ t: 'x', b: TEST_ENCODED_BINDING }, stranger, null);
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'SIGNER_NOT_ANCHOR'
	},
	{
		name: 'signed slice missing binding',
		makeExternal: async function() {
			const slice = await packSlice({ t: 'x' }, anchor1, null);
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'MISSING_BINDING'
	},
	{
		name: 'unsigned slice carries a binding',
		makeExternal: async function() {
			const slice = await packSlice({ t: 'x', b: TEST_ENCODED_BINDING }, undefined, null);
			return(packOuter({ [anchor1Key]: slice }));
		},
		expectedCode: 'UNEXPECTED_BINDING'
	}
];

test.each(decodeRejectionCases)('fromExternal rejects malformed input with $expectedCode: $name', async function({ makeExternal, expectedCode }) {
	const external = await makeExternal();

	const error = await AnchorExternal.fromExternal(external).catch(function(caught: unknown) { return(caught); });
	expect(AnchorExternalError.isInstance(error)).toBe(true);

	if (AnchorExternalError.isInstance(error)) {
		expect(error.code).toBe(expectedCode);
	}
});

test('AnchorExternalError preserves its code through to/fromJSON', async function() {
	const original = new AnchorExternalError('NON_CANONICAL', 'sample');
	const restored = await AnchorExternalError.fromJSON(original.toJSON());
	expect(AnchorExternalError.isInstance(restored) && restored.code).toBe('NON_CANONICAL');
});
