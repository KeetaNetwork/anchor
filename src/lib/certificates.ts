import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as oids from '../services/kyc/oids.generated.js';
import * as ASN1 from './utils/asn1.js';
import { ASN1toJS, contextualizeStructSchema, encodeValueBySchema, normalizeDecodedASN1 } from './utils/asn1.js';
import type { Schema as ASN1Schema } from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';
import type { SensitiveAttributeType, CertificateAttributeValue } from '../services/kyc/iso20022.generated.js';
import { CertificateAttributeOIDDB, CertificateAttributeSchema, ReferenceSchema } from '../services/kyc/iso20022.generated.js';
import { getOID, lookupByOID } from './utils/oid.js';
import { convertToJSON as convertToJSONUtil } from './utils/json.js';
import { EncryptedContainer } from './encrypted-container.js';
import { assertSharableCertificateAttributesContentsSchema } from './certificates.generated.js';

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
const KeetaNetAccount: typeof KeetaNetClient.lib.Account = KeetaNetClient.lib.Account;

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

const DOCUMENT_SCHEMA_ATTRIBUTES: ReadonlySet<CertificateAttributeNames> = new Set([
	'documentDriversLicense',
	'documentIdCard',
	'documentResidenceDocument',
	'documentPassport',
	'documentPassportCard',
	'documentPermit',
	'documentVisa',
]);

function resolveSchema(name: CertificateAttributeNames, schema: ASN1Schema): ASN1Schema {
	if (DOCUMENT_SCHEMA_ATTRIBUTES.has(name)) {
		return(contextualizeStructSchema(ReferenceSchema));
	}
	return(contextualizeStructSchema(schema));
}

function encodeAttribute(name: CertificateAttributeNames, value: unknown): ArrayBuffer {
	const schema = resolveSchema(name, CertificateAttributeSchema[name]);
	const encodedJS = encodeValueBySchema(schema, value, { attributeName: name });
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

async function decodeAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): Promise<CertificateAttributeValue<NAME>> {
	const schema = resolveSchema(name, CertificateAttributeSchema[name]);
	// XXX:TODO Fix depth issue
	// @ts-ignore
	const decodedUnknown: unknown = new ASN1.BufferStorageASN1(value, schema).getASN1();
	const candidate = normalizeDecodedASN1(decodedUnknown);
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
			const js = ASN1toJS(data);
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

type BaseCertificateBuilderParams = NonNullable<ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>[0]>;
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

export class CertificateBuilder extends KeetaNetClient.lib.Utils.Certificate.CertificateBuilder {
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

	protected async addExtensions(...args: Parameters<InstanceType<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>['addExtensions']>): ReturnType<InstanceType<typeof KeetaNetClient.lib.Utils.Certificate.CertificateBuilder>['addExtensions']> {
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
				KeetaNetClient.lib.Utils.Certificate.CertificateBuilder.extension(oids.keeta.KYC_ATTRIBUTES, certAttributes)
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

export class Certificate extends KeetaNetClient.lib.Utils.Certificate.Certificate {
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

	constructor(input: ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.Certificate>[0], options?: ConstructorParameters<typeof KeetaNetClient.lib.Utils.Certificate.Certificate>[1] & { subjectKey?: KeetaNetAccount }) {
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
			return(await decodeAttribute(name, bufferInput));
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
			return(await decodeAttribute(attributeName, raw));
		}

		// Non-sensitive: ArrayBuffer or Buffer
		if (attr instanceof ArrayBuffer || Buffer.isBuffer(attr)) {
			return(await decodeAttribute(attributeName, attr));
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
	export type ExportOptions = { format?: 'string' | 'arraybuffer' };
	export type ImportOptions = { principals?: Set<KeetaNetAccount> | KeetaNetAccount[] | KeetaNetAccount | null };
	export type ContentsSchema = {
		certificate: string;
		attributes: {
			[name: string]: {
				sensitive: true;
				value: Awaited<ReturnType<SensitiveAttribute['getProof']>>;
			} | {
				sensitive: false;
				value: string;
			}
		};
	};
};
type SharableCertificateAttributesExportOptions = SharableCertificateAttributesTypes.ExportOptions;
type SharableCertificateAttributesImportOptions = SharableCertificateAttributesTypes.ImportOptions;
type SharableCertificateAttributesContentsSchema = SharableCertificateAttributesTypes.ContentsSchema;

export class SharableCertificateAttributes {
	#certificate?: Certificate;
	#attributes: {
		[name: string]: {
			sensitive: boolean;
			value: ArrayBuffer;
		}
	} = {};

	private container: EncryptedContainer;
	private populatedFromInit = false;

	static assertCertificateAttributeName: typeof assertCertificateAttributeNames = assertCertificateAttributeNames;

	constructor(input: ArrayBuffer | string, options?: SharableCertificateAttributesImportOptions) {
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
	static async fromCertificate(certificate: Certificate, attributeNames?: CertificateAttributeNames[]): Promise<SharableCertificateAttributes> {
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

			if (attr.sensitive) {
				attributes[name] = {
					sensitive: true,
					value: await attr.value.getProof()
				};
			} else {
				attributes[name] = {
					sensitive: false,
					value: arrayBufferToBuffer(attr.value).toString('base64')
				};
			}
		}

		const contentsString = JSON.stringify({
			certificate: certificate.toPEM(),
			attributes: attributes
		} satisfies SharableCertificateAttributesContentsSchema);

		const temporaryUser = KeetaNetAccount.fromSeed(KeetaNetAccount.generateRandomSeed(), 0);
		const contentsBuffer = Buffer.from(contentsString, 'utf-8');
		const contentsBufferCompressed = await KeetaNetClient.lib.Utils.Buffer.ZlibDeflateAsync(bufferToArrayBuffer(contentsBuffer));
		const container = EncryptedContainer.fromPlaintext(arrayBufferToBuffer(contentsBufferCompressed), [temporaryUser], true);
		const containerBuffer = await container.getEncodedBuffer();
		const retval = new SharableCertificateAttributes(bufferToArrayBuffer(containerBuffer), { principals: temporaryUser });
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
		const contentsBufferDecompressed = await KeetaNetClient.lib.Utils.Buffer.ZlibInflateAsync(bufferToArrayBuffer(contentsBuffer));
		const contentsString = Buffer.from(contentsBufferDecompressed).toString('utf-8');
		const contentsJSON: unknown = JSON.parse(contentsString);
		const contents = assertSharableCertificateAttributesContentsSchema(contentsJSON);

		this.#certificate = new Certificate(contents.certificate);
		const attributePromises = Object.entries(contents.attributes).map(async ([name, attr]): Promise<[string, { sensitive: boolean; value: ArrayBuffer; }]> => {
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
					value: sharedValue
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
				value: attrValue
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

		const retval = await decodeAttribute(name, buffer);

		/* XXX:TODO: Here is where we would look at a reference value
		 * (e.g., URL+hash) and fetch it, and verify it the hash matches
		 * the fetched value
		 *
		 * The schema for references is not yet defined, so this is
		 * left as a TODO for now.
		 *
		 * The return type would also need to be updated to reflect
		 * that we would map referenced types to something like
		 * { data: ArrayBuffer, contentType: string, source: <url>,
		 * hash: <hash> } (where source and hash should be named
		 * after whatever the actual schema is)
		 */

		return(retval);
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
			const retvalBase64 = retvalBuffer.toString('base64');
			const retvalLines = ['-----BEGIN KYC CERTIFICATE PROOF-----'];
			retvalLines.push(...retvalBase64.match(/.{1,64}/g) ?? []);
			retvalLines.push('-----END KYC CERTIFICATE PROOF-----');
			return(retvalLines.join('\n'));
		} else if (options.format === 'arraybuffer') {
			return(bufferToArrayBuffer(retvalBuffer));
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
	SensitiveAttribute
};
