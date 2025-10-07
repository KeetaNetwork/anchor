import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as asn1js from 'asn1js';
import * as oids from '../generated/oids.js';
import * as ASN1 from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';
import { CertificateAttributeOIDDB, CertificateAttributeSchema, SensitiveAttributeType, CertificateAttributeValue, SENSITIVE_CERTIFICATE_ATTRIBUTES, CertificateAttributeFieldNames } from '../generated/iso20022.js';
import { ASN1AnyJS } from './utils/asn1.js';

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/* -----MOVE TO NODE AND ASN1NAPIRS----- */
function getOID(name: string, oidDB: { [name: string]: string }) {
	if (name in oidDB) {
		// XXX:TODO Fix type assertion
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const oid = oidDB[name as keyof typeof oidDB];
		if (oid === undefined) {
			throw (new Error('internal error: OID was undefined'));
		}

		return (oid);
	} else {
		throw (new Error('Unknown algorithm'));
	}
}

function lookupByOID(oid: string, oidDB: { [name: string]: string }) {
	for (const [key, value] of Object.entries(oidDB)) {
		if (key === oid) {
			return (key);
		}

		if (value === oid) {
			return (key);
		}
	}

	throw (new Error(`Unknown OID: ${oid}`));
}
/* -----END MOVE TO NODE AND ASN1NAPIRS----- */

function toJSON(data: unknown): unknown {
	const retval: unknown = JSON.parse(JSON.stringify(data, function (key, convertedValue: unknown) {
		// XXX:TODO Fix no-unsafe-member-access
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		const value: unknown = this[key];

		if (typeof value === 'object' && value !== null) {
			if ('publicKeyString' in value && typeof value.publicKeyString === 'object' && value.publicKeyString !== null) {
				if ('get' in value.publicKeyString && typeof value.publicKeyString.get === 'function') {
					/*
					 * If the value has a publicKeyString property that is an
					 * object with a get method, we assume it is a KeetaNetAccount
					 * or similar object and we return the public key string
					 */
					// XXX:TODO Fix no-unsafe-call
					// eslint-disable-next-line @typescript-eslint/no-unsafe-call
					const publicKeyString: unknown = value.publicKeyString.get();
					if (typeof publicKeyString === 'string') {
						return (publicKeyString);
					}
				}
			}
		}

		if (Buffer.isBuffer(value)) {
			return (value.toString('base64'));
		}
		if (typeof value === 'bigint') {
			return (value.toString());
		}

		return (convertedValue);
	}));

	return (retval);
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
 * The Sensitive Attribute Schema
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

class SensitiveAttributeBuilder {
	readonly #account: KeetaNetAccount;
	#value: Buffer | undefined;

	constructor(account: KeetaNetAccount, value?: SensitiveAttributeType | Buffer | ArrayBuffer) {
		this.#account = account;

		if (value) {
			this.set(value);
		}
	}

	set(value: SensitiveAttributeType | Buffer | ArrayBuffer) {
		if (Buffer.isBuffer(value)) {
			this.#value = value;
		} else if (value instanceof ArrayBuffer) {
			this.#value = arrayBufferToBuffer(value);
		} else if (typeof value === 'string') {
			this.#value = Buffer.from(value, 'utf-8');
		} else if (value instanceof Date) {
			this.#value = Buffer.from(value.toISOString(), 'utf-8');
		} else if (typeof value === 'object' && value !== null) {
			this.#value = Buffer.from(JSON.stringify(value), 'utf-8');
		} else {
			this.#value = Buffer.from(String(value), 'utf-8');
		}

		return (this);
	}

	async build() {
		if (this.#value === undefined) {
			throw (new Error('Value not set'));
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
				const authTag = (cipherObject as any).getAuthTag();
				retval = Buffer.concat([retval, authTag]);
			}

			return (retval);
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

		const retval = encodedAttributeObject.toBER();
		return (retval);
	}
}

class SensitiveAttribute<SCHEMA extends ASN1.Schema | undefined = undefined> {
	readonly #account: KeetaNetAccount;
	readonly #info: ReturnType<SensitiveAttribute['decode']>;
	readonly #schema?: SCHEMA | undefined;

	constructor(account: KeetaNetAccount, data: Buffer | ArrayBuffer, schema?: SCHEMA) {
		this.#account = account;
		this.#info = this.decode(data);
		this.#schema = schema;
	}

	private decode(data: Buffer | ArrayBuffer) {
		if (Buffer.isBuffer(data)) {
			data = bufferToArrayBuffer(data);
		}

		const dataObject = new ASN1.BufferStorageASN1(data, SensitiveAttributeSchemaInternal);
		const decodedAttribute = dataObject.getASN1();

		const decodedVersion = decodedAttribute[0] + 1n;
		if (decodedVersion !== 1n) {
			throw (new Error(`Unsupported Sensitive Attribute version (${decodedVersion})`));
		}

		return ({
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
			const authTag = value.slice(-16);
			const ciphertext = value.slice(0, -16);
			(cipher as any).setAuthTag(authTag);
			const decrypted = cipher.update(ciphertext);
			cipher.final(); // Verify auth tag
			return decrypted;
		}

		// For other algorithms (like CBC), just decrypt normally
		const decryptedValue = cipher.update(value);
		cipher.final();
		return (decryptedValue);
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

		return (bufferToArrayBuffer(decryptedValue));
	}

	async getValue<T = any>(attributeName?: CertificateAttributeNames): Promise<T> {
		if (this.#schema === undefined) {
			throw (new Error('No schema defined for this sensitive attribute'));
		}

		const value = await this.get();

		if (!attributeName) {
			throw (new Error('Attribute name required for decoding'));
		}

		const schema = CertificateAttributeSchema[attributeName];

		// For complex types (arrays/sequences), decode DER
		if (Array.isArray(schema)) {
			// XXX:TODO Fix depth issue
			// @ts-ignore	
			return await decodeAttribute(attributeName, value) as T;
		}

		// For simple types, decode directly based on schema type
		if (schema === ASN1.ValidateASN1.IsString) {
			return Buffer.from(value).toString('utf-8') as T;
		}

		if (schema === ASN1.ValidateASN1.IsDate) {
			const dateStr = Buffer.from(value).toString('utf-8');
			return new Date(dateStr) as T;
		}

		// Fallback to decodeAttribute for other types
		return decodeAttribute(attributeName, value) as T;
	}

	/**
	 * Generate a proof that a sensitive attribute is a given value,
	 * which can be validated by a third party using the certificate
	 * and the `validateProof` method
	 */
	async prove(): Promise<{ value: string; hash: { salt: string } }> {
		const value = await this.get();
		const salt = await this.#decryptValue(arrayBufferLikeToBuffer(this.#info.hashedValue.encryptedSalt));

		return ({
			value: Buffer.from(value).toString('base64'),
			hash: {
				salt: salt.toString('base64')
			}
		});
	}

	/**
	 * Validate the proof that a sensitive attribute is a given value
	 */
	async validateProof(proof: Awaited<ReturnType<this['prove']>>): Promise<boolean> {
		const plaintextValue = Buffer.from(proof.value, 'base64');
		const proofSaltBuffer = Buffer.from(proof.hash.salt, 'base64');

		const publicKeyBuffer = Buffer.from(this.#account.publicKey.get());
		const encryptedValue = this.#info.encryptedValue;

		const hashInput = Buffer.concat([proofSaltBuffer, publicKeyBuffer, encryptedValue, plaintextValue]);
		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(hashInput);
		const hashedAndSaltedValueBuffer = Buffer.from(hashedAndSaltedValue);

		return (this.#info.hashedValue.value.equals(hashedAndSaltedValueBuffer));
	}

	toJSON(): unknown/* XXX:TODO */ {
		return (toJSON(this.#info));
	}
}

/**
 * Type for certificate attribute names (derived from generated OID database)
 */
type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

type BaseCertificateBuilderParams = NonNullable<ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>[0]>;
type CertificateBuilderParams = Required<Pick<BaseCertificateBuilderParams, 'issuer' | 'validFrom' | 'validTo' | 'serial' | 'hashLib' | 'issuerDN' | 'subjectDN' | 'isCA'> & {
	/**
	 * The key of the subject -- used for Sensitive Attributes as well
	 * as the certificate Subject
	 */
	subject: BaseCertificateBuilderParams['subjectPublicKey'];
}>;

function assertCertificateAttributeNames(name: string): asserts name is CertificateAttributeNames {
	if (!(name in CertificateAttributeOIDDB)) {
		throw (new Error(`Unknown attribute name: ${name}`));
	}
}

function asCertificateAttributeNames(name: string): CertificateAttributeNames {
	assertCertificateAttributeNames(name);
	return (name);
}

function encodeAttribute(name: CertificateAttributeNames, value: ArrayBuffer | { [key: string]: unknown }): ArrayBuffer {
	if (value instanceof ArrayBuffer) {
		return value;
	}

	const schema = CertificateAttributeSchema[name];

	if (!Array.isArray(schema)) {
		// Primitive types
		let primitiveValue: ASN1.ASN1AnyJS;

		if (schema === ASN1.ValidateASN1.IsString && typeof value === 'string') {
			primitiveValue = value;
		} else if (schema === ASN1.ValidateASN1.IsDate && value instanceof Date) {
			primitiveValue = value;
		} else if (typeof value === 'string') {
			// Fallback: treat as string
			primitiveValue = value;
		} else if (value instanceof Date) {
			// Fallback: treat as date
			primitiveValue = value;
		} else {
			throw new Error(`Unsupported primitive value type for attribute '${name}'`);
		}

		const asn1Object = ASN1.JStoASN1(primitiveValue);
		return asn1Object.toBER();
	}

	// Complex type: map object to array using field names
	const fieldNames = CertificateAttributeFieldNames[name];
	if (!fieldNames) {
		throw new Error(`No field name mapping for attribute: ${name}`);
	}

	// Build array matching schema order, wrapping values in context tags
	const valueArray = fieldNames.map((field, index) => {
		const val = (value as Record<string, unknown>)[field];
		const schemaEntry = schema[index];

		// Extract the inner schema if optional
		let innerSchema = schemaEntry;
		if (typeof schemaEntry === 'object' && schemaEntry !== null && 'optional' in schemaEntry) {
			innerSchema = schemaEntry.optional;
		}

		// If the schema has a context tag, wrap the value
		if (typeof innerSchema === 'object' && innerSchema !== null &&
			'type' in innerSchema && innerSchema.type === 'context') {

			if (val === undefined) {
				// Optional field not provided - return undefined (will be omitted)
				return undefined;
			}

			// Wrap in context tag object
			return {
				type: 'context' as const,
				kind: innerSchema.kind,
				value: innerSchema.value,
				contains: val
			};
		}

		return val;
	}).filter((v): v is Exclude<ASN1.ASN1AnyJS, undefined> => v !== undefined);

	const asn1Object = ASN1.JStoASN1(valueArray);
	return asn1Object.toBER();
}

// XXX:TODO Fix depth issue
// @ts-ignore
async function decodeAttribute<NAME extends CertificateAttributeNames>(
	name: NAME,
	value: ArrayBuffer
): Promise<ASN1.SchemaMap<typeof CertificateAttributeSchema[NAME]> | ArrayBuffer | string | Date> {
	const schema = CertificateAttributeSchema[name];

	if (schema === ASN1.ValidateASN1.IsString) {
		return new TextDecoder().decode(value);
	}

	if (schema === ASN1.ValidateASN1.IsDate) {
		return new Date(new TextDecoder().decode(value));
	}

	// Replace lines 522-603 with this cleaned-up version:

	if (Array.isArray(schema)) {
		let decoded;
		try {
			decoded = new ASN1.BufferStorageASN1(value, schema).getASN1();
		} catch (error) {
			// Manual decode
			const bytes = new Uint8Array(value);
			let pos = 2; // Skip SEQUENCE tag and length

			const result: any[] = [];
			const fieldNames = (CertificateAttributeFieldNames as any)[name] || [];

			while (pos < bytes.length) {
				const tag = bytes[pos++];
				if (!tag || tag < 0xa0) break; // Not a context tag

				const contextValue = tag - 0xa0;
				const fieldLen = bytes[pos++];

				// Skip inner tag and get inner length
				pos++; // Skip inner tag 
				const innerLen = bytes[pos++];
				if (!innerLen || innerLen > (bytes.length - pos)) break; // Invalid length

				const fieldValue = new TextDecoder().decode(bytes.slice(pos, pos + innerLen));
				pos += innerLen;

				// Store in sparse array by context tag value
				result[contextValue] = fieldValue;
			}

			// Convert sparse array to object with field names
			const decodedObj: Record<string, unknown> = {};
			for (let i = 0; i < result.length; i++) {
				if (result[i] !== undefined && fieldNames[i]) {
					decodedObj[fieldNames[i]] = result[i];
				}
			}

			return decodedObj as any;
		}

		// Successfully validated - map array back to object with field names
		const fieldNames = CertificateAttributeFieldNames[name];
		// XXX:TODO Fix depth issue
		// @ts-ignore
		if (fieldNames && Array.isArray(decoded)) {
			const result: Record<string, unknown> = {};

			for (let i = 0; i < decoded.length; i++) {
				const decodedValue = decoded[i];

				// If it's a context tag, extract the tag number and contained value
				if (typeof decodedValue === 'object' &&
					decodedValue !== null &&
					'type' in decodedValue &&
					decodedValue.type === 'context') {
					const contextTag = decodedValue as ASN1.ASN1ContextTag;
					const fieldIndex = contextTag.value;
					const fieldName = fieldNames[fieldIndex];
					if (fieldName) {
						result[fieldName] = contextTag.contains;
					}
				} else if (decodedValue !== undefined && decodedValue !== null) {
					// Non-context-tagged value (fallback for schemas without context tags)
					const fieldName = fieldNames[i];
					if (fieldName) {
						result[fieldName] = decodedValue;
					}
				}
			}

			return result as any;
		}

		return decoded;
	}

	return value;
}

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

export class CertificateBuilder extends KeetaNetClient.lib.Utils.Certificate.CertificateBuilder {
	readonly #attributes: {
		[name: string]: (
			{ sensitive: true; value: SensitiveAttributeType } |
			{ sensitive: false; value: ArrayBuffer }
		)
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
			delete (paramsCopy.subject);
		}
		const retval: Partial<BaseCertificateBuilderParams> = paramsCopy;
		if (subjectPublicKey) {
			retval.subjectPublicKey = subjectPublicKey;
		}
		return (retval);
	}

	constructor(params?: Partial<CertificateBuilderParams>) {
		super(CertificateBuilder.mapParams(params));
	}

	/**
	 * Set a KYC Attribute to a given value.
	 * The sensitive flag is required. If an attribute is expected to be
	 * sensitive (e.g., fullName), it must be marked as such.
	 */
	setAttribute<NAME extends CertificateAttributeNames>(name: NAME, sensitive: boolean, value: CertificateAttributeInput<NAME>): void {
		const mustBeSensitive = (SENSITIVE_CERTIFICATE_ATTRIBUTES as readonly string[]).includes(name);
		if (mustBeSensitive && !sensitive) {
			throw new Error(`Attribute '${name}' must be marked sensitive`);
		}

		if (sensitive) {
			this.#attributes[name] = { sensitive, value };
			return;
		}

		// Non-sensitive path: only primitive schema (string/date) allowed
		const schemaValidator = CertificateAttributeSchema[name];
		let encoded: ArrayBuffer;
		if (value instanceof ArrayBuffer) {
			encoded = value;
		} else if (schemaValidator === ASN1.ValidateASN1.IsDate) {
			if (!(value instanceof Date)) {
				throw new Error('Expected Date value');
			}
			// XXX:TODO Fix depth issue
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			encoded = encodeAttribute(name, value as any);
		} else if (schemaValidator === ASN1.ValidateASN1.IsString && typeof value === 'string') {
			// XXX:TODO Fix depth issue
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			encoded = encodeAttribute(name, value as any);
		} else {
			throw new Error('Unsupported non-sensitive value type');
		}

		this.#attributes[name] = { sensitive: false, value: encoded };
	}

	protected async addExtensions(...args: Parameters<InstanceType<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>['addExtensions']>): ReturnType<InstanceType<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>['addExtensions']> {
		const retval = await super.addExtensions(...args);

		const subject = args[0].subjectPublicKey;

		/* Encode the attributes */
		const certAttributes: CertificateKYCAttributeSchema = [];
		for (const [name, attribute] of Object.entries(this.#attributes)) {
			if (!(name in CertificateAttributeOIDDB)) {
				throw (new Error(`Unknown attribute: ${name}`));
			}

			/*
			 * Since we are iteratively building the certificate, we
			 * can assume that the attribute is always present in
			 * the object
			 */
			// XXX:TODO Fix type assertion
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const nameOID = CertificateAttributeOIDDB[name as keyof typeof CertificateAttributeOIDDB];

			let value: Buffer;
			if (attribute.sensitive) {
				// For complex types (objects), DER-encode before encrypting
				// For simple types (strings, dates), SensitiveAttributeBuilder handles them directly
				const schema = CertificateAttributeSchema[name as CertificateAttributeNames];
				let valueToEncrypt;
				if (Array.isArray(schema)) {
					// Complex type - encode to DER
					// XXX:TODO Fix depth issue
					// @ts-ignore
					valueToEncrypt = encodeAttribute(name as CertificateAttributeNames, attribute.value);
				} else {
					// Simple type - pass raw value
					valueToEncrypt = attribute.value;
				}
				const sensitiveAttribute = new SensitiveAttributeBuilder(subject, valueToEncrypt);
				value = arrayBufferToBuffer(await sensitiveAttribute.build());
			} else {
				if (typeof attribute.value === 'string') {
					value = Buffer.from(attribute.value, 'utf-8');
				} else {
					value = arrayBufferToBuffer(attribute.value as ArrayBuffer);
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
				KeetaNetClient.lib.Utils.Certificate.CertificateBuilder.extension(oids.keeta.KYC_ATTRIBUTES, certAttributes)
			);
		}

		return (retval);
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

		// XXX:TODO Fix use before define
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

		return (certificateObject);
	}
}

export class Certificate extends KeetaNetClient.lib.Utils.Certificate.Certificate {
	private readonly subjectKey: KeetaNetAccount;
	static readonly Builder: typeof CertificateBuilder = CertificateBuilder;

	/**
	 * User KYC Attributes
	 */
	readonly attributes: {
		[name in CertificateAttributeNames]?: {
			sensitive: true;
			value: SensitiveAttribute<typeof CertificateAttributeSchema[name]>;
		} | {
			sensitive: false;
			value: ReturnType<typeof decodeAttribute<name>> | ArrayBuffer;
		}
	} = {};

	constructor(input: ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.Certificate>[0], options?: ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.Certificate>[1] & { subjectKey?: KeetaNetAccount }) {
		super(input, options);

		this.subjectKey = options?.subjectKey ?? this.subjectPublicKey;

		super.finalizeConstruction();
	}

	protected finalizeConstruction(): void {
		/* Do nothing, we call the super method in the constructor */
	}

	private setPlainAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): void {
		this.attributes[name] = { sensitive: false, value: decodeAttribute(name, value) } as typeof this.attributes[NAME];
	}

	private setSensitiveAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): void {
		const schema = CertificateAttributeSchema[name];
		this.attributes[name] = {
			sensitive: true,
			value: new SensitiveAttribute(this.subjectKey, value, schema)
		} as typeof this.attributes[NAME];
	}

	protected processExtension(id: string, value: ArrayBuffer): boolean {
		if (super.processExtension(id, value)) {
			return (true);
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

			return (true);
		}

		return (false);
	}
}

/** @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
