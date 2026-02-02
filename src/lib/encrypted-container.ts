import crypto from './utils/crypto.js';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

import type {
	ASN1OID
} from '@keetanetwork/keetanet-client/lib/utils/asn1.js';
import { Buffer, arrayBufferToBuffer, arrayBufferLikeToBuffer, bufferToArrayBuffer } from './utils/buffer.js';
import { isArray } from './utils/array.js';
import { KeetaAnchorError } from './error.js';

// #region Error Handling

/**
 * Error codes for EncryptedContainer operations
 */
export const EncryptedContainerErrorCodes = [
	// Parsing/Malformed data
	'MALFORMED_BASE_FORMAT',
	'MALFORMED_VERSION',
	'MALFORMED_DATA_STRUCTURE',
	'MALFORMED_KEY_INFO',
	'MALFORMED_SIGNER_INFO',

	// Algorithm issues
	'UNSUPPORTED_VERSION',
	'UNSUPPORTED_CIPHER_ALGORITHM',
	'UNSUPPORTED_DIGEST_ALGORITHM',
	'UNSUPPORTED_SIGNATURE_ALGORITHM',
	'UNSUPPORTED_KEY_TYPE',

	// Key/Decryption issues
	'NO_KEYS_PROVIDED',
	'NO_MATCHING_KEY',
	'DECRYPTION_FAILED',
	'DECOMPRESSION_FAILED',

	// Signing issues
	'SIGNER_REQUIRES_PRIVATE_KEY',
	'NOT_SIGNED',
	'SIGNATURE_VERIFICATION_FAILED',

	// State issues
	'NO_PLAINTEXT_AVAILABLE',
	'NO_ENCODED_DATA_AVAILABLE',
	'PLAINTEXT_DISABLED',

	// Access management
	'ENCRYPTION_REQUIRED',
	'INVALID_PRINCIPALS',
	'ACCESS_MANAGEMENT_NOT_ALLOWED',

	// Internal errors
	'INTERNAL_ERROR'
] as const;

/**
 * Error code type
 */
export type EncryptedContainerErrorCode = typeof EncryptedContainerErrorCodes[number];

/**
 * Error class for EncryptedContainer operations
 */
export class EncryptedContainerError extends KeetaAnchorError {
	static override readonly name: string = 'EncryptedContainerError';

	private readonly encryptedContainerErrorObjectTypeID!: string;
	private static readonly encryptedContainerErrorObjectTypeID = 'f4a8c2e1-7b3d-4f9a-8c5e-2d1f0a9b8c7e';

	readonly code: EncryptedContainerErrorCode;

	/**
	 * Check if a string is a valid EncryptedContainerErrorCode
	 */
	static isValidCode(code: string): code is EncryptedContainerErrorCode {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(EncryptedContainerErrorCodes.includes(code as EncryptedContainerErrorCode));
	}

	constructor(code: EncryptedContainerErrorCode, message: string) {
		super(message);
		this.code = code;
		// EncryptedContainerError is not a user error
		this.userError = false;

		Object.defineProperty(this, 'encryptedContainerErrorObjectTypeID', {
			value: EncryptedContainerError.encryptedContainerErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is EncryptedContainerError {
		return(this.hasPropWithValue(input, 'encryptedContainerErrorObjectTypeID', EncryptedContainerError.encryptedContainerErrorObjectTypeID));
	}

	override toJSON(): ReturnType<KeetaAnchorError['toJSON']> & { code: EncryptedContainerErrorCode } {
		return({
			...super.toJSON(),
			code: this.code
		});
	}

	static async fromJSON(input: unknown): Promise<EncryptedContainerError> {
		const { message, other } = this.extractErrorProperties(input, this);

		// Extract and validate code
		if (!('code' in other) || typeof other.code !== 'string') {
			throw(new Error('Invalid EncryptedContainerError JSON: missing code property'));
		}

		// Validate code is a valid EncryptedContainerErrorCode
		const code = other.code;
		if (!this.isValidCode(code)) {
			throw(new Error(`Invalid EncryptedContainerError JSON: unknown code ${code}`));
		}

		const error = new this(code, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

// #endregion

const zlibDeflateAsync = KeetaNetLib.Utils.Buffer.ZlibDeflateAsync;
const zlibInflateAsync = KeetaNetLib.Utils.Buffer.ZlibInflateAsync;
const ASN1toJS = KeetaNetLib.Utils.ASN1.ASN1toJS;
const JStoASN1 = KeetaNetLib.Utils.ASN1.JStoASN1;
const Account: typeof KeetaNetLib.Account = KeetaNetLib.Account;
type Account = InstanceType<typeof KeetaNetLib.Account>;

/**
 * Options for creating an EncryptedContainer from plaintext
 */
export type FromPlaintextOptions = {
	locked?: boolean;
	signer?: Account;
};

/*
 * ASN.1 Schema
 *
 * EncryptedContainer DEFINITIONS ::=
 * BEGIN
 *         Version        ::= INTEGER { v2(1), v3(2) }
 *
 *         KeyStore ::= SEQUENCE {
 *                 publicKey              OCTET STRING,
 *                 encryptedSymmetricKey  OCTET STRING,
 *                 ...
 *         }
 *
 *         EncryptedContainerBox ::= SEQUENCE {
 *                 keys                   SEQUENCE OF KeyStore,
 *                 encryptionAlgorithm    OBJECT IDENTIFIER,
 *                 initializationVector   OCTET STRING,
 *                 encryptedValue         OCTET STRING,
 *                 ...
 *         }
 *
 *         PlaintextContainerBox ::= SEQUENCE {
 *                 plainValue             OCTET STRING,
 *                 ...
 *         }
 *
 *         -- RFC 5652 Section 5.3 SignerInfo (adapted for KeetaNet)
 *         SignerInfo ::= SEQUENCE {
 *                 version                CMSVersion,           -- INTEGER (3 for subjectKeyIdentifier)
 *                 sid                    [0] SubjectKeyIdentifier,  -- OCTET STRING (publicKeyAndType)
 *                 digestAlgorithm        OBJECT IDENTIFIER,    -- SHA3-256: 2.16.840.1.101.3.4.2.8
 *                 signatureAlgorithm     OBJECT IDENTIFIER,    -- Derived from account type
 *                 signature              OCTET STRING,
 *                 ...
 *         }
 *
 *         ContainerPackage ::= SEQUENCE {
 *                 version                Version (v2 or v3),
 *                 encryptedContainer     [0] EXPLICIT EncryptedContainerBox OPTIONAL,
 *                 plaintextContainer     [1] EXPLICIT PlaintextContainerBox OPTIONAL,
 *                 signerInfo             [2] EXPLICIT SignerInfo OPTIONAL,  -- v3 only
 *                 ...
 *         } (WITH COMPONENTS {
 *                 encryptedContainer PRESENT,
 *                 plaintextContainer ABSENT
 *         } |
 *         WITH COMPONENTS {
 *                 encryptedContainer ABSENT,
 *                 plaintextContainer PRESENT
 *         })
 * END
 *
 */

/**
 * OID constants for cryptographic algorithms
 * // XXX:TODO: Are these already defined somewhere else?
 */
const oidDB = {
	// Digest algorithms
	'sha3-256': '2.16.840.1.101.3.4.2.8',

	// Signature algorithms
	'ed25519': '1.3.101.112',
	'ecdsa-secp256k1': '1.3.132.0.10',
	'ecdsa-secp256r1': '1.2.840.10045.3.1.7',

	// Encryption algorithms
	'aes-256-cbc': '2.16.840.1.101.3.4.1.42'
} as const;

/**
 * Supported algorithms
 * These are the canonical names as defined in oidDB
 */
const SUPPORTED_DIGEST_ALGORITHMS = ['sha3-256'] as const;
const SUPPORTED_SIGNATURE_ALGORITHMS = ['ed25519', 'ecdsa-secp256k1', 'ecdsa-secp256r1'] as const;

/**
 * Known OID aliases that ASN1 parsers may return instead of our canonical names
 */
const OID_ALIASES: { [alias: string]: keyof typeof oidDB } = {
	'secp256k1': 'ecdsa-secp256k1',
	'secp256r1': 'ecdsa-secp256r1',
	'prime256v1': 'ecdsa-secp256r1'
};

/**
 * Build reverse lookup: name/alias -> numeric OID
 */
const nameToNumericOID: { [name: string]: string } = {};
for (const [name, numericOID] of Object.entries(oidDB)) {
	nameToNumericOID[name] = numericOID;
}
for (const [alias, canonicalName] of Object.entries(OID_ALIASES)) {
	nameToNumericOID[alias] = oidDB[canonicalName];
}

/**
 * Normalize an OID (name, alias, or already numeric) to its numeric form.
 * Returns undefined if the OID is not recognized.
 */
function normalizeToNumericOID(oid: string): string | undefined {
	// If it's already a numeric OID (starts with digit), return as-is
	if (/^\d/.test(oid)) {
		return(oid);
	}
	// Otherwise look up the name/alias
	return(nameToNumericOID[oid]);
}

// Pre-compute supported numeric OIDs for validation
const supportedDigestOIDs = new Set<string>(SUPPORTED_DIGEST_ALGORITHMS.map(name => oidDB[name]));
const supportedSignatureOIDs = new Set<string>(SUPPORTED_SIGNATURE_ALGORITHMS.map(name => oidDB[name]));

/**
 * Map account key algorithm to signature algorithm OID
 */
function getSignatureAlgorithmOID(account: Account): string {
	const keyType = account.keyType;
	const KeyAlgo = Account.AccountKeyAlgorithm;

	if (keyType === KeyAlgo.ECDSA_SECP256K1) {
		return(oidDB['ecdsa-secp256k1']);
	} else if (keyType === KeyAlgo.ED25519) {
		return(oidDB['ed25519']);
	} else if (keyType === KeyAlgo.ECDSA_SECP256R1) {
		return(oidDB['ecdsa-secp256r1']);
	}

	throw(new EncryptedContainerError('UNSUPPORTED_KEY_TYPE', `Unsupported key type for signing: ${keyType}`));
}

/**
 * SignerInfo structure for RFC 5652 CMS compatibility
 */
type SignerInfoASN1 = [
	/* version - CMSVersion (3 for subjectKeyIdentifier) */
	number,

	/* sid - SubjectKeyIdentifier wrapped in context tag [0] */
	{
		type: 'context',
		value: 0,
		kind: 'implicit',
		contains: Buffer
	},

	/* digestAlgorithm */
	ASN1OID,

	/* signatureAlgorithm */
	ASN1OID,

	/* signature */
	Buffer
];

/**
 * Parsed SignerInfo data
 */
type ParsedSignerInfo = {
	version: number;
	signerPublicKeyAndType: Buffer;
	digestAlgorithmOID: string;
	signatureAlgorithmOID: string;
	signature: Buffer;
};

type EncryptedContainerKeyStore = [
	/* publicKey */
	Buffer,

	/* encryptedSymmetricKey */
	Buffer
];

type EncryptedContainerBoxEncrypted = [
	/* keys */
	EncryptedContainerKeyStore[],

	/* encryptionAlgorithm */
	ASN1OID,

	/* initializationVector */
	Buffer,

	/* value */
	Buffer
];

type EncryptedContainerBoxPlaintext = [
	/* value */
	Buffer
];

type ContainerPackageV2 = [
	/* version */
	number,

	/* container */
	{
		type: 'context',
		value: 0,
		kind: 'explicit',
		contains: EncryptedContainerBoxEncrypted
	} | {
		type: 'context',
		value: 1,
		kind: 'explicit',
		contains: EncryptedContainerBoxPlaintext
	}
];

type ContainerPackageV3 = [
	/* version */
	number,

	/* container */
	{
		type: 'context',
		value: 0,
		kind: 'explicit',
		contains: EncryptedContainerBoxEncrypted
	} | {
		type: 'context',
		value: 1,
		kind: 'explicit',
		contains: EncryptedContainerBoxPlaintext
	},

	/* signerInfo */
	{
		type: 'context',
		value: 2,
		kind: 'explicit',
		contains: SignerInfoASN1
	}
];

type ContainerPackage = ContainerPackageV2 | ContainerPackageV3;

type EncryptedBoxContext = {
	type: 'context',
	value: 0,
	kind: 'explicit',
	contains: EncryptedContainerBoxEncrypted
};

type PlaintextBoxContext = {
	type: 'context',
	value: 1,
	kind: 'explicit',
	contains: EncryptedContainerBoxPlaintext
};

type ContainerBox = EncryptedBoxContext | PlaintextBoxContext;

/**
 * Build a typed encrypted container box with context tag [0].
 */
function buildEncryptedBox(
	keys: EncryptedContainerKeyStore[],
	algorithmOID: string,
	iv: Buffer,
	encryptedData: Buffer
): EncryptedBoxContext {
	return({
		type: 'context',
		value: 0,
		kind: 'explicit',
		contains: [keys, { type: 'oid', oid: algorithmOID }, iv, encryptedData]
	});
}

/**
 * Build a typed plaintext container box with context tag [1].
 */
function buildPlaintextBox(
	data: Buffer
): PlaintextBoxContext {
	return({
		type: 'context',
		value: 1,
		kind: 'explicit',
		contains: [data]
	});
}

/**
 * Build a typed signer info box with context tag [2].
 */
function buildSignerInfoBox(
	signerInfo: SignerInfoASN1
): { type: 'context', value: 2, kind: 'explicit', contains: SignerInfoASN1 } {
	return({
		type: 'context',
		value: 2,
		kind: 'explicit',
		contains: signerInfo
	});
}

type CipherOptions = {
	/**
	 * The symmetric cipher key (if any)
	 */
	cipherKey: Buffer | undefined;
	/**
	 * The symmetric cipher IV (if any)
	 */
	cipherIV: Buffer | undefined;
	/**
	 * The symmetric cipher algorithm
	 */
	cipherAlgo: string;
}

type ASN1Options = Required<CipherOptions> & {
	/**
	 * The set of accounts to encrypt the formatted data
	 */
	keys: Account[];
}

type SigningOptions = {
	/**
	 * The account to sign the container with
	 */
	signer: Account;
}

/**
* Compiles the ASN.1 for the container
*
* @param plaintext The plaintext data to encode
* @param encryptionOptions Optional encryption options
* @param signingOptions Optional signing options (will produce v3 container)
* @returns The ASN.1 DER data
*/
async function buildASN1(plaintext: Buffer, encryptionOptions?: ASN1Options, signingOptions?: SigningOptions): Promise<Buffer> {
	const compressedPlaintext = Buffer.from(await zlibDeflateAsync(bufferToArrayBuffer(plaintext)));

	/*
	 * Build the container box (encrypted or plaintext)
	 */
	let containerBox: ContainerBox;
	if (encryptionOptions) {
		const { keys, cipherKey, cipherIV, cipherAlgo } = encryptionOptions;
		if (keys === undefined || keys.length === 0 || cipherKey === undefined || cipherIV === undefined || cipherAlgo === undefined) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'Unsupported method invocation'));
		}
		if (!(cipherAlgo in oidDB)) {
			throw(new EncryptedContainerError('UNSUPPORTED_CIPHER_ALGORITHM', `Unsupported algorithm: ${cipherAlgo}`));
		}

		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const algorithmOID = oidDB[cipherAlgo as keyof typeof oidDB];
		const cipher = crypto.createCipheriv(
			cipherAlgo,
			cipherKey,
			cipherIV
		);

		const encryptedData = Buffer.concat([
			cipher.update(compressedPlaintext),
			cipher.final()
		]);

		const cipherKeyArrayBuffer = bufferToArrayBuffer(cipherKey);
		const encryptionKeysSequence = await Promise.all(keys.map(async function(key) {
			const encryptedSymmetricKey = Buffer.from(await key.encrypt(cipherKeyArrayBuffer));
			const retval: EncryptedContainerKeyStore = [
				Buffer.from(key.publicKeyAndType),
				Buffer.from(encryptedSymmetricKey)
			];

			return(retval);
		}));

		containerBox = buildEncryptedBox(encryptionKeysSequence, algorithmOID, cipherIV, encryptedData);
	} else {
		/*
		 * Otherwise we simply pass in the compressed data
		 */
		containerBox = buildPlaintextBox(Buffer.from(compressedPlaintext));
	}

	/*
	 * Build the typed container package
	 */
	let container: ContainerPackage;
	if (signingOptions) {
		/*
		 * V3 container with SignerInfo
		 * Sign the compressed plaintext (before encryption) so signature is verifiable after decryption
		 */
		const { signer } = signingOptions;

		if (!signer.hasPrivateKey) {
			throw(new EncryptedContainerError('SIGNER_REQUIRES_PRIVATE_KEY', 'Signer account must have a private key'));
		}

		// Hash the compressed plaintext with SHA3-256
		const digestHash = crypto.createHash('sha3-256');
		digestHash.update(compressedPlaintext);
		const digest = digestHash.digest();

		// Sign the digest
		const signatureBuffer = await signer.sign(bufferToArrayBuffer(digest), { raw: true });

		// Get signature as Buffer
		let signature: Buffer;
		if (Buffer.isBuffer(signatureBuffer)) {
			signature = Buffer.from(signatureBuffer);
		} else if ('get' in signatureBuffer && typeof signatureBuffer.get === 'function') {
			signature = arrayBufferToBuffer(signatureBuffer.get());
		} else {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			signature = arrayBufferToBuffer(signatureBuffer as unknown as ArrayBuffer);
		}

		const signerInfoASN1: SignerInfoASN1 = [
			3, // CMSVersion 3 for subjectKeyIdentifier
			{
				type: 'context',
				value: 0,
				kind: 'implicit',
				contains: Buffer.from(signer.publicKeyAndType)
			},
			{ type: 'oid', oid: oidDB['sha3-256'] },
			{ type: 'oid', oid: getSignatureAlgorithmOID(signer) },
			signature
		];

		const containerV3: ContainerPackageV3 = [
			2, // version
			containerBox,
			buildSignerInfoBox(signerInfoASN1)
		];
		container = containerV3;
	} else {
		/*
		 * V2 container without SignerInfo
		 */
		const containerV2: ContainerPackageV2 = [
			1, // version
			containerBox
		];
		container = containerV2;
	}

	const outputASN1 = JStoASN1(container);
	const outputDER = arrayBufferToBuffer(outputASN1.toBER(false));
	return(outputDER);
}

function parseASN1Bare(input: Buffer, acceptableEncryptionAlgorithms = ['aes-256-cbc', 'null']) {
	const inputSequence = ASN1toJS(bufferToArrayBuffer(input));
	if (!isArray(inputSequence) || inputSequence.length < 2) {
		throw(new EncryptedContainerError('MALFORMED_BASE_FORMAT', 'Malformed data detected (incorrect base format)'));
	}

	const version = inputSequence[0];
	if (typeof version !== 'bigint') {
		throw(new EncryptedContainerError('MALFORMED_VERSION', 'Malformed data detected (version expected at position 0)'));
	}

	// Support v2 (1) and v3 (2)
	if (version !== 1n && version !== 2n) {
		throw(new EncryptedContainerError('UNSUPPORTED_VERSION', 'Malformed data detected (unsupported version)'));
	}

	const valueBox = inputSequence[1];
	if (typeof valueBox !== 'object' || valueBox === null) {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (data expected at position 1)'));
	}

	if (!('type' in valueBox) || typeof valueBox.type !== 'string') {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (expected type at position 1)'));
	}

	if (valueBox.type !== 'context') {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (expected context at position 1)'));
	}

	if (!('value' in valueBox) || typeof valueBox.value !== 'number') {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (expected context value at position 1)'));
	}

	if (valueBox.value !== 0 && valueBox.value !== 1) {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (expected context value of 0 or 1)'));
	}

	if (!('contains' in valueBox) || typeof valueBox.contains !== 'object' || valueBox.contains === null) {
		throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data detected (expected contents at position 1)'));
	}

	let isEncrypted;
	if (valueBox.value === 0) {
		isEncrypted = true;
	} else {
		isEncrypted = false;
	}

	const value = valueBox.contains;
	let containedCompressed: Buffer;
	let cipherInfo;
	if (isEncrypted) {
		if (!isArray(value, 4)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (incorrect number of elements within position 1 -- expected 4)'));
		}

		const keyInfoUnchecked = value[0];
		if (!isArray(keyInfoUnchecked)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (expected sequence at position 2.0)'));
		}

		const keyInfo = keyInfoUnchecked.map(function(checkKeyInfo) {
			if (!isArray(checkKeyInfo, 2)) {
				throw(new EncryptedContainerError('MALFORMED_KEY_INFO', 'Malformed key information (expected sequence of 2 at position 1.0.x)'));
			}

			const publicKeyBuffer = checkKeyInfo[0];
			if (!Buffer.isBuffer(publicKeyBuffer)) {
				throw(new EncryptedContainerError('MALFORMED_KEY_INFO', 'Malformed key information (expected octet string for public key at position 1.0.x)'));
			}
			const publicKey = Account.fromPublicKeyAndType(publicKeyBuffer);

			const encryptedSymmetricKey = checkKeyInfo[1];
			if (!Buffer.isBuffer(encryptedSymmetricKey)) {
				throw(new EncryptedContainerError('MALFORMED_KEY_INFO', 'Malformed key information (expected octet string for cipher key at position 1.0.x)'));
			}

			return({
				publicKey,
				encryptedSymmetricKey
			});
		});

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const encryptionAlgorithmOID = value[1];
		/* XXX:TODO: Lookup the encryption algorithm from the OID  */
		const encryptionAlgorithm = 'aes-256-cbc';

		const cipherIV = value[2];
		if (!Buffer.isBuffer(cipherIV)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (cipher IV expected at position 1.2)'));
		}

		const encryptedCompressedValue = value[3];
		if (!Buffer.isBuffer(encryptedCompressedValue)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (encrypted compressed buffer expected at position 1.3)'));
		}

		cipherInfo = {
			keys: keyInfo,
			cipherIV: cipherIV,
			encryptedData: encryptedCompressedValue,
			encryptionAlgorithm: encryptionAlgorithm
		};

		containedCompressed = Buffer.from(encryptedCompressedValue);
	} else {
		if (!isArray(value, 1)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (incorrect number of elements within position 1 -- expected 1)'));
		}

		const containedCompressedUnchecked = value[0];
		if (!Buffer.isBuffer(containedCompressedUnchecked)) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Malformed data (compressed buffer expected at position 1.0)'));
		}

		if (!acceptableEncryptionAlgorithms.includes('null')) {
			throw(new EncryptedContainerError('ENCRYPTION_REQUIRED', 'Malformed data (plaintext found but the null encryption algorithm is not acceptable)'));
		}

		containedCompressed = Buffer.from(containedCompressedUnchecked);
	}

	// Parse SignerInfo if present (v3 containers)
	let signerInfo: ParsedSignerInfo | undefined;
	if (version === 2n && inputSequence.length >= 3) {
		const signerInfoBox = inputSequence[2];
		if (typeof signerInfoBox === 'object' && signerInfoBox !== null &&
			'type' in signerInfoBox && signerInfoBox.type === 'context' &&
			'value' in signerInfoBox && signerInfoBox.value === 2 &&
			'contains' in signerInfoBox && isArray(signerInfoBox.contains, 5)) {

			const signerInfoData = signerInfoBox.contains;

			// Parse version
			const signerVersion = signerInfoData[0];
			if (typeof signerVersion !== 'bigint') {
				throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', 'Malformed SignerInfo (version expected at position 0)'));
			}

			// Parse sid (subjectKeyIdentifier in context tag [0])
			const sidBox = signerInfoData[1];
			let signerPublicKeyAndType: Buffer;
			if (typeof sidBox === 'object' && sidBox !== null &&
				'type' in sidBox && sidBox.type === 'context' &&
				'value' in sidBox && sidBox.value === 0 &&
				'contains' in sidBox && (Buffer.isBuffer(sidBox.contains) || sidBox.contains instanceof ArrayBuffer)) {
				signerPublicKeyAndType = arrayBufferLikeToBuffer(sidBox.contains);
			} else if (Buffer.isBuffer(sidBox)) {
				// Handle case where ASN.1 parser unwraps the context tag
				signerPublicKeyAndType = Buffer.from(sidBox);
			} else {
				throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', 'Malformed SignerInfo (sid expected at position 1)'));
			}

			// Parse digestAlgorithm
			const digestAlgoRaw = signerInfoData[2];
			let digestAlgorithmOID: string;
			if (typeof digestAlgoRaw === 'object' && digestAlgoRaw !== null &&
				'type' in digestAlgoRaw && digestAlgoRaw.type === 'oid' &&
				'oid' in digestAlgoRaw && typeof digestAlgoRaw.oid === 'string') {
				const normalized = normalizeToNumericOID(digestAlgoRaw.oid);
				if (!normalized) {
					throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', `Unknown digest algorithm: ${digestAlgoRaw.oid}`));
				}
				digestAlgorithmOID = normalized;
			} else {
				throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', 'Malformed SignerInfo (digestAlgorithm expected at position 2)'));
			}

			// Parse signatureAlgorithm
			const sigAlgoRaw = signerInfoData[3];
			let signatureAlgorithmOID: string;
			if (typeof sigAlgoRaw === 'object' && sigAlgoRaw !== null &&
				'type' in sigAlgoRaw && sigAlgoRaw.type === 'oid' &&
				'oid' in sigAlgoRaw && typeof sigAlgoRaw.oid === 'string') {
				const normalized = normalizeToNumericOID(sigAlgoRaw.oid);
				if (!normalized) {
					throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', `Unknown signature algorithm: ${sigAlgoRaw.oid}`));
				}
				signatureAlgorithmOID = normalized;
			} else {
				throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', 'Malformed SignerInfo (signatureAlgorithm expected at position 3)'));
			}

			// Parse signature
			const signatureRaw = signerInfoData[4];
			if (!Buffer.isBuffer(signatureRaw)) {
				throw(new EncryptedContainerError('MALFORMED_SIGNER_INFO', 'Malformed SignerInfo (signature expected at position 4)'));
			}

			signerInfo = {
				version: Number(signerVersion),
				signerPublicKeyAndType,
				digestAlgorithmOID,
				signatureAlgorithmOID,
				signature: Buffer.from(signatureRaw)
			};
		}
	}

	return({
		version: version,
		isEncrypted: isEncrypted,
		innerValue: containedCompressed,
		signerInfo,
		...cipherInfo
	});
}

async function parseASN1Decrypt(inputInfo: ReturnType<typeof parseASN1Bare>, keys?: Account[]) {
	let containedCompressed: Buffer;
	let cipherInfo;
	if (inputInfo.isEncrypted) {
		if (keys === undefined || keys.length === 0) {
			throw(new EncryptedContainerError('NO_KEYS_PROVIDED', 'Encrypted Container found with encryption but no keys for decryption supplied'));
		}

		const algorithm = inputInfo.encryptionAlgorithm;
		if (algorithm === undefined) {
			throw(new EncryptedContainerError('MALFORMED_DATA_STRUCTURE', 'Encrypted Container found with encryption but no algorithm supplied'));
		}

		const keyInfo = inputInfo.keys;
		if (keyInfo === undefined) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'Encrypted container found with missing keys'));
		}

		let decryptionKeyInfo;
		for (const checkKeyInfo of keyInfo) {
			for (const key of keys) {
				if (!key.hasPrivateKey) {
					continue;
				}

				if (key.comparePublicKey(checkKeyInfo.publicKey)) {
					decryptionKeyInfo = {
						...checkKeyInfo,
						privateKey: key
					};

					break;
				}
			}
		}

		if (decryptionKeyInfo === undefined) {
			throw(new EncryptedContainerError('NO_MATCHING_KEY', 'No keys found which can perform decryption on the supplied encryption box'));
		}

		let cipherKey: Buffer;
		try {
			const dataToDecrypt = bufferToArrayBuffer(decryptionKeyInfo.encryptedSymmetricKey);
			cipherKey = arrayBufferLikeToBuffer(await decryptionKeyInfo.privateKey.decrypt(dataToDecrypt));
		} catch (err) {
			throw(new EncryptedContainerError('DECRYPTION_FAILED', `Key decryption failed: ${err instanceof Error ? err.message : String(err)}`));
		}

		const cipherIV = inputInfo.cipherIV;
		if (cipherIV === undefined) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'No Cipher IV found'));
		}

		const encryptedCompressedValue = inputInfo.innerValue;
		const decipher = crypto.createDecipheriv(algorithm, cipherKey, cipherIV);
		try {
			containedCompressed = Buffer.concat([
				decipher.update(encryptedCompressedValue),
				decipher.final()
			]);
		} catch (err) {
			throw(new EncryptedContainerError('DECRYPTION_FAILED', `Cipher decryption failed: ${err instanceof Error ? err.message : String(err)}`));
		}

		cipherInfo = {
			isEncrypted: true,
			keys: keyInfo,
			cipherIV: cipherIV,
			cipherKey: cipherKey,
			encryptedData: encryptedCompressedValue
		};
	} else {
		containedCompressed = inputInfo.innerValue;
		cipherInfo = {
			isEncrypted: false
		};
	}

	let plaintext: Buffer;
	try {
		const inflated = await zlibInflateAsync(bufferToArrayBuffer(containedCompressed));
		plaintext = arrayBufferLikeToBuffer(inflated);
	} catch (err) {
		throw(new EncryptedContainerError('DECOMPRESSION_FAILED', `Inflate failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	return({
		version: inputInfo.version,
		plaintext: plaintext,
		...cipherInfo
	});

}

async function parseASN1(input: Buffer, keys?: Account[]) {
	const inputInfo = parseASN1Bare(input);
	const retval = await parseASN1Decrypt(inputInfo, keys);

	return(retval);
}

function inputToBuffer(data: string | ArrayBuffer | Buffer): Buffer {
	if (typeof data === 'string') {
		return(Buffer.from(data, 'utf-8'));
	} else if (Buffer.isBuffer(data)) {
		return(data);
	} else {
		return(arrayBufferToBuffer(data));
	}
}

type EncryptedContainerInfo = Pick<CipherOptions, 'cipherAlgo'> & {
	/**
	 * Set of accounts which can access the data
	 */
	principals: Account[];
}

type UnencryptedContainerInfo = {
	/**
	 * Unencrypted container should not have any principals
	 */
	principals: null;
}

type ContainerSigningInfo = {
	/**
	 * The account to sign the container with (for new containers)
	 */
	signer?: Account;

	/**
	 * Parsed signer info from an existing container
	 */
	parsedSignerInfo?: ParsedSignerInfo;
}

export class EncryptedContainer {
	private static readonly algorithm = 'aes-256-cbc';

	/**
	 * Flag indicating whether we support exporting the plaintext
	 */
	#mayAccessPlaintext = true;

	/**
	 * Encryption details
	 */
	protected _internalState: EncryptedContainerInfo | UnencryptedContainerInfo;

	/**
	 * Signing information
	 */
	#signingInfo: ContainerSigningInfo = {};

	/**
	 * The plaintext or encoded (and possibly encrypted) data
	 */
	#data:
		{ plaintext: Buffer } |
		{ encoded: Buffer } |
		{ plaintext: Buffer, encoded: Buffer };

	constructor(principals: Account[] | null, signer?: Account) {
		if (principals === null) {
			this._internalState = {
				principals: null
			};
		} else {
			this._internalState = {
				principals: principals,
				cipherAlgo: EncryptedContainer.algorithm
			}
		};
		this.#data = { plaintext: Buffer.alloc(0) };

		if (signer) {
			this.#signingInfo.signer = signer;
		}
	}

	get encrypted(): boolean {
		return(this._internalState.principals !== null);
	}

	#isEncrypted(): this is { _internalState: EncryptedContainerInfo } {
		return(this.encrypted);
	}

	/**
	 * Create an instance of the EncryptedContainer from an encrypted blob,
	 * it will need to be decryptable with one of the specified principals
	 *
	 * After decryption happens, the list of principals with access to the
	 * resource will be reset to what is contained within the encrypted
	 * container
	 */
	static fromEncryptedBuffer(data: ArrayBuffer | Buffer, principals: Account[]): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		retval.#setEncodedBuffer(data);
		retval.#computeAndSetKeyInfo(true);

		return(retval);
	}

	static fromEncodedBuffer(data: ArrayBuffer | Buffer, principals: Account[] | null): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		retval.#setEncodedBuffer(data);
		retval.#computeAndSetKeyInfo(false);

		return(retval);
	}

	/**
	 * Create an instance of the EncryptedContainer from a plaintext.
	 *
	 * It will be decryptable by any one of the specified principals
	 *
	 * @param data The plaintext data to encrypt or encode
	 * @param principals The list of principals who can access the data if it is null then the data is not encrypted
	 * @param options Options including locked (plaintext accessibility) and signer (for RFC 5652 signing). For backward compatibility, can also be a boolean for locked.
	 * @returns The EncryptedContainer instance with the plaintext data and principals set
	 */
	static fromPlaintext(data: string | ArrayBuffer | Buffer, principals: Account[] | null, options?: boolean | FromPlaintextOptions): EncryptedContainer {
		// Handle backward compatibility - if options is a boolean, treat it as the locked flag
		let lockedOpt: boolean | undefined;
		let signer: Account | undefined;

		if (typeof options === 'boolean') {
			lockedOpt = options;
		} else if (options !== undefined) {
			lockedOpt = options.locked;
			signer = options.signer;
		}

		const retval = new EncryptedContainer(principals, signer);

		let locked = lockedOpt;
		if (locked === undefined) {
			locked = true;
			if (principals === null) {
				locked = false;
			}
		}

		if (locked) {
			retval.disablePlaintext();
		}

		retval.setPlaintext(data);

		return(retval);
	}

	/**
	 * Set the plaintext buffer to the specified value
	 */
	setPlaintext(data: string | ArrayBuffer | Buffer): void {
		this.#data = { plaintext: inputToBuffer(data) };
	}

	/**
	 * Set the encoded blob to the specified value
	 */
	#setEncodedBuffer(data: ArrayBuffer | Buffer): void {
		this.#data = { encoded: inputToBuffer(data) };
	}

	private get _encoded(): Buffer | undefined {
		if ('encoded' in this.#data && this.#data.encoded !== undefined) {
			return(this.#data.encoded);
		}

		return(undefined);
	}

	private get _plaintext(): Buffer | undefined {
		if ('plaintext' in this.#data && this.#data.plaintext !== undefined) {
			return(this.#data.plaintext);
		}

		return(undefined);
	}

	/*
	 * Return the decoded data from the encoded blob
	 * and populate the symmetric key parameters from the encoded blob if it is encrypted
	 */
	#computeAndSetKeyInfo(mustBeEncrypted: boolean) {
		if (this._encoded === undefined) {
			throw(new EncryptedContainerError('NO_ENCODED_DATA_AVAILABLE', 'No encoded data available'));
		}

		const plaintextWrapper = parseASN1Bare(this._encoded);

		if (mustBeEncrypted && !plaintextWrapper.isEncrypted) {
			throw(new EncryptedContainerError('ENCRYPTION_REQUIRED', 'Unable to set key information from plaintext -- it is not encrypted but that was required'));
		}

		if (plaintextWrapper.isEncrypted) {
			const principals = this._internalState.principals;
			if (principals === null) {
				throw(new EncryptedContainerError('INVALID_PRINCIPALS', 'May not encrypt data with a null set of principals'));
			}

			/*
			 * Compute the new accounts by merging the input from the
			 * data and the existing list of principals
			 */
			/**
			 * The existing principals from the blob, with existing
			 * principals substituted in where appropriate
			 */
			const blobPrincipals = (plaintextWrapper.keys ?? []).map((keyInfo) => {
				const currentPublicKey = keyInfo.publicKey;
				if (!currentPublicKey.isAccount()) {
					throw(new EncryptedContainerError('INTERNAL_ERROR', 'Non-account found within the encryption key list'));
				}

				for (const checkExistingKey of principals) {
					if (checkExistingKey.comparePublicKey(currentPublicKey)) {
						return(checkExistingKey);
					}
				}

				return(currentPublicKey);
			});

			this._internalState.principals = blobPrincipals;

			// Confirm updated principals are populated correctly which sets container to encrypted
			if (!this.encrypted) {
				throw(new EncryptedContainerError('INTERNAL_ERROR', 'Encrypted data found but not marked as encrypted'));
			}
		} else {
			this._internalState.principals = null;

			if (this.encrypted) {
				throw(new EncryptedContainerError('INTERNAL_ERROR', 'Plaintext data found but marked as encrypted'));
			}
		}

		// Store parsed signer info if present
		if (plaintextWrapper.signerInfo) {
			this.#signingInfo.parsedSignerInfo = plaintextWrapper.signerInfo;
		}

		return(plaintextWrapper);
	}

	/**
	 * Populate the plaintext (as well as symmetric key parameters) from
	 * the encoded blob
	 */
	async #computePlaintext() {
		if (this._plaintext) {
			return(this._plaintext);
		}

		if (this._encoded === undefined) {
			throw(new EncryptedContainerError('NO_ENCODED_DATA_AVAILABLE', 'No plaintext or encoded data available'));
		}


		const info = this.#computeAndSetKeyInfo(this.encrypted);

		let principals = this._internalState.principals;
		if (info.isEncrypted) {
			if (principals === null) {
				throw(new EncryptedContainerError('INVALID_PRINCIPALS', 'May not decrypt data with a null set of principals'));
			}
		} else {
			principals = [];
		}

		const plaintextWrapper = await parseASN1Decrypt(info, principals);
		const plaintext = Buffer.from(plaintextWrapper.plaintext);

		this.#data = { ...this.#data, plaintext };

		return(plaintext);
	}

	/**
	 * Compute the encoded version of the plaintext data
	 */
	async #computePlaintextEncoded() {
		if (this._plaintext === undefined) {
			throw(new EncryptedContainerError('NO_PLAINTEXT_AVAILABLE', 'No plaintext data available'));
		}

		const signingOptions = this.#signingInfo.signer
			? { signer: this.#signingInfo.signer }
			: undefined;

		const structuredData = await buildASN1(
			this._plaintext,
			undefined,
			signingOptions
		);

		return(structuredData);
	}

	/**
	 * Populate the encrypted blob from the plaintext and symmetric key
	 * parameters.  If the symmetric key parameters have not been
	 * initialized they will be initialized at this time.
	 */
	async #computeEncryptedEncoded() {
		if (this._plaintext === undefined) {
			throw(new EncryptedContainerError('NO_PLAINTEXT_AVAILABLE', 'No encrypted nor plaintext data available'));
		}

		if (!this.#isEncrypted()) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'Asked to encrypt a plaintext buffer'));
		}

		const signingOptions = this.#signingInfo.signer
			? { signer: this.#signingInfo.signer }
			: undefined;

		/**
		 * structured data is the ASN.1 encoded structure
		 */
		const structuredData = await buildASN1(
			this._plaintext,
			{
				keys: this._internalState.principals,
				cipherKey: Buffer.from(crypto.randomBytes(32)),
				cipherIV: Buffer.from(crypto.randomBytes(16)),
				cipherAlgo: this._internalState.cipherAlgo
			},
			signingOptions
		);

		return(structuredData);
	}

	async #computeEncoded() {
		if (this._encoded !== undefined) {
			return(this._encoded);
		}

		let computed: Buffer;
		if (!this.encrypted) {
			computed = await this.#computePlaintextEncoded();
		} else {
			computed = await this.#computeEncryptedEncoded();
		}

		this.#data = { ...this.#data, encoded: computed };

		return(computed);
	}

	/**
	 * Grant access to the secret for account(s) synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	grantAccessSync(accounts: Account[] | Account): this {
		if (this._plaintext === undefined) {
			throw(new EncryptedContainerError('NO_PLAINTEXT_AVAILABLE', 'Unable to grant access, plaintext not available'));
		}

		if (!this.#isEncrypted()) {
			throw(new EncryptedContainerError('ACCESS_MANAGEMENT_NOT_ALLOWED', 'May not manage access to a plaintext container'));
		}

		if (!Array.isArray(accounts)) {
			accounts = [accounts];
		}

		// Encoded data is invalidated with the new permissions so set only the plaintext data
		this.setPlaintext(this._plaintext);

		this._internalState.principals.push(...accounts);

		return(this);
	}

	/**
	 * Grant access to the secret for account(s).
	 */
	async grantAccess(accounts: Account[] | Account): Promise<this> {
		await this.#computePlaintext();

		this.grantAccessSync(accounts);

		return(this);
	}

	/**
	 * Revoke access to the secret for an account synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	revokeAccessSync(account: Account): this {
		if (this._plaintext === undefined) {
			throw(new EncryptedContainerError('NO_PLAINTEXT_AVAILABLE', 'Unable to revoke access, plaintext not available'));
		}

		if (!this.#isEncrypted()) {
			throw(new EncryptedContainerError('ACCESS_MANAGEMENT_NOT_ALLOWED', 'May not manage access to a plaintext container'));
		}

		// Encoded data is invalidated with the new permissions so set only the plaintext data
		this.setPlaintext(this._plaintext);

		this._internalState.principals = this._internalState.principals.filter(function(checkAccount) {
			return(!checkAccount.comparePublicKey(account));
		});

		return(this);
	}

	/**
	 * Revoke access to the secret for an account
	 */
	async revokeAccess(account: Account): Promise<this> {
		await this.#computePlaintext();

		this.revokeAccessSync(account);

		return(this);
	}

	/**
	 * Disable access to the plaintext from this instance
	 */
	disablePlaintext(): this {
		this.#mayAccessPlaintext = false;

		return(this);
	}

	/**
	 * Get the plaintext for this instance
	 */
	async getPlaintext(): Promise<ArrayBuffer> {
		if (!this.#mayAccessPlaintext) {
			throw(new EncryptedContainerError('PLAINTEXT_DISABLED', 'May not access plaintext'));
		}

		const plaintext = await this.#computePlaintext();

		if (plaintext === undefined) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'Plaintext could not be decoded'));
		}

		/*
		 * Make a copy of our internal buffer so that any changes made
		 * to either our internal buffer or by our caller do not
		 * interfere
		 */
		return(bufferToArrayBuffer(plaintext));
	}

	/**
	 * Get the serializable buffer which can be stored and reconstructed
	 */
	async getEncodedBuffer(): Promise<ArrayBuffer> {
		const serialized = await this.#computeEncoded();

		if (serialized === undefined) {
			throw(new EncryptedContainerError('INTERNAL_ERROR', 'Could not encode data'));
		}

		/*
		 * Make a copy of our internal buffer so that any changes made
		 * to either our internal buffer or by our caller do not
		 * interfere
		 */
		return(bufferToArrayBuffer(serialized));
	}

	/**
	 * Get the list of accounts which have access to read the plaintext of
	 * this container
	 */
	get principals(): Account[] {
		if (!this.#isEncrypted()) {
			throw(new EncryptedContainerError('ACCESS_MANAGEMENT_NOT_ALLOWED', 'May not manage access to a plaintext container'));
		}

		return(this._internalState.principals);
	}

	/**
	 * Check if this container is signed
	 */
	get isSigned(): boolean {
		return(this.#signingInfo.signer !== undefined || this.#signingInfo.parsedSignerInfo !== undefined);
	}

	/**
	 * Get the signing account of this container.
	 */
	getSigningAccount(): Account | undefined {
		// If we have a signer account set (for new containers), return it
		if (this.#signingInfo.signer) {
			return(this.#signingInfo.signer);
		}

		// If we have parsed signer info (from encoded container), construct account from it
		if (this.#signingInfo.parsedSignerInfo) {
			const { signerPublicKeyAndType } = this.#signingInfo.parsedSignerInfo;
			return(Account.fromPublicKeyAndType(signerPublicKeyAndType));
		}

		return(undefined);
	}

	/**
	 * Verify the signature on this container.
	 * This requires decrypting the container first to access the compressed plaintext.
	 *
	 * @returns true if signature is valid, false if invalid, or throws if not signed or plaintext unavailable
	 */
	async verifySignature(): Promise<boolean> {
		if (!this.#signingInfo.parsedSignerInfo) {
			throw(new EncryptedContainerError('NOT_SIGNED', 'Container is not signed'));
		}

		const signerInfo = this.#signingInfo.parsedSignerInfo;

		// Validate digest algorithm OID
		if (!supportedDigestOIDs.has(signerInfo.digestAlgorithmOID)) {
			throw(new EncryptedContainerError(
				'UNSUPPORTED_DIGEST_ALGORITHM',
				`Unsupported digest algorithm OID: ${signerInfo.digestAlgorithmOID}`
			));
		}

		// Validate signature algorithm OID
		if (!supportedSignatureOIDs.has(signerInfo.signatureAlgorithmOID)) {
			throw(new EncryptedContainerError(
				'UNSUPPORTED_SIGNATURE_ALGORITHM',
				`Unsupported signature algorithm OID: ${signerInfo.signatureAlgorithmOID}`
			));
		}

		// We need the plaintext to verify the signature
		const plaintext = await this.#computePlaintext();
		if (!plaintext) {
			throw(new EncryptedContainerError('NO_PLAINTEXT_AVAILABLE', 'Unable to compute plaintext for signature verification'));
		}

		// Recompute the digest of the compressed plaintext
		const compressedPlaintext = Buffer.from(await zlibDeflateAsync(bufferToArrayBuffer(plaintext)));
		const digestHash = crypto.createHash('sha3-256');
		digestHash.update(compressedPlaintext);
		const digest = digestHash.digest();

		// Get the signer's account (public key only)
		const signerAccount = Account.fromPublicKeyAndType(signerInfo.signerPublicKeyAndType);

		// Verify the signature
		const signature = signerInfo.signature;
		const isValid = signerAccount.verify(
			bufferToArrayBuffer(digest),
			bufferToArrayBuffer(signature),
			{ raw: true }
		);

		return(isValid);
	}
}

/** @internal */
export const _Testing = {
	buildASN1: buildASN1,
	parseASN1: parseASN1
};

export default EncryptedContainer;
