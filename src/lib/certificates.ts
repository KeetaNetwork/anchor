import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as oids from '../services/kyc/oids.generated.js';
import * as ASN1 from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';
import type { SensitiveAttributeType, CertificateAttributeValue } from '../services/kyc/iso20022.generated.js';
import { CertificateAttributeOIDDB, CertificateAttributeSchema } from '../services/kyc/iso20022.generated.js';
import { getOID, lookupByOID } from './utils/oid.js';
import { convertToJSON as convertToJSONUtil } from './utils/json.js';
import { EncryptedContainer } from './encrypted-container.js';
import { assertSharableCertificateAttributesContentsSchema } from './certificates.generated.js';
import { checkHashWithOID } from './utils/external.js';

/**
 * Short alias for printing a debug representation of an object
 */
const DPO = KeetaNetClient.lib.Utils.Helper.debugPrintableObject.bind(KeetaNetClient.lib.Utils.Helper);

/**
 * Short alias for the KeetaNetAccount type
 */
const KeetaNetAccount: typeof KeetaNetClient.lib.Account = KeetaNetClient.lib.Account;

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/*
 * Base Certificate types, aliased for convenience
 */
type BaseCertificateClass = typeof KeetaNetClient.lib.Utils.Certificate.Certificate;
type BaseCertificate = InstanceType<BaseCertificateClass>;
const BaseCertificate: BaseCertificateClass = KeetaNetClient.lib.Utils.Certificate.Certificate;
type BaseCertificateBuilderClass = typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder;
type BaseCertificateBuilder = InstanceType<BaseCertificateBuilderClass>;
const BaseCertificateBuilder: BaseCertificateBuilderClass = KeetaNetClient.lib.Utils.Certificate.CertificateBuilder;

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/**
 * Recursively normalize object properties
 */
function normalizeDecodedASN1Object(obj: object, principals: KeetaNetAccount[]): { [key: string]: unknown } {
	const result: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(obj)) {
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		result[key] = normalizeDecodedASN1(value, principals);
	}
	return(result);
}

/**
 * Post-process the output from toJavaScriptObject() to:
 * 1. Unwrap any remaining ASN.1-like objects (from IsAnyString/IsAnyDate)
 * 2. Add domain-specific $blob function to Reference objects
 */
function normalizeDecodedASN1(input: unknown, principals: KeetaNetAccount[]): unknown {
	// Handle primitives
	if (input === undefined || input === null || typeof input !== 'object') {
		return(input);
	}
	if (input instanceof Date || Buffer.isBuffer(input) || input instanceof ArrayBuffer) {
		return(input);
	}

	// Handle arrays
	if (Array.isArray(input)) {
		return(input.map(item => normalizeDecodedASN1(item, principals)));
	}

	// Unwrap ASN.1-like objects from ambiguous schemas (IsAnyString, IsAnyDate, IsBitString)
	// These are plain objects like { type: 'string', kind: 'utf8', value: 'text' }
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const obj = input as { type?: string; kind?: string; value?: unknown; unusedBits?: number; contains?: unknown };
	if (obj.type === 'string' && 'value' in obj && typeof obj.value === 'string') {
		return(obj.value);
	}
	if (obj.type === 'date' && 'value' in obj && obj.value instanceof Date) {
		return(obj.value);
	}
	if (obj.type === 'bitstring' && 'value' in obj && Buffer.isBuffer(obj.value)) {
		return(obj.value);
	}

	// Check if this is a Reference object (has external.url and digest fields)
	if ('external' in obj && 'digest' in obj && isPlainObject(obj.external) && isPlainObject(obj.digest)) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const ref = obj as { external: { url?: string; contentType?: string }; digest?: { digestAlgorithm?: string | { oid?: string }; digest?: unknown }; encryptionAlgorithm?: string | { oid?: string }};
		const url = ref.external.url;
		const mimeType = ref.external.contentType;

		// After toJavaScriptObject(), OIDs are strings, not {oid: string}
		const encryptionAlgoOID = typeof ref.encryptionAlgorithm === 'string'
			? ref.encryptionAlgorithm
			: ref.encryptionAlgorithm?.oid;
		const digestInfo = ref.digest;

		if (typeof url === 'string' && typeof mimeType === 'string' && digestInfo) {
			let cachedValue: Blob | null = null;

			return({
				...normalizeDecodedASN1Object(obj, principals),
				$blob: async function(additionalPrincipals?: ConstructorParameters<typeof EncryptedContainer>[0]): Promise<Blob> {
					if (cachedValue) {
						return(cachedValue);
					}

					const fetchResult = await fetch(url);
					if (!fetchResult.ok) {
						throw(new Error(`Failed to fetch remote data from ${url}: ${fetchResult.status} ${fetchResult.statusText}`));
					}

					const dataBlob = await fetchResult.blob();
					let data = await dataBlob.arrayBuffer();

					// Handle JSON base64 encoding
					if (dataBlob.type === 'application/json') {
						try {
							const asJSON: unknown = JSON.parse(Buffer.from(data).toString('utf-8'));
							if (isPlainObject(asJSON) && Object.keys(asJSON).length === 2) {
								if ('data' in asJSON && typeof asJSON.data === 'string' && 'mimeType' in asJSON && typeof asJSON.mimeType === 'string') {
									data = bufferToArrayBuffer(Buffer.from(asJSON.data, 'base64'));
								}
							}
						} catch {
							/* Ignored */
						}
					}

					// Decrypt if needed
					if (encryptionAlgoOID) {
						switch (encryptionAlgoOID) {
							case '1.3.6.1.4.1.62675.2':
							case 'KeetaEncryptedContainerV1': {
								const container = EncryptedContainer.fromEncryptedBuffer(data, [
									...principals,
									...(additionalPrincipals ?? [])
								]);
								data = await container.getPlaintext();
								break;
							}
							default:
								throw(new Error(`Unsupported encryption algorithm OID: ${encryptionAlgoOID}`));
						}
					}

					// Verify hash (checkHashWithOID now accepts string OIDs directly)
					if (!Buffer.isBuffer(digestInfo.digest)) {
						throw(new TypeError('Digest value is not a buffer'));
					}

					const validHash = await checkHashWithOID(data, digestInfo);
					if (validHash !== true) {
						throw(validHash);
					}

					const blob = new Blob([data], { type: mimeType });
					cachedValue = blob;
					return(blob);
				}
			});
		}
	}

	// Recursively process plain objects
	return(normalizeDecodedASN1Object(obj, principals));
}

function isBlob(input: unknown): input is Blob {
	if (typeof input !== 'object' || input === null) {
		return(false);
	}

	if (!('arrayBuffer' in input)) {
		return(false);
	}

	if (typeof input.arrayBuffer !== 'function') {
		return(false);
	}

	return(true);
}

async function walkObject(input: unknown, keyTransformer?: (key: string, input: unknown, keyParentObject: object) => Promise<unknown>): Promise<unknown> {
	keyTransformer ??= async function(input: unknown): Promise<unknown> {
		return(input);
	};

	if (typeof input !== 'object' || input === null) {
		return(input);
	}

	if (Buffer.isBuffer(input)) {
		return(input);
	}

	if (typeof input === 'function') {
		return(input);
	}

	if (input instanceof Date) {
		return(input);
	}

	if (Array.isArray(input)) {
		const newArray = [];
		let key = -1;
		for (const item of input) {
			key++;
			newArray.push(await walkObject(await keyTransformer(String(key), item, input), keyTransformer));
		}
		return(newArray);
	}

	const newObj: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(input)) {
		newObj[key] = await walkObject(await keyTransformer(key, value, input), keyTransformer);
	}
	return(newObj);
}

function toJSON(data: unknown): unknown {
	return(convertToJSONUtil(data));
}

// Generic type guard to align decoded values with generated attribute types
function isAttributeValue<NAME extends CertificateAttributeNames>(
	_name: NAME,
	_v: unknown
): _v is CertificateAttributeValue<NAME> {
	// Runtime schema validation is already performed by BufferStorageASN1; this guard
	// serves to inform TypeScript of the precise type tied to the attribute name.
	return(true);
}

// Helper to apply type guard once and return the properly typed value
function asAttributeValue<NAME extends CertificateAttributeNames>(
	name: NAME,
	v: unknown
): CertificateAttributeValue<NAME> {
	if (!isAttributeValue(name, v)) {
		throw(new Error('internal error: decoded value did not match expected type'));
	}
	return(v);
}

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

function assertCertificateAttributeNames(name: string): asserts name is CertificateAttributeNames {
	if (!(name in CertificateAttributeOIDDB)) {
		throw(new Error(`Unknown attribute name: ${name}`));
	}
}

function asCertificateAttributeNames(name: string): CertificateAttributeNames {
	assertCertificateAttributeNames(name);
	return(name);
}

function encodeAttribute(name: CertificateAttributeNames, value: unknown): ArrayBuffer {
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

// Prepare a value for inclusion in a SensitiveAttribute: pre-encode complex and date types
function encodeForSensitive(
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

function unwrapSingleLayer(schema: ASN1.Schema): ASN1.Schema {
	if (typeof schema === 'object' && schema !== null && 'type' in schema && schema.type === 'context') {
		return(schema.contains);
	}

	return(schema);
}

function unwrapFieldSchema(fieldSchema: ASN1.Schema): ASN1.Schema {
	if (typeof fieldSchema === 'object' && fieldSchema !== null && 'optional' in fieldSchema) {
		const unwrapped = unwrapSingleLayer(fieldSchema.optional);
		return({ optional: unwrapped });
	}

	return(unwrapSingleLayer(fieldSchema));
}

/**
 * Create a backwards-compatible version of a schema by removing context tag wrappers from struct fields.
 */
function unwrapContextTagsFromSchema(schema: ASN1.Schema): ASN1.Schema {
	// If it's a struct, unwrap context tags from its fields
	if (typeof schema === 'object' && schema !== null && 'type' in schema && schema.type === 'struct') {
		const unwrappedContains: { [key: string]: ASN1.Schema } = {};
		for (const [fieldName, fieldSchema] of Object.entries(schema.contains)) {
			unwrappedContains[fieldName] = unwrapFieldSchema(fieldSchema);
		}

		return({
			type: 'struct',
			fieldNames: schema.fieldNames,
			contains: unwrappedContains
		});
	}

	return(schema);
}

/**
 * Fallback decoder for entityType attribute from old certificates.
 * Transforms raw ASN1 into the expected EntityType structure.
 */
function decodeEntityTypeFallback(value: ArrayBuffer, principals: KeetaNetAccount[]): unknown {
	const rawASN1 = ASN1.ASN1toJS(value);
	// Per EntityTypeSchema: value 0 = organization, value 1 = person
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const choiceTag = (Array.isArray(rawASN1) ? rawASN1[0] : rawASN1) as { type?: string; value?: number; contains?: unknown };
	if (choiceTag?.type === 'context' && typeof choiceTag.value === 'number') {
		// Transform schemeName CHOICE: value 0 = code, value 1 = proprietary
		function transformSchemeName(raw: unknown): unknown {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const ctx = raw as { type?: string; value?: number; contains?: unknown };
			if (ctx?.type === 'context' && typeof ctx.value === 'number') {
				const val = normalizeDecodedASN1(ctx.contains, principals);
				if (ctx.value === 0) { return({ code: val }); }
				if (ctx.value === 1) { return({ proprietary: val }); }
			}
			return(normalizeDecodedASN1(raw, principals));
		}

		// Transform identification arrays into proper objects
		function transformIdentifications(items: unknown): unknown {
			if (!Array.isArray(items)) {
				return(normalizeDecodedASN1(items, principals));
			}

			return(items.map(function(item) {
				if (!Array.isArray(item)) {
					return(normalizeDecodedASN1(item, principals));
				}
				// Position 0 is always 'id'
				// Position 1 could be 'issuer' (string) or 'schemeName' (object/array)
				// Position 2 (if exists) is 'schemeName'
				const result: { id?: unknown; issuer?: unknown; schemeName?: unknown } = {};
				if (item.length >= 1) {
					result.id = normalizeDecodedASN1(item[0], principals);
				}

				if (item.length === 2) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
					const val = item[1];
					if (typeof val === 'string') {
						result.issuer = val;
					} else {
						result.schemeName = transformSchemeName(val);
					}
				} else if (item.length >= 3) {
					result.issuer = normalizeDecodedASN1(item[1], principals);
					result.schemeName = transformSchemeName(item[2]);
				}

				return(result);
			}));
		}

		const transformed = transformIdentifications(choiceTag.contains);
		if (choiceTag.value === 0) {
			return({ organization: transformed });
		} else if (choiceTag.value === 1) {
			return({ person: transformed });
		}
	}

	// Fallback to raw normalized output
	return(normalizeDecodedASN1(rawASN1, principals));
}

async function decodeAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer, principals: KeetaNetAccount[]): Promise<CertificateAttributeValue<NAME>> {
	const schema = CertificateAttributeSchema[name];

	let decodedASN1: ASN1.ASN1AnyJS | undefined;
	let usedSchema = schema;
	try {
		// Try with current schema (includes context tags for structs with optional fields)
		// @ts-expect-error
		decodedASN1 = new ASN1.BufferStorageASN1(value, schema).getASN1();
	} catch (firstError) {
		// Fallback: try with backwards-compatible schema (context tags stripped)
		// This supports old certificates encoded before context tags were added
		try {
			// Special handling for entityType
			if (name === 'entityType') {
				const candidate = decodeEntityTypeFallback(value, principals);
				return(asAttributeValue(name, candidate));
			}

			const backwardsCompatSchema = unwrapContextTagsFromSchema(schema);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			decodedASN1 = new ASN1.BufferStorageASN1(value, backwardsCompatSchema).getASN1();
			usedSchema = backwardsCompatSchema;
		} catch {
			// If both fail, throw the original error
			throw(firstError);
		}
	}

	if (!decodedASN1) {
		throw(new Error('Failed to decode ASN1 data'));
	}

	const validator = new ASN1.ValidateASN1(usedSchema);
	const plainObject = validator.toJavaScriptObject(decodedASN1);

	// Post-process to:
	// 1. Unwrap any remaining ASN.1-like objects
	// 2. Add domain-specific $blob function to Reference objects
	// @ts-expect-error
	const candidate = normalizeDecodedASN1(plainObject, principals);
	return(asAttributeValue(name, candidate));
}

class SensitiveAttributeBuilder {
	readonly #account: KeetaNetAccount;
	#value: Buffer | undefined;

	constructor(account: KeetaNetAccount) {
		this.#account = account;
	}

	set(value: Buffer | ArrayBufferLike): this {
		this.#value = Buffer.isBuffer(value) ? value : arrayBufferLikeToBuffer(value);
		return(this);
	}

	async build() {
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
			let retval = cipherObject.update(value);
			retval = Buffer.concat([retval, cipherObject.final()]);

			/*
			 * For AES-GCM, the last 16 bytes are the authentication tag
			 */
			if (cipher === 'aes-256-gcm') {
				const getAuthTagFn = Reflect.get(cipherObject, 'getAuthTag');
				if (typeof getAuthTagFn === 'function') {
					const tag: unknown = getAuthTagFn.call(cipherObject);
					if (!Buffer.isBuffer(tag)) { throw(new Error('getAuthTag did not return a Buffer')); }
					retval = Buffer.concat([retval, tag]);
				} else {
					throw(new Error('getAuthTag is not available on cipherObject'));
				}
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
		const retval = encodedAttributeObject.toBER(false);
		return(retval);
	}
}

class SensitiveAttribute<T = ArrayBuffer> {
	readonly #account: KeetaNetAccount;
	readonly #info: ReturnType<SensitiveAttribute<T>['decode']>;
	readonly #decoder?: (data: Buffer | ArrayBuffer) => T;

	constructor(account: KeetaNetAccount, data: Buffer | ArrayBuffer, decoder?: (data: Buffer | ArrayBuffer) => T) {
		this.#account = account;
		this.#info = this.decode(data);
		if (decoder) {
			this.#decoder = decoder;
		}
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

		const cipher = crypto.createDecipheriv(algorithm, Buffer.from(decryptedKey), iv);

		// For AES-GCM, the last 16 bytes are the authentication tag
		if (algorithm === 'aes-256-gcm') {
			const authTag = value.subarray(value.length - 16);
			const ciphertext = value.subarray(0, value.length - 16);

			// XXX:TODO Fix typescript unsafe calls
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const setAuthTagFn = Reflect.get(cipher, 'setAuthTag');
			if (typeof setAuthTagFn === 'function') {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				setAuthTagFn.call(cipher, authTag);
			} else {
				throw(new Error('setAuthTag is not available on cipher'));
			}

			const decrypted = cipher.update(ciphertext);
			cipher.final(); // Verify auth tag
			return(decrypted);
		}

		// For other algorithms (like CBC), just decrypt normally
		const decryptedValue = cipher.update(value);
		cipher.final();
		return(decryptedValue);
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
		return(this.#decoder(value));
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
		return(toJSON(this.#info));
	}
}

/**
 * Type for certificate attribute names (derived from generated OID database)
 */
type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

type BaseCertificateBuilderParams = NonNullable<ConstructorParameters<BaseCertificateBuilderClass>[0]>;
type CertificateBuilderParams = Required<Pick<BaseCertificateBuilderParams, 'issuer' | 'validFrom' | 'validTo' | 'serial' | 'hashLib' | 'issuerDN' | 'subjectDN' | 'isCA'> & {
	/**
	 * The key of the subject -- used for Sensitive Attributes as well
	 * as the certificate Subject
	 */
	subject: BaseCertificateBuilderParams['subjectPublicKey'];
}>;

/**
 * ASN.1 Schema for Certificate KYC Attributes Extension
 *
 * KYCAttributes DEFINITIONS ::= BEGIN
 *         KYCAttributes ::= SEQUENCE OF Attribute
 *         Attribute ::= SEQUENCE {
 *                 -- Name of the attribute
 *                 name        OBJECT IDENTIFIER,
 *                 -- Value of this attribute
 *                 value       CHOICE {
 *                         -- A plain value, not sensitive
 *                         plainValue       [0] IMPLICIT OCTET STRING,
 *                         -- A sensitive value, encoded as a SensitiveAttribute in DER encoding
 *                         sensitiveValue   [1] IMPLICIT OCTET STRING
 *                 }
 *         }
 * END
 *
 * https://keeta.notion.site/Keeta-KYC-Certificate-Extensions-13e5da848e588042bdcef81fc40458b7
 *
 */
const CertificateKYCAttributeSchemaValidation = {
	sequenceOf: [ASN1.ValidateASN1.IsOID, {
		choice: [
			{ type: 'context' as const, value: 0 as const, kind: 'implicit' as const, contains: ASN1.ValidateASN1.IsOctetString },
			{ type: 'context' as const, value: 1 as const, kind: 'implicit' as const, contains: ASN1.ValidateASN1.IsOctetString }
		]
	}]
} satisfies ASN1.Schema;

/** @internal */
type CertificateKYCAttributeSchema = ASN1.SchemaMap<typeof CertificateKYCAttributeSchemaValidation>;

// Attribute input type sourced from generated definitions
type CertificateAttributeInput<NAME extends CertificateAttributeNames> = CertificateAttributeValue<NAME>;

export class CertificateBuilder extends BaseCertificateBuilder {
	readonly #attributes: {
		[name: string]: { sensitive: boolean; value: ArrayBuffer }
	} = {};

	/**
	 * Map the parameters from the public interface to the internal
	 * (Certificate library) interface
	 */
	private static mapParams(params?: Partial<CertificateBuilderParams>): Partial<BaseCertificateBuilderParams> {
		const paramsCopy = { ...params };
		let subjectPublicKey;
		if (paramsCopy.subject) {
			subjectPublicKey = paramsCopy.subject;
			delete(paramsCopy.subject);
		}
		const retval: Partial<BaseCertificateBuilderParams> = paramsCopy;
		if (subjectPublicKey) {
			retval.subjectPublicKey = subjectPublicKey;
		}
		return(retval);
	}

	constructor(params?: Partial<CertificateBuilderParams>) {
		super(CertificateBuilder.mapParams(params));
	}

	/**
	 * Set a KYC Attribute to a given value.
	 * The sensitive flag is required.
	 *
	 * If an attribute is marked sensitive, the value is encoded
	 * into the certificate using a commitment scheme so that the
	 * value can be proven later without revealing it.
	 */
	setAttribute<NAME extends CertificateAttributeNames>(name: NAME, sensitive: boolean, value: CertificateAttributeInput<NAME>): void {
		// Non-sensitive path: only primitive schema (string/date) allowed
		const schemaValidator = CertificateAttributeSchema[name];
		let encoded: ArrayBuffer;
		if (value instanceof ArrayBuffer) {
			encoded = value;
		} else if (name in CertificateAttributeSchema) {
			/* XXX: Why do we have two encoding methods ? */
			encoded = bufferToArrayBuffer(encodeForSensitive(name, value));
		} else if (schemaValidator === ASN1.ValidateASN1.IsDate) {
			if (!(value instanceof Date)) {
				throw(new Error('Expected Date value'));
			}

			encoded = encodeAttribute(name, value);
		} else if (schemaValidator === ASN1.ValidateASN1.IsString && typeof value === 'string') {
			encoded = encodeAttribute(name, value);
		} else {
			throw(new Error('Unsupported non-sensitive value type'));
		}

		this.#attributes[name] = {
			sensitive: sensitive,
			value: encoded
		};
	}

	protected async addExtensions(...args: Parameters<BaseCertificateBuilder['addExtensions']>): ReturnType<BaseCertificateBuilder['addExtensions']> {
		const retval = await super.addExtensions(...args);

		const subject = args[0].subjectPublicKey;

		/* Encode the attributes */
		const certAttributes: CertificateKYCAttributeSchema = [];
		for (const [name, attribute] of Object.entries(this.#attributes)) {
			if (!(name in CertificateAttributeOIDDB)) {
				throw(new Error(`Unknown attribute: ${name}`));
			}

			/*
			 * Since we are iteratively building the certificate, we
			 * can assume that the attribute is always present in
			 * the object
			 */
			assertCertificateAttributeNames(name);
			const nameOID = CertificateAttributeOIDDB[name];

			let value: Buffer;
			if (attribute.sensitive) {
				const builder = new SensitiveAttributeBuilder(subject);
				builder.set(attribute.value);
				value = arrayBufferToBuffer(await builder.build());
			} else {
				if (typeof attribute.value === 'string') {
					value = Buffer.from(attribute.value, 'utf-8');
				} else {
					value = arrayBufferToBuffer(attribute.value);
				}
			} certAttributes.push([{
				type: 'oid',
				oid: nameOID
			}, {
				type: 'context',
				kind: 'implicit',
				value: attribute.sensitive ? 1 : 0,
				contains: value
			}]);
		}

		if (certAttributes.length > 0) {
			retval.push(
				BaseCertificateBuilder.extension(oids.keeta.KYC_ATTRIBUTES, certAttributes)
			);
		}

		return(retval);
	}

	/**
	 * Create a Certificate object from the builder
	 *
	 * The parameters passed in are merged with the parameters passed in
	 * when constructing the builder
	 */
	async build(params?: Partial<CertificateBuilderParams>): Promise<Certificate> {
		const paramsCopy = CertificateBuilder.mapParams(params);
		const certificate = await super.buildDER(paramsCopy);
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		const certificateObject = new Certificate(certificate, {
			/**
			 * Specify the moment as `null` to avoid validation
			 * of the certificate's validity period.  We don't
			 * care if the certificate is expired or not for
			 * the purposes of this builder.
			 */
			moment: null
		});

		return(certificateObject);
	}
}

export class Certificate extends BaseCertificate {
	private readonly subjectKey: KeetaNetAccount;
	static readonly Builder: typeof CertificateBuilder = CertificateBuilder;
	static readonly SharableAttributes: typeof SharableCertificateAttributes;

	/**
     * User KYC Attributes
     */
	readonly attributes: {
		[name in CertificateAttributeNames]?: {
			sensitive: true;
			value: SensitiveAttribute<CertificateAttributeValue<name>>;
		} | {
			sensitive: false;
			value: ArrayBuffer;
		}
	} = {};

	constructor(input: ConstructorParameters<BaseCertificateClass>[0], options?: ConstructorParameters<BaseCertificateClass>[1] & { subjectKey?: KeetaNetAccount }) {
		super(input, options);

		this.subjectKey = options?.subjectKey ?? this.subjectPublicKey;

		super.finalizeConstruction();
	}

	protected finalizeConstruction(): void {
		/* Do nothing, we call the super method in the constructor */
	}

	private setPlainAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): void {
		// @ts-ignore
		this.attributes[name] = { sensitive: false, value } satisfies typeof this.attributes[NAME];
	}

	private setSensitiveAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): void {
		const decodeForSensitive = async (data: Buffer | ArrayBuffer): Promise<CertificateAttributeValue<NAME>> => {
			const bufferInput = Buffer.isBuffer(data) ? bufferToArrayBuffer(data) : data;
			return(await decodeAttribute(name, bufferInput, [this.subjectKey]));
		};
		this.attributes[name] = {
			sensitive: true,
			value: new SensitiveAttribute(this.subjectKey, value, decodeForSensitive)
		} satisfies typeof this.attributes[NAME];
	}

	/**
	 * Get the underlying value for an attribute.
	 *
	 * If the attribute is sensitive, this will decrypt it using the
	 * subject's private key, otherwise it will return the value.
	 */
	async getAttributeValue<NAME extends CertificateAttributeNames>(attributeName: NAME): Promise<CertificateAttributeValue<NAME>> {
		const attr = this.attributes[attributeName]?.value;
		if (!attr) {
			throw(new Error(`Attribute ${attributeName} is not available`));
		}

		if (attr instanceof SensitiveAttribute) {
			const raw = await attr.get();
			return(await decodeAttribute(attributeName, raw, [this.subjectKey]));
		}

		// Non-sensitive: ArrayBuffer or Buffer
		if (attr instanceof ArrayBuffer || Buffer.isBuffer(attr)) {
			return(await decodeAttribute(attributeName, attr, [this.subjectKey]));
		}

		throw(new Error(`Attribute ${attributeName} is not a supported type`));
	}

	protected processExtension(id: string, value: ArrayBuffer): boolean {
		if (super.processExtension(id, value)) {
			return(true);
		}

		if (id === oids.keeta.KYC_ATTRIBUTES) {
			const attributesRaw = new ASN1.BufferStorageASN1(value, CertificateKYCAttributeSchemaValidation).getASN1();

			for (const attribute of attributesRaw) {
				const nameString = lookupByOID(attribute[0].oid, CertificateAttributeOIDDB);
				const name = asCertificateAttributeNames(nameString);
				const valueKind = attribute[1].value;
				const value = bufferToArrayBuffer(attribute[1].contains);

				switch (valueKind) {
					case 0:
						/* Plain Value */
						this.setPlainAttribute(name, value);
						break;
					case 1:
						/* Sensitive Value */
						this.setSensitiveAttribute(name, value);
						break;
					default:
						assertNever(valueKind);
				}
			}

			return(true);
		}

		return(false);
	}
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SharableCertificateAttributesTypes {
	export type ExportOptions = {
		/**
		 * Format of the exported data
		 * - 'string': PEM-encoded string
		 * - 'arraybuffer': raw ArrayBuffer
		 */
		format?: 'string' | 'arraybuffer';
	};
	export type ImportOptions = {
		/**
		 * Principals that will be used to try to access the
		 * encrypted contents of the sharable certificate
		 */
		principals?: Set<KeetaNetAccount> | KeetaNetAccount[] | KeetaNetAccount | null;
	};
	export type ContentsSchema = {
		certificate: string;
		intermediates?: string[] | undefined;
		attributes: {
			[name: string]: {
				sensitive: true;
				value: Awaited<ReturnType<SensitiveAttribute['getProof']>>;
				references?: { [id: string]: string };
			} | {
				sensitive: false;
				value: string;
				references?: { [id: string]: string };
			}
		};
	};
};
type SharableCertificateAttributesExportOptions = SharableCertificateAttributesTypes.ExportOptions;
type SharableCertificateAttributesImportOptions = SharableCertificateAttributesTypes.ImportOptions;
type SharableCertificateAttributesContentsSchema = SharableCertificateAttributesTypes.ContentsSchema;

export class SharableCertificateAttributes {
	#certificate?: Certificate;
	#intermediates?: Set<BaseCertificate>;
	#attributes: {
		[name: string]: {
			sensitive: boolean;
			value: ArrayBuffer;
			references?: { [id: string]: string } | undefined;
		}
	} = {};

	private container: EncryptedContainer;
	private populatedFromInit = false;

	static assertCertificateAttributeName: typeof assertCertificateAttributeNames = assertCertificateAttributeNames;

	constructor(input: ArrayBuffer | Buffer | string, options?: SharableCertificateAttributesImportOptions) {
		let containerBuffer: Buffer;
		if (typeof input === 'string') {
			/*
			 * Attempt to decode as PEM, but also if not PEM, then return
			 * the lines as-is (base64) after removing whitespace
			 */
			const inputLines = input.split(/\r?\n/);
			let base64Lines: string[] | undefined;
			for (let beginOffset = 0; beginOffset < inputLines.length; beginOffset++) {
				const line = inputLines[beginOffset]?.trim();
				if (line?.startsWith('-----BEGIN ')) {
					let endIndex = -1;
					const matchingEndLine = line.replace('BEGIN', 'END');
					for (let endOffset = beginOffset + 1; endOffset < inputLines.length; endOffset++) {
						const checkEndLine = inputLines[endOffset]?.trim();
						if (checkEndLine === matchingEndLine) {
							endIndex = endOffset;
							break;
						}
					}
					if (endIndex === -1) {
						throw(new Error('Invalid PEM format: missing END line'));
					}

					base64Lines = inputLines.slice(beginOffset + 1, endIndex);
					break;
				}
			}
			if (base64Lines === undefined) {
				base64Lines = inputLines;
			}

			base64Lines = base64Lines.map(function(line) {
				return(line.trim());
			}).filter(function(line) {
				return(line.length > 0);
			});

			const base64Content = base64Lines.join('');
			containerBuffer = Buffer.from(base64Content, 'base64');
		} else if (Buffer.isBuffer(input)) {
			containerBuffer = input;
		} else {
			containerBuffer = arrayBufferToBuffer(input);
		}

		let principals = options?.principals;
		if (KeetaNetAccount.isInstance(principals)) {
			principals = [principals];
		} else if (principals instanceof Set) {
			principals = Array.from(principals);
		} else if (principals === undefined) {
			principals = null;
		}

		this.container = EncryptedContainer.fromEncodedBuffer(containerBuffer, principals);
	}

	/**
	 * Create a SharableCertificateAttributes from a Certificate
	 * and a list of attribute names to include -- if no list is
	 * provided, all attributes are included.
	 */
	static async fromCertificate(certificate: Certificate, intermediates?: Set<BaseCertificate>, attributeNames?: CertificateAttributeNames[]): Promise<SharableCertificateAttributes>;
	/** @deprecated Use the overload with three parameters instead */
	static async fromCertificate(certificate: Certificate, attributeNames?: CertificateAttributeNames[]): Promise<SharableCertificateAttributes>;
	static async fromCertificate(certificate: Certificate, intermediatesOrAttributeNames?: Set<BaseCertificate> | CertificateAttributeNames[], definitelyAttributeNames?: CertificateAttributeNames[]): Promise<SharableCertificateAttributes> {
		let intermediates: Set<BaseCertificate> | undefined = undefined;
		let attributeNames: CertificateAttributeNames[] | undefined = undefined;

		if (definitelyAttributeNames === undefined) {
			if (intermediatesOrAttributeNames !== undefined) {
				if (Array.isArray(intermediatesOrAttributeNames)) {
					attributeNames = intermediatesOrAttributeNames;
				} else {
					intermediates = intermediatesOrAttributeNames;
				}
			}
		} else {
			if (intermediatesOrAttributeNames !== undefined) {
				if (Array.isArray(intermediatesOrAttributeNames)) {
					throw(new TypeError('Expected Set<BaseCertificate> for intermediates'));
				}
				intermediates = intermediatesOrAttributeNames;
			}
			attributeNames = definitelyAttributeNames;
		}

		if (attributeNames === undefined) {
			/*
			 * We know the keys are whatever the Certificate says they are, so
			 * we can cast here safely
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			attributeNames = Object.keys(certificate.attributes) as (keyof typeof certificate.attributes)[];
		}

		const attributes: SharableCertificateAttributesContentsSchema['attributes'] = {};
		for (const name of attributeNames) {
			const attr = certificate.attributes[name];
			/**
			 * Skip missing attributes
			 */
			if (!attr) {
				continue;
			}

			const references: { [id: string]: string } = {};
			const walkResultAndReplaceReferences = async function(obj: unknown): Promise<unknown> {
				return(await walkObject(obj, async function(key, value, parent) {
					if (key === '$blob') {
						try {
							if (typeof parent !== 'object' || parent === null) {
								throw(new Error('$blob->parent is not an object'));
							}
							if (!('digest' in parent) || typeof parent.digest !== 'object' || parent.digest === null) {
								throw(new Error('$blob->parent->digest is not an object'));
							}
							if (!('digest' in parent.digest)) {
								throw(new Error('$blob->parent->digest->digest is missing'));
							}

							const digest = parent.digest.digest;
							if (!Buffer.isBuffer(digest)) {
								throw(new TypeError('$blob digest is not a Buffer'));
							}
							if (typeof value !== 'function') {
								throw(new TypeError('$blob value is not a function'));
							}

							/*
							 * We already validated that this is a function, so try to call
							 * it -- if it fails the catch block will handle it (by
							 * replacing this key with undefined)
							 */
							// eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-assignment
							const reference = await value([certificate.subjectPublicKey]);
							/* Verify that the reference is a Blob */
							if (!isBlob(reference)) {
								throw(new Error('$blob reference did not return a Blob'));
							}

							const referenceData = Buffer.from(await reference.arrayBuffer());
							const referenceID = digest.toString('hex').toUpperCase();
							references[referenceID] = referenceData.toString('base64');

							return(async function() {
								return(reference);
							});
						} catch {
							/* Ignore errors */
							return(undefined);
						}
					} else {
						return(value);
					}
				}));
			}

			/*
			 * Decode the attribute value to extract $blob references.
			 * Skip for entityType which has schema compatibility issues
			 * with old certificates and has no external references anyway.
			 */
			if (name !== 'entityType') {
				const attrValue = await certificate.getAttributeValue(name);
				await walkResultAndReplaceReferences(attrValue);
			}

			if (attr.sensitive) {
				attributes[name] = {
					sensitive: true,
					value: await attr.value.getProof(),
					references: references
				};
			} else {
				attributes[name] = {
					sensitive: false,
					value: arrayBufferToBuffer(attr.value).toString('base64'),
					references: references
				};
			}
		}


		let intermediatesJSON;
		intermediates ??= new Set();
		if (intermediates.size === 0) {
			intermediatesJSON = undefined;
		} else {
			intermediatesJSON = Array.from(intermediates).map(function(intermediateCertificate) {
				return(intermediateCertificate.toPEM());
			});
		}

		const contentsString = JSON.stringify({
			certificate: certificate.toPEM(),
			intermediates: intermediatesJSON,
			attributes: attributes
		} satisfies SharableCertificateAttributesContentsSchema);

		const temporaryUser = KeetaNetAccount.fromSeed(KeetaNetAccount.generateRandomSeed(), 0);
		const contentsBuffer = Buffer.from(contentsString, 'utf-8');
		const container = EncryptedContainer.fromPlaintext(bufferToArrayBuffer(contentsBuffer), [temporaryUser], true);
		const containerBuffer = await container.getEncodedBuffer();

		const retval = new SharableCertificateAttributes(containerBuffer, {
			principals: temporaryUser
		});
		await retval.revokeAccess(temporaryUser);
		return(retval);
	}

	async grantAccess(principal: KeetaNetAccount): Promise<this> {
		await this.container.grantAccess(principal);
		return(this);
	}

	async revokeAccess(principal: KeetaNetAccount): Promise<this> {
		await this.container.revokeAccess(principal);
		return(this);
	}

	get principals(): KeetaNetAccount[] {
		return(this.container.principals);
	}

	async #populate(): Promise<void> {
		if (this.populatedFromInit) {
			return;
		}
		this.populatedFromInit = true;

		const contentsBuffer = await this.container.getPlaintext();

		/*
		 * Previously the content was Zlib compressed, but this was
		 * redundant because the Encrypted Container already Zlib
		 * compresses the contents, so handle both cases (compressed
		 * and JSON) here
		 */
		let contentsBufferDecompressed: ArrayBuffer = contentsBuffer;
		const contentsBufferUint8 = new Uint8Array(contentsBuffer);
		const isCompressed = contentsBufferUint8[0] === 0x78;
		if (isCompressed) {
			contentsBufferDecompressed = await KeetaNetClient.lib.Utils.Buffer.ZlibInflateAsync(contentsBuffer);
		}
		const contentsString = Buffer.from(contentsBufferDecompressed).toString('utf-8');
		const contentsJSON: unknown = JSON.parse(contentsString);
		const contents = assertSharableCertificateAttributesContentsSchema(contentsJSON);

		this.#intermediates = new Set<BaseCertificate>();
		for (const intermediatePEM of contents.intermediates ?? []) {
			const intermediateCert = new BaseCertificate(intermediatePEM);
			this.#intermediates.add(intermediateCert);
		}

		this.#certificate = new Certificate(contents.certificate);
		const attributePromises = Object.entries(contents.attributes).map(async ([name, attr]): Promise<[string, { sensitive: boolean; value: ArrayBuffer; references?: { [id: string]: string; } | undefined; }]> => {
			/*
			 * Get the corresponding attribute from the certificate
			 *
			 * We actually do not care if `name` is a known attribute
			 * because we are not decoding it here, we are just
			 * verifying it matches the certificate
			 */
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const certAttribute = this.#certificate?.attributes[name as CertificateAttributeNames];

			if (!certAttribute) {
				throw(new Error(`Attribute ${name} not found in certificate`));
			}

			if (certAttribute.sensitive !== attr.sensitive) {
				throw(new Error(`Attribute ${name} sensitivity mismatch with certificate`));
			}

			if (!attr.sensitive) {
				if (certAttribute.sensitive) {
					throw(new Error(`Attribute ${name} sensitivity mismatch with certificate`));
				}

				const certValue = certAttribute.value;
				const sharedValue = bufferToArrayBuffer(Buffer.from(attr.value, 'base64'));
				if (sharedValue.byteLength !== certValue.byteLength || !Buffer.from(sharedValue).equals(Buffer.from(certValue))) {
					throw(new Error(`Attribute ${name} value mismatch with certificate`));
				}

				return([name, {
					sensitive: false,
					value: sharedValue,
					references: attr.references
				}]);
			}

			if (!certAttribute.sensitive) {
				throw(new Error(`Attribute ${name} sensitivity mismatch with certificate`));
			}

			if (!(await certAttribute.value.validateProof(attr.value))) {
				throw(new Error(`Attribute ${name} proof validation failed`));
			}

			const attrValue = bufferToArrayBuffer(Buffer.from(attr.value.value, 'base64'));

			return([name, {
				sensitive: true,
				value: attrValue,
				references: attr.references
			}]);
		});
		const resolvedAttributes = await Promise.all(attributePromises);
		this.#attributes = Object.fromEntries(resolvedAttributes);
	}

	async getCertificate(): Promise<Certificate> {
		await this.#populate();
		if (!this.#certificate) {
			throw(new Error('internal error: certificate not populated'));
		}
		return(this.#certificate);
	}

	/**
	 * Get the intermediate certificates included in this sharable
	 * certificate container
	 *
	 * @return A set of BaseCertificate objects representing the
	 *         intermediate certificates attached to this container
	 */
	async getIntermediates(): Promise<Set<BaseCertificate>> {
		await this.#populate();
		if (this.#intermediates && this.#intermediates.size > 0) {
			return(new Set(this.#intermediates));
		}
		return(new Set());
	}

	async getAttributeBuffer(name: string): Promise<ArrayBuffer | undefined> {
		await this.#populate();
		const attr = this.#attributes[name];
		return(attr?.value);
	}

	async getAttribute<NAME extends CertificateAttributeNames>(name: NAME): Promise<CertificateAttributeValue<NAME> | undefined> {
		const buffer = await this.getAttributeBuffer(name);
		if (buffer === undefined) {
			return(undefined);
		}

		const retvalWithReferences = await decodeAttribute(name, buffer, this.principals);

		/*
		 * For all remote references, replace them with their referenced values
		 * which we encoded into "references"
		 */
		const retval = await walkObject(retvalWithReferences, async (key, value, parent) => {
			if (key === '$blob') {
				if (typeof parent !== 'object' || parent === null) {
					throw(new Error('$blob->parent is not an object'));
				}
				if (!('digest' in parent) || typeof parent.digest !== 'object' || parent.digest === null) {
					throw(new Error('$blob->parent->digest is not an object'));
				}
				const digestInfo = parent.digest;
				if (!('digest' in digestInfo)) {
					throw(new Error('$blob->parent->digest->digest is missing'));
				}
				if (!Buffer.isBuffer(digestInfo.digest)) {
					throw(new TypeError('$blob digest is not a Buffer'));
				}

				if (!('external' in parent) || typeof parent.external !== 'object' || parent.external === null) {
					throw(new Error('$blob->parent->external is not an object'));
				}
				if (!('contentType' in parent.external) || typeof parent.external.contentType !== 'string') {
					throw(new Error('$blob->parent->external->contentType is not a string'));
				}

				const referenceID = digestInfo.digest.toString('hex').toUpperCase();
				const referenceValue = this.#attributes[name]?.references?.[referenceID];
				const contentType = parent.external.contentType;
				return(async function() {
					if (!referenceValue) {
						throw(new Error(`Missing reference value for ID ${referenceID}`));
					}
					const referenceData = Buffer.from(referenceValue, 'base64');
					const referenceDataAB = bufferToArrayBuffer(referenceData);

					/* Verify the hash matches what was certified */
					const checkHash = await checkHashWithOID(referenceData, parent.digest);
					if (checkHash !== true) {
						throw(checkHash);
					}

					return(new Blob([referenceDataAB], { type: contentType }));
				});
			}

			return(value);
		});

		/*
		 * We didn't change the type, so we can safely cast here
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(retval as CertificateAttributeValue<NAME>);
	}

	async getAttributeNames(includeUnknown: true): Promise<string[]>;
	async getAttributeNames(includeUnknown?: false): Promise<CertificateAttributeNames[]>;
	async getAttributeNames(includeUnknown?: boolean): Promise<string[]> {
		await this.#populate();
		const names = Object.keys(this.#attributes);

		if (includeUnknown) {
			return(names);
		}

		const knownNames = names.filter(function(name): name is CertificateAttributeNames {
			return(name in CertificateAttributeOIDDB);
		});

		return(knownNames);
	}

	export(options?: Omit<SharableCertificateAttributesExportOptions, 'format'> & { format?: never; }): Promise<ArrayBuffer>;
	export(options: (Omit<SharableCertificateAttributesExportOptions, 'format'> & { format: 'arraybuffer' })): Promise<ArrayBuffer>;
	export(options: Omit<SharableCertificateAttributesExportOptions, 'format'> & { format: 'string' }): Promise<string>;
	export(options?: SharableCertificateAttributesExportOptions): Promise<ArrayBuffer | string>;
	async export(options?: SharableCertificateAttributesExportOptions): Promise<ArrayBuffer | string> {
		options = {
			format: 'arraybuffer',
			...options
		};

		let principals: KeetaNetAccount[];
		try {
			principals = this.container.principals;
		} catch {
			principals = [];
		}
		if (principals.length === 0) {
			throw(new Error('This container has no authorized users (principals); cannot export'));
		}

		const retvalBuffer = await this.container.getEncodedBuffer();
		if (options.format === 'string') {
			const retvalBase64 = Buffer.from(retvalBuffer).toString('base64');
			const retvalLines = ['-----BEGIN KYC CERTIFICATE PROOF-----'];
			retvalLines.push(...retvalBase64.match(/.{1,64}/g) ?? []);
			retvalLines.push('-----END KYC CERTIFICATE PROOF-----');
			return(retvalLines.join('\n'));
		} else if (options.format === 'arraybuffer') {
			return(retvalBuffer);
		} else {
			throw(new Error(`Unsupported export format: ${String(options.format)}`));
		}
	}
}

// @ts-ignore
Certificate.SharableAttributes = SharableCertificateAttributes;

/** @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute,
	ValidateASN1: ASN1.ValidateASN1,
	BufferStorageASN1: ASN1.BufferStorageASN1,
	JStoASN1: ASN1.JStoASN1,
	normalizeDecodedASN1,
	decodeAttribute,
	decodeEntityTypeFallback,
	unwrapSingleLayer,
	unwrapFieldSchema,
	unwrapContextTagsFromSchema,
	CertificateAttributeSchema
};
