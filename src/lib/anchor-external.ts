import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import { assertEncodedAnchorExternalEnvelopeV1 } from './anchor-external.generated.js';
import { EncryptedContainer, EncryptedContainerError } from './encrypted-container.js';
import { KeetaAnchorError, KeetaAnchorUserError, KeetaAnchorUserValidationError } from './error.js';
import { canonicalizeJson } from './utils/signing.js';
import { Buffer, arrayBufferToBuffer, decodeBase64Strict } from './utils/buffer.js';

type Account = InstanceType<typeof KeetaNetLib.Account>;

/**
 * Upper bound on inflated container plaintext, before JSON parsing.
 *
 * Prevents an attacker from forcing a large allocation via a
 * high-ratio gzip payload.
 */
const MAX_PLAINTEXT_BYTES = 4096;

/**
 * Current envelope format version.
 */
export const ANCHOR_EXTERNAL_VERSION = 1;

// #region Public types

/**
 * Per-anchor entry.
 */
export type AnchorExternalEntry =
	| {
		/**
		 * Transaction id at the anchor.
		 */
		transactionId: string;
	}
	| {
		/**
		 * Persistent forwarding id at the anchor.
		 */
		persistentForwardingId: string;
	}
	| {
		/**
		 * Opaque destination data interpreted by the anchor (e.g. an EVM
		 * address for an EVM anchor).
		 */
		destination: string;
	};

/**
 * Replay-protection binding for a signed envelope.
 *
 * Pins the signature to a specific position on the signer's account
 * chain so the same signed envelope cannot be reused on a different
 * operation or block.
 */
export type AnchorExternalBinding = {
	/**
	 * Block hash that the signer's account had as its head when the
	 * SEND carrying this envelope was constructed.
	 */
	previousBlockHash: string;
	/**
	 * Index of the SEND operation within its block.
	 */
	operationIndex: number;
};

/**
 * Decoded anchor-external envelope as exposed to callers.
 */
export type AnchorExternalEnvelope = {
	/**
	 * Envelope format version.
	 */
	version: typeof ANCHOR_EXTERNAL_VERSION;
	/**
	 * Per-anchor entries keyed by `Account.publicKeyString.get()`.
	 */
	anchors: { [anchorPublicKey: string]: AnchorExternalEntry };
	/**
	 * Signature binding. Present if the envelope is signed.
	 */
	binding?: AnchorExternalBinding;
};

/**
 * Authenticity record attached to a verified signed envelope. Present only
 * when the signature was verified and the signer appears in
 * {@link AnchorExternalEnvelope.anchors}.
 */
export type AnchorExternalSigned = {
	signer: Account;
};

/**
 * Shape inspection result from {@link AnchorExternal.peek}.
 */
export type AnchorExternalPeekResult = {
	encrypted: boolean;
	signed: boolean;
};

// #endregion

// #region Encoded form types (module-internal, exported for tests)

/**
 * Per-anchor entry as it appears in the encoded envelope.
 *
 * `t` = transaction id, `p` = persistent forwarding id, `d` = destination.
 *
 * Note: Single-letter keys keep the envelope smaller.
 */
export type EncodedAnchorExternalEntryV1 =
	| { t: string }
	| { p: string }
	| { d: string };

/**
 * Replay-protection binding as it appears in the encoded envelope.
 *
 * `p` = previous block hash, `o` = operation index.
 */
export type EncodedAnchorExternalBindingV1 = {
	p: string;
	o: number;
};

/**
 * Anchor-external envelope as it appears inside the encoded blob.
 *
 * `v` = envelope version, `a` = anchors, `b` = binding.
 */
export type EncodedAnchorExternalEnvelopeV1 = {
	v: typeof ANCHOR_EXTERNAL_VERSION;
	a: { [anchorPublicKey: string]: EncodedAnchorExternalEntryV1 };
	b?: EncodedAnchorExternalBindingV1;
};

// #endregion

// #region Error Handling

/**
 * Error codes for anchor-external envelope operations.
 */
export const AnchorExternalErrorCodes = [
	/*
	 * Parsing
	 */
	'BAD_BASE64',
	'NOT_AN_ENVELOPE',
	'UNSUPPORTED_VERSION',
	'NON_CANONICAL',
	'PLAINTEXT_TOO_LARGE',

	/*
	 * Non-repudiation
	 */
	'BAD_SIGNATURE',
	'SIGNER_NOT_LISTED',
	'MISSING_BINDING',
	'UNEXPECTED_BINDING',

	/*
	 * Confidentiality
	 */
	'EXPECTED_PLAIN',
	'EXPECTED_ENCRYPTED',

	/*
	 * Caller-declared budget
	 */
	'OUTPUT_TOO_LARGE'
] as const;

export type AnchorExternalErrorCode = typeof AnchorExternalErrorCodes[number];

const anchorExternalErrorCodeSet: ReadonlySet<string> = new Set(AnchorExternalErrorCodes);

/**
 * Error raised by anchor-external decode failures.
 */
export class AnchorExternalError extends KeetaAnchorUserError {
	static override readonly name: string = 'AnchorExternalError';

	private readonly anchorExternalErrorObjectTypeID!: string;
	private static readonly anchorExternalErrorObjectTypeID = '2db22831-216b-4b3e-952a-5f9860f0790b';

	readonly code: AnchorExternalErrorCode;

	/**
	 * Type-narrow an arbitrary string to {@link AnchorExternalErrorCode}.
	 */
	static isValidCode(code: string): code is AnchorExternalErrorCode {
		return(anchorExternalErrorCodeSet.has(code));
	}

	constructor(code: AnchorExternalErrorCode, message: string) {
		super(message);
		this.code = code;

		Object.defineProperty(this, 'anchorExternalErrorObjectTypeID', {
			value: AnchorExternalError.anchorExternalErrorObjectTypeID,
			enumerable: false
		});
	}

	static override isInstance(input: unknown): input is AnchorExternalError {
		return(this.hasPropWithValue(input, 'anchorExternalErrorObjectTypeID', AnchorExternalError.anchorExternalErrorObjectTypeID));
	}

	override toJSON(): ReturnType<KeetaAnchorUserError['toJSON']> & { code: AnchorExternalErrorCode } {
		return({
			...super.toJSON(),
			code: this.code
		});
	}

	static override async fromJSON(input: unknown): Promise<AnchorExternalError> {
		const { message, other } = this.extractErrorProperties(input, this);

		if (!('code' in other) || typeof other.code !== 'string') {
			throw(new Error('Invalid AnchorExternalError JSON: missing code property'));
		}

		const code = other.code;
		if (!this.isValidCode(code)) {
			throw(new Error(`Invalid AnchorExternalError JSON: unknown code ${code}`));
		}

		const error = new this(code, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

// #endregion

// #region Encoded <-> Public mappers

/**
 * Convert a public entry to an encoded entry.
 */
function entryToEncoded(entry: AnchorExternalEntry): EncodedAnchorExternalEntryV1 {
	if ('transactionId' in entry) {
		return({ t: entry.transactionId });
	}
	if ('persistentForwardingId' in entry) {
		return({ p: entry.persistentForwardingId });
	}

	return({ d: entry.destination });
}

/**
 * Convert an encoded entry to a public entry.
 */
function entryFromEncoded(entry: EncodedAnchorExternalEntryV1): AnchorExternalEntry {
	if ('t' in entry) {
		return({ transactionId: entry.t });
	}
	if ('p' in entry) {
		return({ persistentForwardingId: entry.p });
	}

	return({ destination: entry.d });
}

/**
 * Convert a public envelope to an encoded envelope.
 */
function envelopeToEncoded(envelope: AnchorExternalEnvelope): EncodedAnchorExternalEnvelopeV1 {
	const encodedAnchors: { [anchorPublicKey: string]: EncodedAnchorExternalEntryV1 } = {};
	for (const [pk, entry] of Object.entries(envelope.anchors)) {
		encodedAnchors[pk] = entryToEncoded(entry);
	}

	const result: EncodedAnchorExternalEnvelopeV1 = {
		v: ANCHOR_EXTERNAL_VERSION,
		a: encodedAnchors
	};
	if (envelope.binding !== undefined) {
		result.b = { p: envelope.binding.previousBlockHash, o: envelope.binding.operationIndex };
	}

	return(result);
}

/**
 * Convert an encoded envelope to a public envelope.
 */
function envelopeFromEncoded(encoded: EncodedAnchorExternalEnvelopeV1): AnchorExternalEnvelope {
	const anchors: { [anchorPublicKey: string]: AnchorExternalEntry } = {};
	for (const [pk, entry] of Object.entries(encoded.a)) {
		anchors[pk] = entryFromEncoded(entry);
	}

	const result: AnchorExternalEnvelope = {
		version: ANCHOR_EXTERNAL_VERSION,
		anchors
	};
	if (encoded.b !== undefined) {
		result.binding = { previousBlockHash: encoded.b.p, operationIndex: encoded.b.o };
	}

	return(result);
}

/**
 * Parse an encoded envelope.
 */
function parseEncodedEnvelope(value: unknown): EncodedAnchorExternalEnvelopeV1 {
	try {
		return(assertEncodedAnchorExternalEnvelopeV1(value));
	} catch (error) {
		if (KeetaAnchorUserValidationError.isTypeGuardErrorLike(error)) {
			if (error.path === '$input.v') {
				throw(new AnchorExternalError('UNSUPPORTED_VERSION', `Unsupported envelope version at ${error.path}: ${String(error.value)}`));
			}

			throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Envelope failed shape check at ${error.path ?? '$input'}: expected ${error.expected}`));
		}

		throw(error);
	}
}

/**
 * Check if a signer is listed in the envelope.anchors.
 */
function signerListed(envelope: AnchorExternalEnvelope, signer: Account): boolean {
	const signerKey = signer.publicKeyString.get();
	return(signerKey in envelope.anchors);
}

/**
 * Validate the shape of a {@link AnchorExternalBinding}.
 *
 * @returns `undefined` if valid, or an error message.
 */
function validateBindingShape(binding: AnchorExternalBinding): string | undefined {
	if (typeof binding.previousBlockHash !== 'string' || binding.previousBlockHash.length === 0) {
		return('binding.previousBlockHash must be a non-empty string');
	}
	if (!Number.isInteger(binding.operationIndex) || binding.operationIndex < 0) {
		return(`binding.operationIndex must be a non-negative integer, got ${binding.operationIndex}`);
	}

	return(undefined);
}

/**
 * Decode the base64-encoded string.
 */
function decodeExternal(external: string): Buffer {
	const decoded = decodeBase64Strict(external);
	if (decoded === undefined) {
		throw(new AnchorExternalError('BAD_BASE64', 'External string is not valid base64 or decoded to zero bytes'));
	}

	return(decoded);
}

// #endregion

// #region AnchorExternalBuilder

/**
 * Fluent builder for constructing an anchor-external envelope and producing
 * its encoded SEND.external string.
 */
export class AnchorExternalBuilder {
	readonly #anchors: { [anchorPublicKey: string]: AnchorExternalEntry } = {};
	#signer: Account | undefined;
	#principals: Account[] | undefined;
	#maxLength: number | undefined;
	#binding: AnchorExternalBinding | undefined;

	/**
	 * Set the entry for a given anchor, replacing any prior entry
	 * for the same anchor.
	 */
	setAnchor(anchor: Account, entry: AnchorExternalEntry): this {
		this.#anchors[anchor.publicKeyString.get()] = entry;
		return(this);
	}

	/**
	 * Sign the produced envelope with the given account.
	 */
	withSigner(signer: Account): this {
		this.#signer = signer;
		return(this);
	}

	/**
	 * Encrypt the produced envelope so each listed principal can decrypt
	 * it. Omit to leave the envelope as plaintext.
	 */
	withPrincipals(principals: Account[]): this {
		this.#principals = principals;
		return(this);
	}

	/**
	 * Bind the produced signature to a position on the signer's
	 * account chain. Required whenever {@link withSigner} is used.
	 *
	 * @param previousBlockHash Block hash of the signer's current head.
	 * @param operationIndex    Index of the SEND operation within its block.
	 */
	withBinding(previousBlockHash: string, operationIndex: number): this {
		const candidate: AnchorExternalBinding = { previousBlockHash, operationIndex };
		const error = validateBindingShape(candidate);
		if (error !== undefined) {
			throw(new KeetaAnchorError(`withBinding: ${error}`));
		}

		this.#binding = candidate;
		return(this);
	}

	/**
	 * Set an upper bound on the encoded output length. {@link build}
	 * throws if the produced string would exceed this length.
	 */
	withMaxLength(maxLength: number): this {
		if (!Number.isInteger(maxLength) || maxLength <= 0) {
			throw(new KeetaAnchorError(`withMaxLength requires a positive integer, got ${maxLength}`));
		}

		this.#maxLength = maxLength;
		return(this);
	}

	/**
	 * Snapshot of the envelope as it would be encoded right now.
	 */
	toEnvelope(): AnchorExternalEnvelope {
		const result: AnchorExternalEnvelope = {
			version: ANCHOR_EXTERNAL_VERSION,
			anchors: { ...this.#anchors }
		};

		if (this.#binding !== undefined) {
			result.binding = { ...this.#binding };
		}

		return(result);
	}

	/**
	 * Produce the encoded SEND.external string.
	 *
	 * @throws {@link KeetaAnchorError} on caller misuse.
	 */
	async build(): Promise<string> {
		const envelope = this.toEnvelope();

		if (this.#signer !== undefined && !signerListed(envelope, this.#signer)) {
			throw(new KeetaAnchorError('Signer is not listed in envelope.anchors'));
		}
		if (this.#signer !== undefined && this.#binding === undefined) {
			throw(new KeetaAnchorError('Signed envelopes require withBinding(previousBlockHash, operationIndex) for replay protection'));
		}
		if (this.#signer === undefined && this.#binding !== undefined) {
			throw(new KeetaAnchorError('withBinding is only valid for signed envelopes'));
		}

		const encoded = envelopeToEncoded(envelope);
		const canonical = canonicalizeJson(encoded);
		const plaintext = Buffer.from(canonical, 'utf-8');

		const principals = this.#principals ?? null;
		let containerOptions: { signer: Account } | undefined;
		if (this.#signer !== undefined) {
			containerOptions = { signer: this.#signer };
		}

		const container = EncryptedContainer.fromPlaintext(plaintext, principals, containerOptions);
		const containerBuffer = arrayBufferToBuffer(await container.getEncodedBuffer());
		const external = containerBuffer.toString('base64');

		if (this.#maxLength !== undefined && external.length > this.#maxLength) {
			throw(new KeetaAnchorError(`Encoded external length ${external.length} exceeds caller maxLength ${this.#maxLength}`));
		}

		return(external);
	}
}

// #endregion

// #region AnchorExternal

/**
 * Immutable, verified view of a parsed SEND.external envelope.
 */
export class AnchorExternal {
	static readonly Builder: typeof AnchorExternalBuilder = AnchorExternalBuilder;

	readonly #envelope: AnchorExternalEnvelope;
	readonly #encrypted: boolean;
	readonly #signed: AnchorExternalSigned | undefined;

	private constructor(envelope: AnchorExternalEnvelope, encrypted: boolean, signed: AnchorExternalSigned | undefined) {
		this.#envelope = envelope;
		this.#encrypted = encrypted;
		this.#signed = signed;
	}

	/**
	 * Decoded envelope.
	 */
	get envelope(): AnchorExternalEnvelope {
		return(this.#envelope);
	}

	/**
	 * `true` if the source blob was encrypted.
	 */
	get encrypted(): boolean {
		return(this.#encrypted);
	}

	/**
	 * Authenticity record for a verified signed envelope, or `undefined`
	 * if the envelope was not signed.
	 */
	get signed(): AnchorExternalSigned | undefined {
		return(this.#signed);
	}

	/**
	 * Decode an external string asserted to be plaintext.
	 *
	 * @throws {@link AnchorExternalError} `EXPECTED_PLAIN` if the source blob is encrypted.
	 */
	static async fromPlainExternal(external: string): Promise<AnchorExternal> {
		const buffer = decodeExternal(external);

		let container: EncryptedContainer;
		try {
			container = EncryptedContainer.fromEncodedBuffer(buffer, null);
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				if (error.code === 'INVALID_PRINCIPALS') {
					throw(new AnchorExternalError('EXPECTED_PLAIN', 'Blob is encrypted but plaintext was expected'));
				}
				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Container parse failed: ${error.code}`));
			}
			throw(error);
		}

		if (container.encrypted) {
			throw(new AnchorExternalError('EXPECTED_PLAIN', 'Blob is encrypted but plaintext was expected'));
		}

		const result = await AnchorExternal.fromContainer(container, false);
		return(result);
	}

	/**
	 * Decode an external string asserted to be encrypted under one of the
	 * supplied principals.
	 *
	 * @throws {@link AnchorExternalError} `EXPECTED_ENCRYPTED` if the source blob is plaintext.
	 * @throws {@link KeetaAnchorError} if `principals` is empty.
	 */
	static async fromEncryptedExternal(external: string, principals: Account[]): Promise<AnchorExternal> {
		if (principals.length === 0) {
			throw(new KeetaAnchorError('AnchorExternal.fromEncryptedExternal requires at least one principal'));
		}

		const buffer = decodeExternal(external);
		let container: EncryptedContainer;
		try {
			container = EncryptedContainer.fromEncryptedBuffer(buffer, principals);
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				if (error.code === 'ENCRYPTION_REQUIRED') {
					throw(new AnchorExternalError('EXPECTED_ENCRYPTED', 'Blob is plaintext but encrypted was expected'));
				}

				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Container parse failed: ${error.code}`));
			}

			throw(error);
		}

		if (!container.encrypted) {
			throw(new AnchorExternalError('EXPECTED_ENCRYPTED', 'Blob is plaintext but encrypted was expected'));
		}

		const result = await AnchorExternal.fromContainer(container, true);
		return(result);
	}

	/**
	 * Inspect encrypted/signed flags of a candidate external string
	 * without reading plaintext or requiring a decryption key.
	 */
	static async peek(external: string): Promise<AnchorExternalPeekResult> {
		const buffer = decodeExternal(external);
		let container: EncryptedContainer;
		try {
			container = EncryptedContainer.fromEncodedBuffer(buffer, []);
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Container parse failed: ${error.code}`));
			}

			throw(error);
		}

		return({
			encrypted: container.encrypted,
			signed: container.isSigned
		});
	}

	/**
	 * Create an {@link AnchorExternal} from a container.
	 */
	private static async fromContainer(container: EncryptedContainer, encrypted: boolean): Promise<AnchorExternal> {
		const envelope = await AnchorExternal.readEnvelope(container);
		const signed = await AnchorExternal.readSigned(container, envelope);
		const result = new AnchorExternal(envelope, encrypted, signed);
		return(result);
	}

	/**
	 * Read the envelope from a container.
	 */
	private static async readEnvelope(container: EncryptedContainer): Promise<AnchorExternalEnvelope> {
		let plaintextArrayBuffer: ArrayBuffer;
		try {
			plaintextArrayBuffer = await container.getPlaintext();
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Container plaintext unavailable: ${error.code}`));
			}
			throw(error);
		}

		if (plaintextArrayBuffer.byteLength > MAX_PLAINTEXT_BYTES) {
			throw(new AnchorExternalError('PLAINTEXT_TOO_LARGE', `Container plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`));
		}

		const plaintextBuffer = arrayBufferToBuffer(plaintextArrayBuffer);
		const plaintextString = plaintextBuffer.toString('utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(plaintextString);
		} catch {
			throw(new AnchorExternalError('NOT_AN_ENVELOPE', 'Container plaintext is not valid JSON'));
		}

		const encoded = parseEncodedEnvelope(parsed);

		/*
		 * Reject non-canonical encodings: an attacker could otherwise
		 * mutate the JSON shape under a still-valid signature on the
		 * original bytes.
		 */
		const reCanonical = canonicalizeJson(encoded);
		if (reCanonical !== plaintextString) {
			throw(new AnchorExternalError('NON_CANONICAL', 'Container plaintext is not JCS-canonical'));
		}

		const result = envelopeFromEncoded(encoded);
		return(result);
	}

	/**
	 * Read the signed record from a container.
	 */
	private static async readSigned(container: EncryptedContainer, envelope: AnchorExternalEnvelope): Promise<AnchorExternalSigned | undefined> {
		if (!container.isSigned) {
			if (envelope.binding !== undefined) {
				throw(new AnchorExternalError('UNEXPECTED_BINDING', 'Unsigned envelope carries a binding'));
			}

			return(undefined);
		}

		if (envelope.binding === undefined) {
			throw(new AnchorExternalError('MISSING_BINDING', 'Signed envelope is missing required binding'));
		}

		let valid: boolean;
		try {
			valid = await container.verifySignature();
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				throw(new AnchorExternalError('BAD_SIGNATURE', `Signature verification failed: ${error.code}`));
			}

			throw(error);
		}

		if (!valid) {
			throw(new AnchorExternalError('BAD_SIGNATURE', 'Signature did not verify against the contained plaintext'));
		}

		const signer = container.getSigningAccount();
		if (signer === undefined) {
			throw(new AnchorExternalError('BAD_SIGNATURE', 'Container is signed but the signing account is unavailable'));
		}

		if (!signerListed(envelope, signer)) {
			throw(new AnchorExternalError('SIGNER_NOT_LISTED', 'Signing account is not listed in envelope.anchors'));
		}

		return({ signer });
	}
}

// #endregion
