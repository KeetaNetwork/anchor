import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import { AES_256_CBC, AES_256_GCM, SHA2_256, SHA3_256 } from '../generated/oids.js';
import * as ASN1 from './utils/asn1.js';
import { arrayBufferLikeToBuffer, arrayBufferToBuffer, Buffer, bufferToArrayBuffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';
import { CertificateAttributeOIDDB, CertificateAttributeSchema, SensitiveAttributeType, CertificateAttributeValue, SENSITIVE_CERTIFICATE_ATTRIBUTES } from '../generated/iso20022.js';

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
			throw(new Error('internal error: OID was undefined'));
		}

		return(oid);
	} else {
		throw(new Error('Unknown algorithm'));
	}
}

function lookupByOID(oid: string, oidDB: { [name: string]: string }) {
	for (const [key, value] of Object.entries(oidDB)) {
		if (key === oid) {
			return(key);
		}

		if (value === oid) {
			return(key);
		}
	}

	throw(new Error(`Unknown OID: ${oid}`));
}
/* -----END MOVE TO NODE AND ASN1NAPIRS----- */

function toJSON(data: unknown): unknown {
	const retval: unknown = JSON.parse(JSON.stringify(data, function(key, convertedValue: unknown) {
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
						return(publicKeyString);
					}
				}
			}
		}

		if (Buffer.isBuffer(value)) {
			return(value.toString('base64'));
		}
		if (typeof value === 'bigint') {
			return(value.toString());
		}

		return(convertedValue);
	}));

	return(retval);
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
	'aes-256-gcm': AES_256_GCM,
	'aes-256-cbc': AES_256_CBC,
	'sha2-256': SHA2_256,
	'sha3-256': SHA3_256
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

		const retval = encodedAttributeObject.toBER();
		return(retval);
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
		const decryptedValue = cipher.update(value);

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

	/**
	 * Get the value of the sensitive attribute as a string after being
	 * interpreted as UTF-8 ( @see SensitiveAttribute.get for more information)
	 */
	async getString(): Promise<string> {
		const value = await this.get();
		return(Buffer.from(value).toString('utf-8'));
	}

	async getValue(): Promise<ASN1.SchemaMap<NonNullable<SCHEMA>>> {
		if (this.#schema === undefined) {
			throw(new Error('No schema defined for this sensitive attribute'));
		}

		const value = await this.get();
		const decodedValue = decodeAttribute(this.#schema, value);

		return(decodedValue);
	}

	/**
	 * Generate a proof that a sensitive attribute is a given value,
	 * which can be validated by a third party using the certificate
	 * and the `validateProof` method
	 */
	async prove(): Promise<{ value: string; hash: { salt: string }}> {
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
	async validateProof(proof: Awaited<ReturnType<this['prove']>>): Promise<boolean> {
		const plaintextValue = Buffer.from(proof.value, 'base64');
		const proofSaltBuffer = Buffer.from(proof.hash.salt, 'base64');

		const publicKeyBuffer = Buffer.from(this.#account.publicKey.get());
		const encryptedValue = this.#info.encryptedValue;

		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(Buffer.concat([proofSaltBuffer, publicKeyBuffer, encryptedValue, plaintextValue]));
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

function assertCertificateAttributeNames(name: string): asserts name is CertificateAttributeNames {
	if (!(name in CertificateAttributeOIDDB)) {
		throw(new Error(`Unknown attribute name: ${name}`));
	}
}

function asCertificateAttributeNames(name: string): CertificateAttributeNames {
	assertCertificateAttributeNames(name);
	return(name);
}

function convertObjectToSequence(name: CertificateAttributeNames, value: any): any {
	// Convert objects to sequences using Object.values()
	if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof ArrayBuffer) && !(value instanceof Date)) {
		return Object.values(value);
	}
	return value;
}

function encodeAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer | ASN1.SchemaMap<typeof CertificateAttributeSchema[NAME]>): ArrayBuffer {
	if (value instanceof ArrayBuffer) {
		return(value);
	}

	const schema = CertificateAttributeSchema[name];
	
	// For simple string types, encode directly without JStoASN1 conversion
	if (schema === ASN1.ValidateASN1.IsString && typeof value === 'string') {
		// Create UTF-8 string bytes directly
		return new TextEncoder().encode(value).buffer;
	}
	
	// For complex types, convert object format to sequence format
	const sequenceValue = convertObjectToSequence(name, value);
	
	// Use schema validation to convert JS object to proper ASN.1 structure
	const validatedValue = ASN1.ValidateASN1.againstSchema(sequenceValue, schema);
	const asn1Object = ASN1.JStoASN1(validatedValue);
	return(asn1Object.toBER());
}

// XXX:TODO Fix depth issue
// @ts-ignore
function decodeAttribute<NAME extends CertificateAttributeNames>(name: NAME, value: ArrayBuffer): ASN1.SchemaMap<typeof CertificateAttributeSchema[NAME]> | ArrayBuffer;
function decodeAttribute<NAME extends CertificateAttributeNames>(name: string, value: ArrayBuffer): ArrayBuffer;
function decodeAttribute<NAME extends CertificateAttributeNames>(name: ASN1.Schema, value: ArrayBuffer): ASN1.SchemaMap<typeof name> | ArrayBuffer;
function decodeAttribute<NAME extends CertificateAttributeNames>(name: NAME | string | ASN1.Schema, value: ArrayBuffer): ASN1.SchemaMap<typeof CertificateAttributeSchema[NAME]> | ArrayBuffer {
	let schema: ASN1.Schema;
	if (typeof name === 'string') {
		if (!(name in CertificateAttributeSchema)) {
			return(value);
		}

		// @ts-ignore
		schema = CertificateAttributeSchema[name];
		if (schema === undefined) {
			return(value);
		}
	} else {
		schema = name;
	}
	
	// For simple string types, decode directly without ASN1toJS conversion
	if (schema === ASN1.ValidateASN1.IsString) {
		// Decode UTF-8 string bytes directly
		// @ts-ignore - string is valid return type for IsString schema
		return new TextDecoder().decode(value);
	}
	
	// Use ASN1toJS for proper round-trip conversion of complex types
	const asn1Value = ASN1.ASN1toJS(value);
	const validatedValue = ASN1.ValidateASN1.againstSchema(asn1Value, schema);

	// @ts-ignore
	return(validatedValue);
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
	readonly #attributes: { [name: string]: (
		{ sensitive: true; value: SensitiveAttributeType } |
		{ sensitive: false; value: ArrayBuffer }
	)} = {};

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
				throw(new Error(`Unknown attribute: ${name}`));
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
				// Use schema-based DER encoding for sensitive attributes
				// XXX:TODO Fix depth issue
				// @ts-ignore
				const encodedValue = encodeAttribute(name as CertificateAttributeNames, attribute.value);
				const sensitiveAttribute = new SensitiveAttributeBuilder(subject, encodedValue);
				value = arrayBufferToBuffer(await sensitiveAttribute.build());
			} else {
				if (typeof attribute.value === 'string') {
					value = Buffer.from(attribute.value, 'utf-8');
				} else {
					value = arrayBufferToBuffer(attribute.value as ArrayBuffer);
				}
			}

			certAttributes.push([{
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
				KeetaNetClient.lib.Utils.Certificate.CertificateBuilder.extension('1.3.6.1.4.1.62675.0.0', certAttributes)
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

		return(certificateObject);
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
			return(true);
		}

		if (id === '1.3.6.1.4.1.62675.0.0') {
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

/** @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
