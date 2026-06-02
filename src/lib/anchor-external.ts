import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import { assertEncodedAnchorExternalEnvelopeV1, assertEncodedAnchorExternalEnvelopeV2, assertEncodedAnchorExternalSliceV1 } from './anchor-external.generated.js';
import { EncryptedContainer, EncryptedContainerError } from './encrypted-container.js';
import { KeetaAnchorError, KeetaAnchorUserError, KeetaAnchorUserValidationError } from './error.js';
import { canonicalizeJson } from './utils/signing.js';
import { Buffer, arrayBufferToBuffer, decodeBase64Strict } from './utils/buffer.js';

type Account = InstanceType<typeof KeetaNetLib.Account>;

/**
 * Upper bound on a decoded slice's plaintext. Rejects oversized slices
 * after decompression so downstream JSON parsing stays bounded.
 */
const MAX_PLAINTEXT_BYTES = 4096;

/**
 * Current envelope format version.
 *
 * v2 inverts the v1 layout: the outer envelope is plaintext and maps each
 * anchor id to its own independently framed {@link EncryptedContainer}.
 */
export const ANCHOR_EXTERNAL_VERSION = 2;

/**
 * V1 envelope format version.
 */
export const ANCHOR_EXTERNAL_VERSION_V1 = 1;

/**
 * Envelope format version a decoded {@link AnchorExternalEnvelope} reports.
 */
export type AnchorExternalVersion = typeof ANCHOR_EXTERNAL_VERSION_V1 | typeof ANCHOR_EXTERNAL_VERSION;

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
 * A single decoded slice per-anchor as exposed to callers.
 */
export type AnchorExternalSlice = {
	/**
	 * Decoded entry. `undefined` only when the slice is encrypted and no
	 * supplied decryption key could open it; the slice is then opaque.
	 */
	entry?: AnchorExternalEntry;
	/**
	 * Replay-protection binding. Present if the slice is signed.
	 */
	binding?: AnchorExternalBinding;
	/**
	 * `true` if the slice container was encrypted.
	 */
	encrypted: boolean;
	/**
	 * Verified signer of the slice. Present if the slice was signed, the
	 * signature verified, and the signer matched the anchor id the slice
	 * is filed under.
	 */
	signer?: Account;
	/**
	 * Identity kind of the key the slice is filed under: `account` (an
	 * account public key) or `provider` (a provider id, for anchors with no
	 * account).
	 */
	kind?: 'account' | 'provider';
};

/**
 * Decoded anchor-external envelope as exposed to callers.
 */
export type AnchorExternalEnvelope = {
	/**
	 * Envelope format version the source blob was decoded from.
	 */
	version: AnchorExternalVersion;
	/**
	 * Anchor id to slice mapping.
	 */
	anchors: { [anchorPublicKey: string]: AnchorExternalSlice };
};

/**
 * Per-anchor build options for {@link AnchorExternalBuilder.addAnchor}.
 */
export type AnchorExternalAddOptions = {
	/**
	 * Account that signs this anchor's slice. MUST be the same account the
	 * slice is filed under. Requires {@link AnchorExternalAddOptions.binding}.
	 */
	signer?: Account;
	/**
	 * Principals who can decrypt this anchor's slice. Omit to leave the
	 * slice as plaintext.
	 */
	encryptFor?: Account[];
	/**
	 * Replay-protection binding. Required if {@link AnchorExternalAddOptions.signer}
	 * is set, forbidden otherwise.
	 */
	binding?: AnchorExternalBinding;
};

/**
 * Decode options for {@link AnchorExternal.fromExternal}.
 */
export type AnchorExternalDecodeOptions = {
	/**
	 * Keys tried against each encrypted slice. A slice that no key can open
	 * is surfaced as an opaque slice.
	 */
	decryptionKeys?: Account[];
};

/**
 * Shape inspection result from {@link AnchorExternal.peek}.
 */
export type AnchorExternalPeekResult = {
	version: AnchorExternalVersion;
	anchorIds: string[];
};

// #endregion

// #region Encoded form types (module-internal, exported for tests)

/**
 * Replay-protection binding as it appears in an encoded slice.
 *
 * `p` = previous block hash, `o` = operation index.
 */
export type EncodedAnchorExternalBindingV1 = {
	p: string;
	o: number;
};

/**
 * A single per-anchor slice plaintext, carried inside that anchor's
 * {@link EncryptedContainer}.
 *
 * The entry discriminant (`t`/`p`/`d`) is merged with an optional binding.
 */
export type EncodedAnchorExternalSliceV1 =
	| { t: string; b?: EncodedAnchorExternalBindingV1; k?: 'provider' }
	| { p: string; b?: EncodedAnchorExternalBindingV1; k?: 'provider' }
	| { d: string; b?: EncodedAnchorExternalBindingV1; k?: 'provider' };

/**
 * Outer anchor-external envelope as it appears inside the encoded blob.
 *
 * `version` = envelope version, `anchors` = map of anchor id to that
 * anchor's base64 {@link EncryptedContainer}.
 */
export type EncodedAnchorExternalEnvelopeV2 = {
	version: typeof ANCHOR_EXTERNAL_VERSION;
	anchors: { [anchorPublicKey: string]: string };
};

/**
 * V1 per-anchor entry: `t` = transaction id, `p` = persistent forwarding id,
 * `d` = destination.
 */
export type EncodedAnchorExternalEntryV1 =
	| { t: string }
	| { p: string }
	| { d: string };

/**
 * V1 envelope plaintext. `v` = version, `a` = anchor id to entry,
 * `b` = envelope-level binding (present only when signed).
 */
export type EncodedAnchorExternalEnvelopeV1 = {
	v: typeof ANCHOR_EXTERNAL_VERSION_V1;
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
	'INVALID_SLICE',

	/*
	 * Non-repudiation
	 */
	'BAD_SIGNATURE',
	'SIGNER_NOT_ANCHOR',
	'MISSING_BINDING',
	'UNEXPECTED_BINDING',

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
 * Build the encoded slice plaintext for an entry and optional binding.
 */
function sliceToEncoded(entry: AnchorExternalEntry, binding: AnchorExternalBinding | undefined, kind: 'account' | 'provider'): EncodedAnchorExternalSliceV1 {
	let base: EncodedAnchorExternalSliceV1;
	if ('transactionId' in entry) {
		base = { t: entry.transactionId };
	} else if ('persistentForwardingId' in entry) {
		base = { p: entry.persistentForwardingId };
	} else {
		base = { d: entry.destination };
	}

	if (binding !== undefined) {
		base.b = { p: binding.previousBlockHash, o: binding.operationIndex };
	}

	if (kind === 'provider') {
		base.k = 'provider';
	}

	return(base);
}

/**
 * Extract the public entry from an encoded slice.
 */
function entryFromEncodedSlice(slice: EncodedAnchorExternalSliceV1): AnchorExternalEntry {
	if ('t' in slice) {
		return({ transactionId: slice.t });
	}
	if ('p' in slice) {
		return({ persistentForwardingId: slice.p });
	}

	return({ destination: slice.d });
}

/**
 * Extract the identity kind from an encoded slice; absent `k` means account.
 */
function kindFromEncodedSlice(slice: EncodedAnchorExternalSliceV1): 'account' | 'provider' {
	if (slice.k === 'provider') {
		return('provider');
	}

	return('account');
}

/**
 * Extract the public binding from an encoded slice, if any.
 */
function bindingFromEncodedSlice(slice: EncodedAnchorExternalSliceV1): AnchorExternalBinding | undefined {
	if (slice.b === undefined) {
		return(undefined);
	}

	return({ previousBlockHash: slice.b.p, operationIndex: slice.b.o });
}

/**
 * Short detail string for a container parse failure.
 */
function containerErrorDetail(error: unknown): string {
	if (EncryptedContainerError.isInstance(error)) {
		return(error.code);
	}

	return('malformed container');
}

/**
 * A container error meaning the supplied keys could not open it.
 */
function isContainerLocked(error: EncryptedContainerError): boolean {
	return(error.code === 'NO_KEYS_PROVIDED' || error.code === 'NO_MATCHING_KEY');
}

/**
 * Parse the outer encoded envelope.
 */
function parseEncodedEnvelope(value: unknown): EncodedAnchorExternalEnvelopeV2 {
	try {
		return(assertEncodedAnchorExternalEnvelopeV2(value));
	} catch (error) {
		if (KeetaAnchorUserValidationError.isTypeGuardErrorLike(error)) {
			if (error.path === '$input.version') {
				throw(new AnchorExternalError('UNSUPPORTED_VERSION', `Unsupported envelope version at ${error.path}: ${String(error.value)}`));
			}

			throw(new AnchorExternalError('NOT_AN_ENVELOPE', `Envelope failed shape check at ${error.path ?? '$input'}: expected ${error.expected}`));
		}

		throw(error);
	}
}

/**
 * Parse a per-anchor slice plaintext.
 */
function parseEncodedSlice(value: unknown): EncodedAnchorExternalSliceV1 {
	try {
		return(assertEncodedAnchorExternalSliceV1(value));
	} catch (error) {
		if (KeetaAnchorUserValidationError.isTypeGuardErrorLike(error)) {
			throw(new AnchorExternalError('INVALID_SLICE', `Slice failed shape check at ${error.path ?? '$input'}: expected ${error.expected}`));
		}

		throw(error);
	}
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
 * Reject an explicit but empty `encryptFor`.
 */
function assertNonEmptyPrincipals(method: string, principals: Account[] | undefined): void {
	if (principals?.length === 0) {
		throw(new KeetaAnchorError(`${method}: encryptFor must contain at least one principal`));
	}
}

/**
 * Decode a base64-encoded string into a buffer.
 */
function decodeBase64Buffer(value: string, message: string): Buffer {
	const decoded = decodeBase64Strict(value);
	if (decoded === undefined) {
		throw(new AnchorExternalError('BAD_BASE64', message));
	}

	return(decoded);
}

// #endregion

// #region AnchorExternalBuilder

type PendingSlice = {
	entry: AnchorExternalEntry;
	kind: 'account' | 'provider';
	signer?: Account;
	principals?: Account[];
	binding?: AnchorExternalBinding;
};

/**
 * Fluent builder for constructing an anchor-external envelope and producing
 * its encoded SEND.external string.
 */
export class AnchorExternalBuilder {
	readonly #slices = new Map<string, PendingSlice>();
	#maxLength: number | undefined;

	/**
	 * Add (or replace) the slice for a given anchor.
	 *
	 * @param anchor  Account the slice is filed under.
	 * @param entry   Per-anchor entry payload.
	 * @param options Per-anchor signing/encryption options.
	 *
	 * @throws {@link KeetaAnchorError} on caller misuse.
	 */
	addAnchor(anchor: Account, entry: AnchorExternalEntry, options?: AnchorExternalAddOptions): this {
		const anchorId = anchor.publicKeyString.get();
		const signer = options?.signer;
		const binding = options?.binding;
		const principals = options?.encryptFor;

		assertNonEmptyPrincipals('addAnchor', principals);

		if (signer !== undefined && signer.publicKeyString.get() !== anchorId) {
			throw(new KeetaAnchorError('addAnchor: signer must be the same account the slice is filed under'));
		}
		if (signer !== undefined && binding === undefined) {
			throw(new KeetaAnchorError('addAnchor: a signed slice requires a binding for replay protection'));
		}
		if (signer === undefined && binding !== undefined) {
			throw(new KeetaAnchorError('addAnchor: binding is only valid for a signed slice'));
		}

		if (binding !== undefined) {
			const error = validateBindingShape(binding);
			if (error !== undefined) {
				throw(new KeetaAnchorError(`addAnchor: ${error}`));
			}
		}

		const pending: PendingSlice = { entry, kind: 'account' };
		if (signer !== undefined) {
			pending.signer = signer;
		}
		if (principals !== undefined) {
			pending.principals = principals;
		}
		if (binding !== undefined) {
			pending.binding = binding;
		}

		this.#slices.set(anchorId, pending);
		return(this);
	}

	/**
	 * Add (or replace) the slice for an anchor identified only by a provider
	 * id (e.g. an FX or bridge provider with no on-chain account).
	 *
	 * @param providerId Provider id the slice is filed under.
	 * @param entry      Per-anchor entry payload.
	 * @param options    Optional encryption recipients.
	 *
	 * @throws {@link KeetaAnchorError} on caller misuse.
	 */
	addProvider(providerId: string, entry: AnchorExternalEntry, options?: { encryptFor?: Account[] }): this {
		if (providerId.length === 0) {
			throw(new KeetaAnchorError('addProvider: providerId must be a non-empty string'));
		}

		const principals = options?.encryptFor;
		assertNonEmptyPrincipals('addProvider', principals);

		const pending: PendingSlice = { entry, kind: 'provider' };
		if (principals !== undefined) {
			pending.principals = principals;
		}

		this.#slices.set(providerId, pending);
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
	 * Build a single anchor's base64 container.
	 */
	async #buildSliceContainer(pending: PendingSlice): Promise<string> {
		const encoded = sliceToEncoded(pending.entry, pending.binding, pending.kind);
		const canonical = canonicalizeJson(encoded);
		const plaintext = Buffer.from(canonical, 'utf-8');

		const principals = pending.principals ?? null;
		let containerOptions: { signer: Account } | undefined;
		if (pending.signer !== undefined) {
			containerOptions = { signer: pending.signer };
		}

		const container = EncryptedContainer.fromPlaintext(plaintext, principals, containerOptions);
		const containerBuffer = arrayBufferToBuffer(await container.getEncodedBuffer());
		const result = containerBuffer.toString('base64');
		return(result);
	}

	/**
	 * Produce the encoded SEND.external string.
	 *
	 * @throws {@link KeetaAnchorError} on caller misuse.
	 */
	async build(): Promise<string> {
		const anchors: { [anchorPublicKey: string]: string } = {};
		for (const [anchorId, pending] of this.#slices) {
			anchors[anchorId] = await this.#buildSliceContainer(pending);
		}

		const encoded: EncodedAnchorExternalEnvelopeV2 = {
			version: ANCHOR_EXTERNAL_VERSION,
			anchors: anchors
		};
		const canonical = canonicalizeJson(encoded);
		const external = Buffer.from(canonical, 'utf-8').toString('base64');

		if (this.#maxLength !== undefined && external.length > this.#maxLength) {
			throw(new KeetaAnchorError(`Encoded external length ${external.length} exceeds caller maxLength ${this.#maxLength}`));
		}

		return(external);
	}
}

// #endregion

// #region AnchorExternalV1

/**
 * Decodes V1 (single-container) external blobs into the current
 * {@link AnchorExternalEnvelope} shape.
 */
class AnchorExternalV1 {
	/**
	 * Decode a V1 blob. An encrypted blob hides its anchor ids in the
	 * ciphertext, so without a working key it yields no anchors.
	 */
	static async decode(buffer: Buffer, decryptionKeys: Account[]): Promise<AnchorExternalEnvelope> {
		const encrypted = AnchorExternalV1.probe(buffer).encrypted;
		if (encrypted && decryptionKeys.length === 0) {
			return(AnchorExternalV1.empty());
		}

		let container: EncryptedContainer;
		try {
			if (encrypted) {
				container = EncryptedContainer.fromEncryptedBuffer(buffer, decryptionKeys);
			} else {
				container = EncryptedContainer.fromEncodedBuffer(buffer, null);
			}
		} catch (error) {
			if (encrypted) {
				return(AnchorExternalV1.empty());
			}

			throw(new AnchorExternalError('NOT_AN_ENVELOPE', `V1 container parse failed: ${containerErrorDetail(error)}`));
		}

		let encoded: EncodedAnchorExternalEnvelopeV1;
		try {
			encoded = await AnchorExternalV1.readEnvelope(container);
		} catch (error) {
			if (encrypted && EncryptedContainerError.isInstance(error) && isContainerLocked(error)) {
				return(AnchorExternalV1.empty());
			}

			throw(error);
		}

		const signer = await AnchorExternalV1.verifySignature(container, encoded);
		return(AnchorExternalV1.toEnvelope(encoded, encrypted, signer));
	}

	/**
	 * Read a V1 blob's anchor ids without a decryption key.
	 */
	static async peek(buffer: Buffer): Promise<AnchorExternalPeekResult> {
		const probe = AnchorExternalV1.probe(buffer);
		if (probe.encrypted) {
			return({ version: ANCHOR_EXTERNAL_VERSION_V1, anchorIds: [] });
		}

		const container = EncryptedContainer.fromEncodedBuffer(buffer, null);
		const encoded = await AnchorExternalV1.readEnvelope(container);
		return({ version: ANCHOR_EXTERNAL_VERSION_V1, anchorIds: Object.keys(encoded.a) });
	}

	/**
	 * Frame the blob as a container to inspect its encrypted flag.
	 */
	private static probe(buffer: Buffer): EncryptedContainer {
		try {
			return(EncryptedContainer.fromEncodedBuffer(buffer, []));
		} catch (error) {
			throw(new AnchorExternalError('NOT_AN_ENVELOPE', `V1 container parse failed: ${containerErrorDetail(error)}`));
		}
	}

	/**
	 * The empty envelope yielded when an encrypted V1 blob cannot be opened.
	 */
	private static empty(): AnchorExternalEnvelope {
		return({ version: ANCHOR_EXTERNAL_VERSION_V1, anchors: {}});
	}

	/**
	 * Read and validate a V1 container's envelope plaintext.
	 */
	private static async readEnvelope(container: EncryptedContainer): Promise<EncodedAnchorExternalEnvelopeV1> {
		let plaintextArrayBuffer: ArrayBuffer;
		try {
			plaintextArrayBuffer = await container.getPlaintext();
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				if (isContainerLocked(error)) {
					throw(error);
				}

				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `V1 plaintext unavailable: ${error.code}`));
			}

			throw(error);
		}

		if (plaintextArrayBuffer.byteLength > MAX_PLAINTEXT_BYTES) {
			throw(new AnchorExternalError('PLAINTEXT_TOO_LARGE', `V1 plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`));
		}

		const plaintextString = arrayBufferToBuffer(plaintextArrayBuffer).toString('utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(plaintextString);
		} catch {
			throw(new AnchorExternalError('NOT_AN_ENVELOPE', 'V1 plaintext is not valid JSON'));
		}

		const encoded = AnchorExternalV1.parseEnvelope(parsed);

		const reCanonical = canonicalizeJson(encoded);
		if (reCanonical !== plaintextString) {
			throw(new AnchorExternalError('NON_CANONICAL', 'V1 plaintext is not JCS-canonical'));
		}

		return(encoded);
	}

	/**
	 * Parse a V1 envelope plaintext.
	 */
	private static parseEnvelope(value: unknown): EncodedAnchorExternalEnvelopeV1 {
		try {
			return(assertEncodedAnchorExternalEnvelopeV1(value));
		} catch (error) {
			if (KeetaAnchorUserValidationError.isTypeGuardErrorLike(error)) {
				if (error.path === '$input.v') {
					throw(new AnchorExternalError('UNSUPPORTED_VERSION', `Unsupported envelope version at ${error.path}: ${String(error.value)}`));
				}

				throw(new AnchorExternalError('NOT_AN_ENVELOPE', `V1 envelope failed shape check at ${error.path ?? '$input'}: expected ${error.expected}`));
			}

			throw(error);
		}
	}

	/**
	 * Verify a V1 envelope's single signature and enforce signed-iff-binding.
	 * The signer MUST be one of the anchors.
	 */
	private static async verifySignature(container: EncryptedContainer, encoded: EncodedAnchorExternalEnvelopeV1): Promise<Account | undefined> {
		if (!container.isSigned) {
			if (encoded.b !== undefined) {
				throw(new AnchorExternalError('UNEXPECTED_BINDING', 'Unsigned V1 envelope carries a binding'));
			}

			return(undefined);
		}

		if (encoded.b === undefined) {
			throw(new AnchorExternalError('MISSING_BINDING', 'Signed V1 envelope is missing required binding'));
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
			throw(new AnchorExternalError('BAD_SIGNATURE', 'V1 envelope is signed but the signing account is unavailable'));
		}

		if (!(signer.publicKeyString.get() in encoded.a)) {
			throw(new AnchorExternalError('SIGNER_NOT_ANCHOR', 'V1 signer is not listed in the envelope anchors'));
		}

		return(signer);
	}

	/**
	 * Map a verified V1 envelope onto the current per-anchor envelope shape.
	 */
	private static toEnvelope(encoded: EncodedAnchorExternalEnvelopeV1, encrypted: boolean, signer: Account | undefined): AnchorExternalEnvelope {
		const signerKey = signer?.publicKeyString.get();
		const anchors: { [anchorPublicKey: string]: AnchorExternalSlice } = {};
		for (const [anchorId, entry] of Object.entries(encoded.a)) {
			const slice: AnchorExternalSlice = { entry: AnchorExternalV1.entryFromEncoded(entry), encrypted };

			if (signer !== undefined && anchorId === signerKey) {
				slice.signer = signer;
				if (encoded.b !== undefined) {
					slice.binding = { previousBlockHash: encoded.b.p, operationIndex: encoded.b.o };
				}
			}

			anchors[anchorId] = slice;
		}

		return({ version: ANCHOR_EXTERNAL_VERSION_V1, anchors });
	}

	/**
	 * Public entry from a V1 encoded entry.
	 */
	private static entryFromEncoded(entry: EncodedAnchorExternalEntryV1): AnchorExternalEntry {
		if ('t' in entry) {
			return({ transactionId: entry.t });
		}
		if ('p' in entry) {
			return({ persistentForwardingId: entry.p });
		}

		return({ destination: entry.d });
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

	private constructor(envelope: AnchorExternalEnvelope) {
		this.#envelope = envelope;
	}

	/**
	 * Decoded envelope.
	 */
	get envelope(): AnchorExternalEnvelope {
		return(this.#envelope);
	}

	/**
	 * Decode an external string into its per-anchor slices.
	 *
	 * @throws {@link AnchorExternalError} on malformed input or failed verification.
	 */
	static async fromExternal(external: string, options?: AnchorExternalDecodeOptions): Promise<AnchorExternal> {
		const decryptionKeys = options?.decryptionKeys ?? [];
		const buffer = decodeBase64Buffer(external, 'External string is not valid base64 or decoded to zero bytes');

		if (!AnchorExternal.isV2External(buffer)) {
			const envelope = await AnchorExternalV1.decode(buffer, decryptionKeys);
			return(new AnchorExternal(envelope));
		}

		const encoded = AnchorExternal.decodeOuter(buffer);

		const anchors: { [anchorPublicKey: string]: AnchorExternalSlice } = {};
		for (const [anchorId, containerB64] of Object.entries(encoded.anchors)) {
			anchors[anchorId] = await AnchorExternal.decodeSlice(anchorId, containerB64, decryptionKeys);
		}

		const envelope: AnchorExternalEnvelope = {
			version: ANCHOR_EXTERNAL_VERSION,
			anchors
		};

		const result = new AnchorExternal(envelope);
		return(result);
	}

	/**
	 * Read the anchor ids present in an external string without decoding any
	 * slice. Encrypted V1 blobs hide their ids in the ciphertext, so
	 * `anchorIds` is empty until a key is passed to {@link fromExternal}.
	 */
	static async peek(external: string): Promise<AnchorExternalPeekResult> {
		const buffer = decodeBase64Buffer(external, 'External string is not valid base64 or decoded to zero bytes');

		if (!AnchorExternal.isV2External(buffer)) {
			const result = await AnchorExternalV1.peek(buffer);
			return(result);
		}

		const encoded = AnchorExternal.decodeOuter(buffer);
		const result: AnchorExternalPeekResult = {
			version: ANCHOR_EXTERNAL_VERSION,
			anchorIds: Object.keys(encoded.anchors)
		};
		return(result);
	}

	/**
	 * v2 is plaintext JCS JSON (begins with `{`); V1 is a DER-framed
	 * {@link EncryptedContainer} (begins with a SEQUENCE tag).
	 */
	private static isV2External(buffer: Buffer): boolean {
		return(buffer[0] === 0x7B);
	}

	/**
	 * Decode and validate the plaintext outer envelope.
	 */
	private static decodeOuter(buffer: Buffer): EncodedAnchorExternalEnvelopeV2 {
		const outerString = buffer.toString('utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(outerString);
		} catch {
			throw(new AnchorExternalError('NOT_AN_ENVELOPE', 'External is not valid JSON'));
		}

		const encoded = parseEncodedEnvelope(parsed);

		/*
		 * Reject non-canonical outer encodings so the anchor id set is
		 * unambiguous and deterministic.
		 */
		const reCanonical = canonicalizeJson(encoded);
		if (reCanonical !== outerString) {
			throw(new AnchorExternalError('NON_CANONICAL', 'Outer envelope is not JCS-canonical'));
		}

		return(encoded);
	}

	/**
	 * Decode a single per-anchor slice.
	 */
	private static async decodeSlice(anchorId: string, containerB64: string, decryptionKeys: Account[]): Promise<AnchorExternalSlice> {
		const buffer = decodeBase64Buffer(containerB64, `Slice for ${anchorId} is not valid base64`);

		let probe: EncryptedContainer;
		try {
			probe = EncryptedContainer.fromEncodedBuffer(buffer, []);
		} catch (error) {
			const detail = containerErrorDetail(error);
			throw(new AnchorExternalError('INVALID_SLICE', `Slice container parse failed: ${detail}`));
		}

		const encrypted = probe.encrypted;
		if (encrypted && decryptionKeys.length === 0) {
			return({ encrypted: true });
		}

		let container: EncryptedContainer;
		try {
			if (encrypted) {
				container = EncryptedContainer.fromEncryptedBuffer(buffer, decryptionKeys);
			} else {
				container = EncryptedContainer.fromEncodedBuffer(buffer, null);
			}
		} catch (error) {
			if (encrypted) {
				return({ encrypted: true });
			}

			const detail = containerErrorDetail(error);
			throw(new AnchorExternalError('INVALID_SLICE', `Slice container parse failed: ${detail}`));
		}

		let entry: AnchorExternalEntry;
		let binding: AnchorExternalBinding | undefined;
		let kind: 'account' | 'provider';
		let signer: Account | undefined;
		try {
			const plaintext = await AnchorExternal.readSlicePlaintext(container);
			entry = plaintext.entry;
			binding = plaintext.binding;
			kind = plaintext.kind;
			signer = await AnchorExternal.verifySliceSignature(container, anchorId, binding);
		} catch (error) {
			if (encrypted && EncryptedContainerError.isInstance(error) && isContainerLocked(error)) {
				return({ encrypted: true });
			}

			throw(error);
		}

		const slice: AnchorExternalSlice = { entry, encrypted, kind };
		if (binding !== undefined) {
			slice.binding = binding;
		}
		if (signer !== undefined) {
			slice.signer = signer;
		}

		return(slice);
	}

	/**
	 * Read and validate a slice container's plaintext.
	 */
	private static async readSlicePlaintext(container: EncryptedContainer): Promise<{ entry: AnchorExternalEntry; binding: AnchorExternalBinding | undefined; kind: 'account' | 'provider' }> {
		let plaintextArrayBuffer: ArrayBuffer;
		try {
			plaintextArrayBuffer = await container.getPlaintext();
		} catch (error) {
			if (EncryptedContainerError.isInstance(error)) {
				if (isContainerLocked(error)) {
					throw(error);
				}

				throw(new AnchorExternalError('INVALID_SLICE', `Slice plaintext unavailable: ${error.code}`));
			}

			throw(error);
		}

		if (plaintextArrayBuffer.byteLength > MAX_PLAINTEXT_BYTES) {
			throw(new AnchorExternalError('PLAINTEXT_TOO_LARGE', `Slice plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`));
		}

		const plaintextString = arrayBufferToBuffer(plaintextArrayBuffer).toString('utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(plaintextString);
		} catch {
			throw(new AnchorExternalError('INVALID_SLICE', 'Slice plaintext is not valid JSON'));
		}

		const encoded = parseEncodedSlice(parsed);

		/*
		 * Reject non-canonical encodings: an attacker could otherwise
		 * mutate the JSON shape under a still-valid signature on the
		 * original bytes.
		 */
		const reCanonical = canonicalizeJson(encoded);
		if (reCanonical !== plaintextString) {
			throw(new AnchorExternalError('NON_CANONICAL', 'Slice plaintext is not JCS-canonical'));
		}

		const entry = entryFromEncodedSlice(encoded);
		const binding = bindingFromEncodedSlice(encoded);
		const kind = kindFromEncodedSlice(encoded);
		return({ entry, binding, kind });
	}

	/**
	 * Verify a slice container's signature against the anchor id it is
	 * filed under and enforce the signed-iff-binding invariant.
	 */
	private static async verifySliceSignature(container: EncryptedContainer, anchorId: string, binding: AnchorExternalBinding | undefined): Promise<Account | undefined> {
		if (!container.isSigned) {
			if (binding !== undefined) {
				throw(new AnchorExternalError('UNEXPECTED_BINDING', 'Unsigned slice carries a binding'));
			}

			return(undefined);
		}

		if (binding === undefined) {
			throw(new AnchorExternalError('MISSING_BINDING', 'Signed slice is missing required binding'));
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
			throw(new AnchorExternalError('BAD_SIGNATURE', 'Slice is signed but the signing account is unavailable'));
		}

		if (signer.publicKeyString.get() !== anchorId) {
			throw(new AnchorExternalError('SIGNER_NOT_ANCHOR', 'Slice signer does not match the anchor id it is filed under'));
		}

		return(signer);
	}
}

// #endregion
