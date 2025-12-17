import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as oids from '../services/kyc/oids.generated.js';
import * as ASN1 from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import type { SensitiveAttributeType, CertificateAttributeValue , CertificateAttributeOIDDB } from '../services/kyc/iso20022.generated.js';
import { CertificateAttributeSchema } from '../services/kyc/iso20022.generated.js';
import { getOID, lookupByOID } from './utils/oid.js';
import { convertToJSON } from './utils/json.js';

/**
 * Short alias for printing a debug representation of an object
 */
const DPO = KeetaNetClient.lib.Utils.Helper.debugPrintableObject.bind(KeetaNetClient.lib.Utils.Helper);

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/**
 * Type for certificate attribute names (derived from generated OID database)
 */
export type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

/**
 * Sensitive Attribute Schema
 *
 * ASN.1 Schema:
 * SensitiveAttributes DEFINITIONS ::= BEGIN
 *         SensitiveAttribute ::= SEQUENCE {
 *                 version        INTEGER { v1(0) },
 *                 cipher         SEQUENCE {
 *                         algorithm    OBJECT IDENTIFIER,
 *                         ivOrNonce    OCTET STRING,
 *                         key          OCTET STRING
 *                 },
 *                 hashedValue    SEQUENCE {
 *                         encryptedSalt  OCTET STRING,
 *                         algorithm      OBJECT IDENTIFIER,
 *                         value          OCTET STRING
 *                 },
 *                 encryptedValue OCTET STRING
 *         }
 * END
 *
 * https://keeta.notion.site/Keeta-KYC-Certificate-Extensions-13e5da848e588042bdcef81fc40458b7
 *
 * @internal
 */
const SensitiveAttributeSchemaInternal: [
	version: 0n,
	cipher: [
		algorithm: typeof ASN1.ValidateASN1.IsOID,
		iv: typeof ASN1.ValidateASN1.IsOctetString,
		key: typeof ASN1.ValidateASN1.IsOctetString
	],
	hashedValue: [
		encryptedSalt: typeof ASN1.ValidateASN1.IsOctetString,
		algorithm: typeof ASN1.ValidateASN1.IsOID,
		value: typeof ASN1.ValidateASN1.IsOctetString
	],
	encryptedValue: typeof ASN1.ValidateASN1.IsOctetString
] = [
	0n,
	[
		ASN1.ValidateASN1.IsOID,
		ASN1.ValidateASN1.IsOctetString,
		ASN1.ValidateASN1.IsOctetString
	],
	[
		ASN1.ValidateASN1.IsOctetString,
		ASN1.ValidateASN1.IsOID,
		ASN1.ValidateASN1.IsOctetString
	],
	ASN1.ValidateASN1.IsOctetString
];

/**
 * The Sensitive Attribute Schema Internal
 *
 * @internal
 */
type SensitiveAttributeSchema = ASN1.SchemaMap<typeof SensitiveAttributeSchemaInternal>;

/*
 * Database of permitted algorithms and their OIDs
 */
const sensitiveAttributeOIDDB = {
	'aes-256-gcm': oids.AES_256_GCM,
	'aes-256-cbc': oids.AES_256_CBC,
	'sha2-256': oids.SHA2_256,
	'sha3-256': oids.SHA3_256,
	'sha256': oids.SHA2_256,
	'aes256-gcm': oids.AES_256_GCM,
	'aes256-cbc': oids.AES_256_CBC
};

/**
 * Encode an attribute value using its ASN.1 schema
 */
export function encodeAttribute(name: CertificateAttributeNames, value: unknown): ArrayBuffer {
	const schema = CertificateAttributeSchema[name];

	let encodedJS;
	try {
		encodedJS = new ASN1.ValidateASN1(schema).fromJavaScriptObject(value);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw(new Error(`Attribute ${name}: ${message} (value: ${JSON.stringify(DPO(value))})`));
	}

	if (encodedJS === undefined) {
		throw(new Error(`Unsupported attribute value for encoding: ${JSON.stringify(DPO(value))}`));
	}

	const asn1Object = ASN1.JStoASN1(encodedJS);
	if (!asn1Object) {
		throw(new Error(`Failed to encode value for attribute ${name}`));
	}

	return(asn1Object.toBER(false));
}

/**
 * Prepare a value for inclusion in a SensitiveAttribute: pre-encode complex and date types
 */
export function encodeForSensitive(
	name: CertificateAttributeNames | undefined,
	value: SensitiveAttributeType | Buffer | ArrayBuffer
): Buffer {
	if (Buffer.isBuffer(value)) { return(value); }
	if (value instanceof ArrayBuffer) { return(arrayBufferToBuffer(value)); }
	if (typeof value === 'string') {
		const asn1 = ASN1.JStoASN1({ type: 'string', kind: 'utf8', value });
		return(arrayBufferToBuffer(asn1.toBER(false)));
	}

	if (value instanceof Date) {
		const asn1 = ASN1.JStoASN1(value);
		return(arrayBufferToBuffer(asn1.toBER(false)));
	}

	if (typeof value === 'object' && value !== null) {
		if (!name) { throw(new Error('attributeName required for complex types')); }
		const encoded = encodeAttribute(name, value);
		return(arrayBufferToBuffer(encoded));
	}

	return(Buffer.from(String(value), 'utf-8'));
}

/**
 * Check if value is an ASN.1-like wrapper object
 */
function isASN1Wrapper(obj: object): obj is { type: string; value: unknown } {
	return('type' in obj && 'value' in obj && typeof obj.type === 'string');
}

/**
 * Normalize the result (unwrap ASN.1-like objects)
 */
function normalizeDecodedValue(input: unknown): unknown {
	if (input === undefined || input === null || typeof input !== 'object') {
		return(input);
	}
	if (input instanceof Date || Buffer.isBuffer(input) || input instanceof ArrayBuffer) {
		return(input);
	}
	if (Array.isArray(input)) {
		return(input.map(item => normalizeDecodedValue(item)));
	}
	// Unwrap ASN.1-like objects
	if (isASN1Wrapper(input)) {
		if (input.type === 'string' && typeof input.value === 'string') {
			return(input.value);
		}
		if (input.type === 'date' && input.value instanceof Date) {
			return(input.value);
		}
	}
	// Recursively normalize object properties
	const result: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(input)) {
		result[key] = normalizeDecodedValue(value);
	}
	return(result);
}

/**
 * Decode ASN.1 data using a schema
 *
 * Note: The ASN1 library uses dynamic typing internally, so we consolidate
 * the unsafe operations here rather than scattering them throughout the code.
 */
function decodeWithSchema(buffer: ArrayBuffer, schema: unknown): unknown {
	/* eslint-disable
        @typescript-eslint/no-explicit-any,
        @typescript-eslint/consistent-type-assertions,
		@typescript-eslint/no-unsafe-member-access,
        @typescript-eslint/no-unsafe-call,
		@typescript-eslint/no-unsafe-assignment
    */
	let decodedASN1: ASN1.ASN1AnyJS | undefined;
	try {
		decodedASN1 = new (ASN1.BufferStorageASN1 as any)(buffer, schema).getASN1() as ASN1.ASN1AnyJS;
	} catch {
		decodedASN1 = ASN1.ASN1toJS(buffer);
	}
	if (decodedASN1 === undefined) {
		throw(new Error('Failed to decode ASN1 data'));
	}

	const validator = new (ASN1.ValidateASN1 as any)(schema);
	return(validator.toJavaScriptObject(decodedASN1));
	/* eslint-enable */
}

/**
 * GCM cipher helpers - Node's crypto types don't properly type getAuthTag/setAuthTag
 * when using createCipheriv/createDecipheriv, so we use typed wrappers.
 */
/* eslint-disable @typescript-eslint/consistent-type-assertions -- Reflect.get returns unknown */
function getGCMAuthTag(cipher: ReturnType<typeof crypto.createCipheriv>): Buffer {
	const getAuthTag = Reflect.get(cipher, 'getAuthTag') as (() => Buffer) | undefined;
	if (typeof getAuthTag !== 'function') {
		throw(new Error('getAuthTag is not available on cipher'));
	}
	return(getAuthTag.call(cipher));
}

function setGCMAuthTag(decipher: ReturnType<typeof crypto.createDecipheriv>, tag: Buffer): void {
	const setAuthTag = Reflect.get(decipher, 'setAuthTag') as ((tag: Buffer) => void) | undefined;
	if (typeof setAuthTag !== 'function') {
		throw(new Error('setAuthTag is not available on decipher'));
	}
	setAuthTag.call(decipher, tag);
}
/* eslint-enable @typescript-eslint/consistent-type-assertions */

/**
 * Decode a value from its ASN.1 representation back to the original type
 *
 * @internal
 */
function decodeForSensitive(
	name: CertificateAttributeNames,
	data: Buffer | ArrayBuffer
): unknown {
	const buffer = Buffer.isBuffer(data) ? bufferToArrayBuffer(data) : data;
	const schema: unknown = CertificateAttributeSchema[name];
	const plainObject = decodeWithSchema(buffer, schema);
	return(normalizeDecodedValue(plainObject));
}

export class SensitiveAttributeBuilder {
	readonly #account: KeetaNetAccount;
	#value: Buffer | undefined;
	#attributeName: CertificateAttributeNames | undefined;

	constructor(account: KeetaNetAccount) {
		this.#account = account;
	}

	/**
	 * Set a schema-aware attribute value (handles encoding internally)
	 */
	set<K extends CertificateAttributeNames>(name: K, value: CertificateAttributeValue<K>): this;
	/**
	 * Set raw bytes for encryption
	 */
	set(value: Buffer | ArrayBufferLike): this;
	set<K extends CertificateAttributeNames>(
		nameOrValue: K | Buffer | ArrayBufferLike,
		value?: CertificateAttributeValue<K>
	): this {
		// Distinguish overloads: if value provided, first arg is name; otherwise it's raw bytes
		if (value !== undefined && typeof nameOrValue === 'string') {
			this.#attributeName = nameOrValue;
			this.#value = encodeForSensitive(nameOrValue, value);
		} else if (Buffer.isBuffer(nameOrValue)) {
			this.#value = nameOrValue;
		} else if (typeof nameOrValue === 'object' && nameOrValue !== null) {
			this.#value = arrayBufferLikeToBuffer(nameOrValue);
		}

		return(this);
	}

	async build<T = ArrayBuffer>(): Promise<SensitiveAttribute<T>> {
		if (this.#value === undefined) {
			throw(new Error('Value not set'));
		}

		const salt = crypto.randomBytes(32);

		const hashingAlgorithm = KeetaNetClient.lib.Utils.Hash.HashFunctionName;
		const publicKey = Buffer.from(this.#account.publicKey.get());

		const cipher = 'aes-256-gcm';
		const key = crypto.randomBytes(32);
		const nonce = crypto.randomBytes(12);
		const encryptedKey = await this.#account.encrypt(bufferToArrayBuffer(key));

		function encrypt(value: Buffer) {
			const cipherObject = crypto.createCipheriv(cipher, key, nonce);
			let retval = Buffer.concat([cipherObject.update(value), cipherObject.final()]);

			// For AES-GCM, append the 16-byte authentication tag
			if (cipher === 'aes-256-gcm') {
				retval = Buffer.concat([retval, getGCMAuthTag(cipherObject)]);
			}

			return(retval);
		}

		const encryptedValue = encrypt(this.#value);
		const encryptedSalt = encrypt(arrayBufferLikeToBuffer(salt));

		const saltedValue = Buffer.concat([salt, publicKey, encryptedValue, this.#value]);
		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(saltedValue);

		const attributeStructure: SensitiveAttributeSchema = [
			/* Version */
			0n,
			/* Cipher Details */
			[
				/* Algorithm */
				{ type: 'oid', oid: getOID(cipher, sensitiveAttributeOIDDB) },
				/* IV or Nonce */
				nonce,
				/* Symmetric key, encrypted with the public key of the account */
				Buffer.from(encryptedKey)
			],
			/* Hashed Value */
			[
				/* Encrypted Salt */
				Buffer.from(encryptedSalt),
				/* Hashing Algorithm */
				{ type: 'oid', oid: getOID(hashingAlgorithm, sensitiveAttributeOIDDB) },
				/* Hash of <Encrypted Salt> || <Public Key> || <Value> */
				Buffer.from(hashedAndSaltedValue)
			],
			/* Encrypted Value, encrypted with the Cipher above */
			encryptedValue
		];

		const encodedAttributeObject = ASN1.JStoASN1(attributeStructure);

		// Produce canonical DER as ArrayBuffer
		const encryptedDER = encodedAttributeObject.toBER(false);

		// Create decoder if we have an attribute name
		let decoder: ((data: Buffer | ArrayBuffer) => T | Promise<T>) | undefined;
		if (this.#attributeName) {
			const attrName = this.#attributeName;
			decoder = function(data: Buffer | ArrayBuffer): T {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return(decodeForSensitive(attrName, data) as T);
			};
		}

		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		return(new SensitiveAttribute<T>(this.#account, encryptedDER, decoder));
	}
}

export class SensitiveAttribute<T = ArrayBuffer> {
	private static readonly SensitiveAttributeObjectTypeID = 'c0cc9591-cebb-4441-babe-23739279e3f2';
	private readonly SensitiveAttributeObjectTypeID!: string;

	readonly #account: KeetaNetAccount;
	readonly #encryptedDER: ArrayBuffer;
	readonly #info: ReturnType<SensitiveAttribute<T>['decode']>;
	readonly #decoder?: (data: Buffer | ArrayBuffer) => T | Promise<T>;

	constructor(
		account: KeetaNetAccount,
		data: Buffer | ArrayBuffer,
		decoder?: (data: Buffer | ArrayBuffer) => T | Promise<T>
	) {
		Object.defineProperty(this, 'SensitiveAttributeObjectTypeID', {
			value: SensitiveAttribute.SensitiveAttributeObjectTypeID,
			enumerable: false
		});

		this.#account = account;
		this.#encryptedDER = Buffer.isBuffer(data) ? bufferToArrayBuffer(data) : data;
		this.#info = this.decode(data);
		if (decoder) {
			this.#decoder = decoder;
		}
	}

	/**
	 * Check if a value is a SensitiveAttribute instance
	 */
	static isInstance(input: unknown): input is SensitiveAttribute<unknown> {
		if (typeof input !== 'object' || input === null) {
			return(false);
		}

		return(Reflect.get(input, 'SensitiveAttributeObjectTypeID') === SensitiveAttribute.SensitiveAttributeObjectTypeID);
	}

	/**
	 * Get the public key this attribute was encrypted for
	 */
	get publicKey(): string {
		return(this.#account.publicKeyString.get());
	}

	/**
	 * Get the raw encrypted DER for certificate embedding
	 */
	toDER(): ArrayBuffer {
		return(this.#encryptedDER);
	}

	private decode(data: Buffer | ArrayBuffer) {
		if (Buffer.isBuffer(data)) {
			data = bufferToArrayBuffer(data);
		}

		let decodedAttribute;
		try {
			const dataObject = new ASN1.BufferStorageASN1(data, SensitiveAttributeSchemaInternal);
			decodedAttribute = dataObject.getASN1();
		} catch {
			const js = ASN1.ASN1toJS(data);
			throw(new Error(`SensitiveAttribute.decode: unexpected DER shape ${JSON.stringify(DPO(js))}`));
		}

		const decodedVersion = decodedAttribute[0] + 1n;
		if (decodedVersion !== 1n) {
			throw(new Error(`Unsupported Sensitive Attribute version (${decodedVersion})`));
		}

		return({
			version: decodedVersion,
			publicKey: this.#account.publicKeyString.get(),
			cipher: {
				algorithm: lookupByOID(decodedAttribute[1][0].oid, sensitiveAttributeOIDDB),
				iv: decodedAttribute[1][1],
				key: decodedAttribute[1][2]
			},
			hashedValue: {
				encryptedSalt: decodedAttribute[2][0],
				algorithm: lookupByOID(decodedAttribute[2][1].oid, sensitiveAttributeOIDDB),
				value: decodedAttribute[2][2]
			},
			encryptedValue: decodedAttribute[3]
		});
	}

	async #decryptValue(value: Buffer) {
		const decryptedKey = await this.#account.decrypt(bufferToArrayBuffer(this.#info.cipher.key));
		const algorithm = this.#info.cipher.algorithm;
		const iv = this.#info.cipher.iv;

		const decipher = crypto.createDecipheriv(algorithm, Buffer.from(decryptedKey), iv);

		// For AES-GCM, extract and set the 16-byte authentication tag
		if (algorithm === 'aes-256-gcm') {
			const authTag = value.subarray(value.length - 16);
			const ciphertext = value.subarray(0, value.length - 16);

			setGCMAuthTag(decipher, authTag);

			const decrypted = decipher.update(ciphertext);
			decipher.final(); // Verify auth tag
			return(decrypted);
		}

		// For other algorithms (like CBC), just decrypt normally
		const decrypted = decipher.update(value);
		decipher.final();
		return(decrypted);
	}

	/**
	 * Get the value of the sensitive attribute
	 *
	 * This will decrypt the value using the account's private key
	 * and return the value as an ArrayBuffer
	 *
	 * Since sensitive attributes are binary blobs, this returns an
	 * ArrayBuffer
	 */
	async get(): Promise<ArrayBuffer> {
		const decryptedValue = await this.#decryptValue(arrayBufferLikeToBuffer(this.#info.encryptedValue));
		return(bufferToArrayBuffer(decryptedValue));
	}

	async getValue(): Promise<T> {
		const value = await this.get();
		if (!this.#decoder) {
			/**
			 * TypeScript complains that T may not be the correct
			 * type here, but gives us no tools to enforce that it
			 * is -- it should always be ArrayBuffer if no decoder
			 * is provided, but someone could always specify a
			 * type parameter in that case and we cannot check
			 * that at runtime since T is only a compile-time type.
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			return(value as unknown as T);
		}
		return(await this.#decoder(value));
	}

	/**
	 * Generate a proof that a sensitive attribute is a given value,
	 * which can be validated by a third party using the certificate
	 * and the `validateProof` method
	 */
	async getProof(): Promise<{ value: string; hash: { salt: string }}> {
		const value = await this.get();
		const salt = await this.#decryptValue(arrayBufferLikeToBuffer(this.#info.hashedValue.encryptedSalt));

		return({
			value: Buffer.from(value).toString('base64'),
			hash: {
				salt: salt.toString('base64')
			}
		});
	}

	/**
	 * Validate the proof that a sensitive attribute is a given value
	 */
	async validateProof(proof: Awaited<ReturnType<this['getProof']>>): Promise<boolean> {
		const plaintextValue = Buffer.from(proof.value, 'base64');
		const proofSaltBuffer = Buffer.from(proof.hash.salt, 'base64');

		const publicKeyBuffer = Buffer.from(this.#account.publicKey.get());
		const encryptedValue = this.#info.encryptedValue;

		const hashInput = Buffer.concat([proofSaltBuffer, publicKeyBuffer, encryptedValue, plaintextValue]);
		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(hashInput);
		const hashedAndSaltedValueBuffer = Buffer.from(hashedAndSaltedValue);

		return(this.#info.hashedValue.value.equals(hashedAndSaltedValueBuffer));
	}

	toJSON(): unknown/* XXX:TODO */ {
		return(convertToJSON(this.#info));
	}
}

