import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as oids from '../services/kyc/oids.generated.js';
import * as ASN1 from './utils/asn1.js';
import { ASN1toJS } from './utils/asn1.js';
import type { ASN1AnyJS, ASN1ContextTag } from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';
import type { SensitiveAttributeType, CertificateAttributeValue } from '../services/kyc/iso20022.generated.js';
import { CertificateAttributeOIDDB, CertificateAttributeSchema, SENSITIVE_CERTIFICATE_ATTRIBUTES, CertificateAttributeFieldNames } from '../services/kyc/iso20022.generated.js';
import { hasIndexSignature, isErrorLike, hasValueProp, isContextTagged } from './utils/guards.js';
import { getOID, lookupByOID } from './utils/oid.js';
import { convertToJSON as convertToJSONUtil, safeJSONStringify } from './utils/json.js';

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

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

function encodeAttribute(
	name: CertificateAttributeNames,
	value: unknown
): ArrayBuffer {
	const schema = CertificateAttributeSchema[name];
	const fieldNames = CertificateAttributeFieldNames[name];

	// Date type
	if (schema === ASN1.ValidateASN1.IsDate) {
		if (!(value instanceof Date)) {
			throw(new Error('Expected Date value'));
		}
		const asn1 = ASN1.JStoASN1(value);
		const der = asn1.toBER(false);
		return(der);
	}

	const MAX_ASN1_VALUE_DEPTH = 8; // Prevent excessive nesting
	const toASN1Value = (v: unknown, depth = 0): ASN1AnyJS => {
		// Only allow primitives and raw binary that ASN1.JStoASN1 understands.
		if (v instanceof Date) { return(v); }
		if (Buffer.isBuffer(v)) { return(v); }
		if (v instanceof ArrayBuffer) { return(arrayBufferToBuffer(v)); }
		if (typeof v === 'string') { return({ type: 'string', kind: 'utf8', value: v }); }
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			return({ type: 'string', kind: 'utf8', value: String(v) });
		}

		if (Array.isArray(v)) {
			if (depth >= MAX_ASN1_VALUE_DEPTH) {
				// Depth exceeded: serialize to a stable string to avoid deep structures
				return({ type: 'string', kind: 'utf8', value: safeJSONStringify(v) });
			}

			return(v.map(item => toASN1Value(item, depth + 1)));
		}

		// XXX:TODO What should we do?
		// For nested objects in complex attributes, delegate to JSON to avoid emitting
		// arbitrary ASN.1 structures.
		return({ type: 'string', kind: 'utf8', value: safeJSONStringify(v) });
	};

	// Complex object type
	if (fieldNames && hasIndexSignature(value) && !Array.isArray(value)) {
		const mappedFields = fieldNames
			.map((fieldName, idx) => {
				const fieldValue = value[fieldName];
				if (fieldValue === undefined) {return(undefined);}
				const tag: ASN1ContextTag = {
					type: 'context',
					kind: 'explicit',
					value: idx,
					contains: toASN1Value(fieldValue)
				};
				return(tag);
			})
			.filter((v): v is NonNullable<typeof v> => v !== undefined);

		const asn1 = ASN1.JStoASN1(mappedFields);
		const der = asn1.toBER(false);
		return(der);
	}

	throw(new Error(`Unsupported attribute value for encoding: ${String(value)}`));
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
	const schema = CertificateAttributeSchema[name];
	// XXX:TODO Fix depth issue
	// @ts-ignore
	const decodedUnknown: unknown = new ASN1.BufferStorageASN1(value, schema).getASN1();
	const fieldNames = CertificateAttributeFieldNames[name];

	let candidate: unknown;
	if (fieldNames && Array.isArray(decodedUnknown)) {
		const arr: unknown[] = decodedUnknown;
		const result: { [key: string]: unknown } = {};
		for (let i = 0; i < fieldNames.length; i++) {
			const fieldName = fieldNames[i];
			if (!fieldName) {continue;}

			const fieldValue: unknown = arr[i];
			if (fieldValue === undefined) {continue;}
			if (isErrorLike(fieldValue)) {
				throw(new Error(`Field ${fieldName} contains an error: ${fieldValue.message}`));
			}

			if (isContextTagged(fieldValue)) {
				// unwrap context tag; prefer nested .value if present
				result[fieldName] = hasValueProp(fieldValue.contains) ? fieldValue.contains.value : fieldValue.contains;
			} else if (hasValueProp(fieldValue)) {
				result[fieldName] = fieldValue.value;
			} else {
				result[fieldName] = fieldValue;
			}
		}
		candidate = result;
	} else if (hasValueProp(decodedUnknown)) {
		candidate = decodedUnknown.value;
	} else {
		candidate = decodedUnknown;
	}

	return(asAttributeValue(name, candidate));
}

class SensitiveAttributeBuilder {
	readonly #account: KeetaNetAccount;
	#value: Buffer | undefined;

	constructor(account: KeetaNetAccount) {
		this.#account = account;
	}

	set(value: SensitiveAttributeType | Buffer | ArrayBuffer, attributeName?: CertificateAttributeNames) {
		this.#value = encodeForSensitive(attributeName, value);
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

class SensitiveAttribute {
	readonly #account: KeetaNetAccount;
	readonly #info: ReturnType<SensitiveAttribute['decode']>;

	constructor(account: KeetaNetAccount, data: Buffer | ArrayBuffer) {
		this.#account = account;
		this.#info = this.decode(data);
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
			throw(new Error(`SensitiveAttribute.decode: unexpected DER shape ${safeJSONStringify(js)}`));
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

	async getValue<NAME extends CertificateAttributeNames>(attributeName: NAME): Promise<CertificateAttributeValue<NAME>> {
		const value = await this.get();
		return(await decodeAttribute(attributeName, value));
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
		const mustBeSensitive = (SENSITIVE_CERTIFICATE_ATTRIBUTES satisfies readonly string[]).includes(name);
		if (mustBeSensitive && !sensitive) {
			throw(new Error(`Attribute '${name}' must be marked sensitive`));
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
				throw(new Error('Expected Date value'));
			}

			encoded = encodeAttribute(name, value);
		} else if (schemaValidator === ASN1.ValidateASN1.IsString && typeof value === 'string') {
			encoded = encodeAttribute(name, value);
		} else {
			throw(new Error('Unsupported non-sensitive value type'));
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
				const sensitiveAttribute = new SensitiveAttributeBuilder(subject);
				sensitiveAttribute.set(attribute.value, name);
				value = arrayBufferToBuffer(await sensitiveAttribute.build());
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
	static Builder: typeof CertificateBuilder;

	/**
     * User KYC Attributes
     */
	readonly attributes: {
		[name in CertificateAttributeNames]?: {
			sensitive: true;
			value: SensitiveAttribute;
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
		this.attributes[name] = { sensitive: false, value } satisfies typeof this.attributes[NAME];
	}

	getSensitiveAttribute<NAME extends CertificateAttributeNames>(
		attributeName: NAME
	): SensitiveAttribute | undefined {
		const attr = this.attributes[attributeName]?.value;
		return(attr instanceof SensitiveAttribute
			? (attr)
			: undefined);
	}

	async getValue<NAME extends CertificateAttributeNames>(attributeName: NAME): Promise<CertificateAttributeValue<NAME>> {
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

	private setSensitiveAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): void {
		this.attributes[name] = {
			sensitive: true,
			value: new SensitiveAttribute(this.subjectKey, value)
		} satisfies typeof this.attributes[NAME];
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

// Bind the nested Builder class for ergonomic API parity with existing tests
Certificate.Builder = CertificateBuilder;

/** @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
