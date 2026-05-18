import { test, expect } from 'vitest';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import type {
	AnchorExternalEntry,
	AnchorExternalErrorCode,
	EncodedAnchorExternalEnvelopeV1
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

/*
 * Anchor 1's public key string.
 */
const anchor1Key = anchor1.publicKeyString.get();

/*
 * Fixed binding values used wherever a test requires a signed envelope.
 */
const TEST_BINDING_PREVIOUS_BLOCK_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_BINDING_OPERATION_INDEX = 3;

type ModeSpec = {
	name: string;
	configure: (builder: AnchorExternalBuilder) => void;
	decode: (external: string) => Promise<AnchorExternal>;
	expectedEncrypted: boolean;
	expectedSigned: boolean;
};

const modeSpecs: ModeSpec[] = [
	{
		name: 'plain-unsigned',
		configure: function() {},
		decode: async function(external) { return(await AnchorExternal.fromPlainExternal(external)); },
		expectedEncrypted: false,
		expectedSigned: false
	},
	{
		name: 'plain-signed',
		configure: function(builder) {
			builder.withSigner(anchor1).withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX);
		},
		decode: async function(external) { return(await AnchorExternal.fromPlainExternal(external)); },
		expectedEncrypted: false,
		expectedSigned: true
	},
	{
		name: 'encrypted-unsigned',
		configure: function(builder) { builder.withPrincipals([anchor2]); },
		decode: async function(external) { return(await AnchorExternal.fromEncryptedExternal(external, [anchor2])); },
		expectedEncrypted: true,
		expectedSigned: false
	},
	{
		name: 'encrypted-signed',
		configure: function(builder) {
			builder.withSigner(anchor1).withPrincipals([anchor1]).withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX);
		},
		decode: async function(external) { return(await AnchorExternal.fromEncryptedExternal(external, [anchor1])); },
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
	const builder = new AnchorExternalBuilder().setAnchor(anchor1, entry);
	mode.configure(builder);

	const external = await builder.build();
	const decoded = await mode.decode(external);
	expect(decoded.envelope).toEqual(builder.toEnvelope());
	expect(decoded.encrypted).toBe(mode.expectedEncrypted);
	expect(decoded.signed?.signer.comparePublicKey(anchor1) ?? false).toBe(mode.expectedSigned);

	const peeked = await AnchorExternal.peek(external);
	expect(peeked).toEqual({ encrypted: mode.expectedEncrypted, signed: mode.expectedSigned });
});

test('round-trip preserves multiple anchors with mixed entry kinds', async function() {
	const builder = new AnchorExternalBuilder()
		.setAnchor(anchor1, { transactionId: 'tx-1' })
		.setAnchor(anchor2, { persistentForwardingId: 'fwd-2' })
		.withSigner(anchor2)
		.withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX);

	const external = await builder.build();
	const decoded = await AnchorExternal.fromPlainExternal(external);
	expect(decoded.envelope).toEqual(builder.toEnvelope());
	expect(decoded.envelope.binding).toEqual({ previousBlockHash: TEST_BINDING_PREVIOUS_BLOCK_HASH, operationIndex: TEST_BINDING_OPERATION_INDEX });
	expect(decoded.signed?.signer.comparePublicKey(anchor2)).toBe(true);
});

type MisuseCase = {
	name: string;
	act: () => unknown;
};

const misuseCases: MisuseCase[] = [
	{
		name: 'signer not listed in envelope.anchors',
		act: function() {
			return(new AnchorExternalBuilder()
				.setAnchor(anchor1, { transactionId: 'x' })
				.withSigner(stranger)
				.withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX)
				.build());
		}
	},
	{
		name: 'signer set without binding',
		act: function() {
			return(new AnchorExternalBuilder()
				.setAnchor(anchor1, { transactionId: 'x' })
				.withSigner(anchor1)
				.build());
		}
	},
	{
		name: 'binding set without signer',
		act: function() {
			return(new AnchorExternalBuilder()
				.setAnchor(anchor1, { transactionId: 'x' })
				.withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX)
				.build());
		}
	},
	{
		name: 'withBinding rejects empty previous eagerly',
		act: function() { return(new AnchorExternalBuilder().withBinding('', 0)); }
	},
	{
		name: 'withBinding rejects negative operationIndex eagerly',
		act: function() { return(new AnchorExternalBuilder().withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, -1)); }
	},
	{
		name: 'withBinding rejects non-integer operationIndex eagerly',
		act: function() { return(new AnchorExternalBuilder().withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, 1.5)); }
	},
	{
		name: 'maxLength too tight for a signed payload',
		act: function() {
			return(new AnchorExternalBuilder()
				.setAnchor(anchor1, { transactionId: 'x' })
				.withSigner(anchor1)
				.withBinding(TEST_BINDING_PREVIOUS_BLOCK_HASH, TEST_BINDING_OPERATION_INDEX)
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
	},
	{
		name: 'fromEncryptedExternal with empty principals list',
		act: async function() {
			const external = await new AnchorExternalBuilder()
				.setAnchor(anchor1, { transactionId: 'x' })
				.withPrincipals([anchor1])
				.build();
			return(await AnchorExternal.fromEncryptedExternal(external, []));
		}
	}
];

test.each(misuseCases)('builder/decoder misuse throws KeetaAnchorError: $name', async function({ act }) {
	const result = (async function() { return(await act()); })();
	const error = await result.catch(function(caught: unknown) { return(caught); });
	expect(KeetaAnchorError.isInstance(error)).toBe(true);
	expect(AnchorExternalError.isInstance(error)).toBe(false);
});

type DecoderKind = 'plain' | 'encrypted-self' | 'encrypted-stranger';

type DecodeRejectionCase = {
	name: string;
	makeExternal: () => Promise<string>;
	decoder: DecoderKind;
	expectedCode: AnchorExternalErrorCode;
};

async function repackContainer(plaintext: Buffer, signer: Account | undefined): Promise<string> {
	const options: { signer?: Account } = {};
	if (signer !== undefined) {
		options.signer = signer;
	}

	const container = EncryptedContainer.fromPlaintext(plaintext, null, options);
	const encoded = arrayBufferToBuffer(await container.getEncodedBuffer());
	const external = encoded.toString('base64');
	return(external);
}

async function buildPlain(entry: AnchorExternalEntry): Promise<string> {
	const builder = new AnchorExternalBuilder().setAnchor(anchor1, entry);
	const external = await builder.build();
	return(external);
}

async function buildEncrypted(entry: AnchorExternalEntry, principals: Account[]): Promise<string> {
	const builder = new AnchorExternalBuilder().setAnchor(anchor1, entry).withPrincipals(principals);
	const external = await builder.build();
	return(external);
}

async function packEncoded(encoded: object, signer: Account | undefined): Promise<string> {
	const plaintext = Buffer.from(canonicalizeJson(encoded), 'utf-8');
	const external = await repackContainer(plaintext, signer);
	return(external);
}

const decoderImplementations: { [key in DecoderKind]: (external: string) => Promise<AnchorExternal> } = {
	'plain': async function(external: string) { return(await AnchorExternal.fromPlainExternal(external)); },
	'encrypted-self': async function(external: string) { return(await AnchorExternal.fromEncryptedExternal(external, [anchor1])); },
	'encrypted-stranger': async function(external: string) { return(await AnchorExternal.fromEncryptedExternal(external, [stranger])); }
};

const decodeRejectionCases: DecodeRejectionCase[] = [
	{
		name: 'bad base64',
		makeExternal: async function() { return('not base64!'); },
		decoder: 'plain',
		expectedCode: 'BAD_BASE64'
	},
	{
		name: 'truncated DER',
		makeExternal: async function() {
			const valid = await buildPlain({ transactionId: 'x' });
			const decoded = Buffer.from(valid, 'base64');
			const truncated = decoded.subarray(0, Math.max(1, decoded.length - 8));
			return(Buffer.from(truncated).toString('base64'));
		},
		decoder: 'plain',
		expectedCode: 'NOT_AN_ENVELOPE'
	},
	{
		name: 'plaintext blob decoded with the encrypted decoder',
		makeExternal: async function() {
			const result = await buildPlain({ transactionId: 'x' });
			return(result);
		},
		decoder: 'encrypted-self',
		expectedCode: 'EXPECTED_ENCRYPTED'
	},
	{
		name: 'encrypted blob decoded with the plain decoder',
		makeExternal: async function() {
			const result = await buildEncrypted({ transactionId: 'x' }, [anchor1]);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'EXPECTED_PLAIN'
	},
	{
		name: 'unknown envelope version inside container plaintext',
		makeExternal: async function() {
			const result = await packEncoded({ v: 2, a: { [anchor1Key]: { t: 'x' }}}, undefined);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'UNSUPPORTED_VERSION'
	},
	{
		name: 'envelope with extra top-level key',
		makeExternal: async function() {
			const result = await packEncoded({ v: ANCHOR_EXTERNAL_VERSION, a: { [anchor1Key]: { t: 'x' }}, extra: 1 }, undefined);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'NOT_AN_ENVELOPE'
	},
	{
		name: 'entry with extra key',
		makeExternal: async function() {
			const result = await packEncoded({ v: ANCHOR_EXTERNAL_VERSION, a: { [anchor1Key]: { t: 'x', extra: 'y' }}}, undefined);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'NOT_AN_ENVELOPE'
	},
	{
		name: 'non-canonical JSON inside container plaintext',
		makeExternal: async function() {
			const valid: EncodedAnchorExternalEnvelopeV1 = { v: ANCHOR_EXTERNAL_VERSION, a: { [anchor1Key]: { t: 'x' }}};

			/*
			 * Inject a single space after each comma to break canonical
			 * form without altering structural meaning.
			 */
			const reshaped = canonicalizeJson(valid).replace(/,/g, ', ');
			const result = await repackContainer(Buffer.from(reshaped, 'utf-8'), undefined);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'NON_CANONICAL'
	},
	{
		name: 'signed but signer is not listed in envelope.anchors',
		makeExternal: async function() {
			/*
			 * Sign with stranger but list only anchor1 in
			 * envelope.anchors. The builder rejects this combination,
			 * so we synthesize the encoded plaintext directly.
			 */
			const encoded: EncodedAnchorExternalEnvelopeV1 = {
				v: ANCHOR_EXTERNAL_VERSION,
				a: { [anchor1Key]: { t: 'x' }},
				b: { p: TEST_BINDING_PREVIOUS_BLOCK_HASH, o: TEST_BINDING_OPERATION_INDEX }
			};
			const result = await packEncoded(encoded, stranger);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'SIGNER_NOT_LISTED'
	},
	{
		name: 'signed envelope missing binding',
		makeExternal: async function() {
			const encoded: EncodedAnchorExternalEnvelopeV1 = { v: ANCHOR_EXTERNAL_VERSION, a: { [anchor1Key]: { t: 'x' }}};
			const result = await packEncoded(encoded, anchor1);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'MISSING_BINDING'
	},
	{
		name: 'unsigned envelope carries a binding',
		makeExternal: async function() {
			const encoded: EncodedAnchorExternalEnvelopeV1 = {
				v: ANCHOR_EXTERNAL_VERSION,
				a: { [anchor1Key]: { t: 'x' }},
				b: { p: TEST_BINDING_PREVIOUS_BLOCK_HASH, o: TEST_BINDING_OPERATION_INDEX }
			};
			const result = await packEncoded(encoded, undefined);
			return(result);
		},
		decoder: 'plain',
		expectedCode: 'UNEXPECTED_BINDING'
	},
	{
		name: 'encrypted decode with a wrong principal',
		makeExternal: async function() {
			const result = await buildEncrypted({ transactionId: 'x' }, [anchor1]);
			return(result);
		},
		decoder: 'encrypted-stranger',
		expectedCode: 'NOT_AN_ENVELOPE'
	}
];

test.each(decodeRejectionCases)('fromXExternal rejects malformed input with $expectedCode: $name', async function({ makeExternal, decoder, expectedCode }) {
	const external = await makeExternal();

	const error = await decoderImplementations[decoder](external).catch(function(caught: unknown) { return(caught); });
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
