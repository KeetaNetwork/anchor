import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import * as ASN1 from './utils/asn1.js';
import { Buffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';
import { assertNever } from './utils/never.js';

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/* -----MOVE TO NODE AND ASN1NAPIRS----- */
function getOID(name: string, oidDB: { [name: string]: string }) {
	if (name in oidDB) {
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

/*
 * Because our public interfaces are ArrayBuffers we often need to convert
 * Buffers to ArrayBuffers -- an alias to the Node function to do that
 */
const bufferToArrayBuffer = KeetaNetClient.lib.Utils.Helper.bufferToArrayBuffer.bind(KeetaNetClient.lib.Utils.Helper);

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
	'aes-256-gcm': '2.16.840.1.101.3.4.1.46',
	'aes-256-cbc': '2.16.840.1.101.3.4.1.42',
	'sha2-256': '2.16.840.1.101.3.4.2.1',
	'sha3-256': '2.16.840.1.101.3.4.2.8'
};

class SensitiveAttributeBuilder {
	readonly #account: KeetaNetAccount;
	#value: Buffer | undefined;

	constructor(account: KeetaNetAccount, value?: Buffer | ArrayBuffer | string) {
		this.#account = account;

		if (value) {
			this.set(value);
		}
	}

	set(value: Buffer | ArrayBuffer | string) {
		if (Buffer.isBuffer(value)) {
			this.#value = value;
		} else if (typeof value === 'string') {
			this.#value = Buffer.from(value, 'utf-8');
		} else {
			this.#value = Buffer.from(value);
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
		const encryptedKey = await this.#account.encrypt(key);

		function encrypt(value: Buffer) {
			const cipherObject = crypto.createCipheriv(cipher, key, nonce);
			let retval = cipherObject.update(value);
			retval = Buffer.concat([retval, cipherObject.final()]);
			return(retval);
		}

		const encryptedValue = encrypt(this.#value);
		const encryptedSalt = encrypt(salt);

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
		const decryptedKey = await this.#account.decrypt(this.#info.cipher.key);
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
		const decryptedValue = await this.#decryptValue(this.#info.encryptedValue);

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

	/**
	 * Generate a proof that a sensitive attribute is a given value,
	 * which can be validated by a third party using the certificate
	 * and the `validateProof` method
	 */
	async proove(): Promise<{ value: string; hash: { salt: string }}> {
		const value = await this.get();
		const salt = await this.#decryptValue(this.#info.hashedValue.encryptedSalt);

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
	async validateProof(proof: Awaited<ReturnType<this['proove']>>): Promise<boolean> {
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
 * Database of attributes
 */
const CertificateAttributeOIDDB = {
	'fullName': '1.3.6.1.4.1.62675.1.0',
	'dateOfBirth': '1.3.6.1.4.1.62675.1.1',
	'address': '1.3.6.1.4.1.62675.1.2',
	'email': '1.3.6.1.4.1.62675.1.3',
	'phoneNumber': '1.3.6.1.4.1.62675.1.4'
};
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

export class CertificateBuilder extends KeetaNetClient.lib.Utils.Certificate.CertificateBuilder {
	readonly #attributes: { [name: string]: { sensitive: boolean; value: ArrayBuffer | string }} = {};

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
	 * Set a KYC Attribute to a given value
	 */
	setAttribute(name: CertificateAttributeNames, sensitive: boolean, value: ArrayBuffer | string): void {
		this.#attributes[name] = { sensitive, value };
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
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const nameOID = CertificateAttributeOIDDB[name as keyof typeof CertificateAttributeOIDDB];

			let value: Buffer;
			if (attribute.sensitive) {
				const sensitiveAttribute = new SensitiveAttributeBuilder(subject, attribute.value);
				value = Buffer.from(await sensitiveAttribute.build());
			} else {
				if (typeof attribute.value === 'string') {
					value = Buffer.from(attribute.value, 'utf-8');
				} else {
					value = Buffer.from(attribute.value);
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
		[name: string]: {
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

	protected processExtension(id: string, value: ArrayBuffer): boolean {
		if (super.processExtension(id, value)) {
			return(true);
		}

		if (id === '1.3.6.1.4.1.62675.0.0') {
			const attributesRaw = new ASN1.BufferStorageASN1(value, CertificateKYCAttributeSchemaValidation).getASN1();

			for (const attribute of attributesRaw) {
				const name = lookupByOID(attribute[0].oid, CertificateAttributeOIDDB);
				const valueKind = attribute[1].value;
				const value = bufferToArrayBuffer(attribute[1].contains);

				switch (valueKind) {
					case 0:
						/* Plain Value */
						this.attributes[name] = { sensitive: false, value: value };
						break;
					case 1:
						/* Sensitive Value */
						this.attributes[name] = {
							sensitive: true,
							value: new SensitiveAttribute(this.subjectKey, value)
						};
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
