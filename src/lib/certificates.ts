import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as ASN1 from './utils/asn1.js';
import type { Logger } from './log/index.ts';
import { assertNever } from './utils/never.js';
import { createIs } from 'typia';
import crypto from 'crypto';
import util from 'node:util';

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];
const AccountKeyAlgorithm: typeof KeetaNetClient.lib.Account.AccountKeyAlgorithm = KeetaNetClient.lib.Account.AccountKeyAlgorithm;
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/* -----MOVE TO NODE AND ASN1NAPIRS-----*/
function getOID(name: string, oidDB: { [name: string]: string }) {
	if (name in oidDB) {
		const oid = oidDB[name as keyof typeof oidDB];
		if (oid === undefined) {
			throw(new Error('internal error: OID was undefined'));
		}

		return(oid);
	} else {
		throw new Error('Unknown algorithm');
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
/* -----END MOVE TO NODE AND ASN1NAPIRS-----*/

/* -----MOVE TO NODE-----*/
function cryptoKeyToAccount(key: crypto.KeyObject): KeetaNetAccount {
	switch (key.asymmetricKeyType) {
		case 'ed25519':
			return(KeetaNetClient.lib.Account.fromEd25519PublicKey(key.export()));
		case 'ec':
			switch (key.asymmetricKeyDetails?.namedCurve) {
				case 'secp256k1':
					return(KeetaNetClient.lib.Account.fromEcDSAPublicKeyK1(key.export()));
				case 'secp256r1':
					return(KeetaNetClient.lib.Account.fromEcDSAPublicKeyR1(key.export()));
			}
			break;
	}

	throw(new Error('Unsupported key type'));
}

/* This should probably be on the Account class */
function accountToASN1(key: KeetaNetAccount | string) {
	key = KeetaNetClient.lib.Account.toAccount(key);

	let publicKeyInfo;
	switch (key.keyType) {
		case AccountKeyAlgorithm.ED25519:
			publicKeyInfo = [
				[{ type: 'oid', oid: 'ed25519' }],
				{ type: 'bitstring', value: key.publicKey.getBuffer() }
			];
			break;
		case AccountKeyAlgorithm.ECDSA_SECP256K1:
			publicKeyInfo = [
				[
					{ type: 'oid', oid: 'ecdsa' },
					{ type: 'oid', oid: 'secp256k1' },
				],
				{ type: 'bitstring', value: key.publicKey.getBuffer() }
			];
			break;
		case AccountKeyAlgorithm.ECDSA_SECP256R1:
			publicKeyInfo = [
				[
					{ type: 'oid', oid: 'ecdsa' },
					{ type: 'oid', oid: '1.2.840.10045.3.1.7' /* XXX:TODO: Add to Node OIDDB */ },
				],
				{ type: 'bitstring', value: key.publicKey.getBuffer() }
			];
			break;
		case AccountKeyAlgorithm.NETWORK:
		case AccountKeyAlgorithm.STORAGE:
		case AccountKeyAlgorithm.TOKEN:
			throw(new Error('Unsupported key type'));
		default:
			assertNever(key.keyType);
	}

	return(publicKeyInfo);
}

function accountToCryptoKey(key: KeetaNetAccount | string): crypto.KeyObject {
	key = KeetaNetClient.lib.Account.toAccount(key);

	return(crypto.createPublicKey({
		key: Buffer.from(ASN1.JStoASN1(accountToASN1(key)).toBER()),
		format: 'der',
		type: 'spki'
	}));
}
/* -----END MOVE TO NODE-----*/

function toJSON(data: unknown): unknown {
	const retval: unknown = JSON.parse(JSON.stringify(data, function(key, convertedValue) {
		const value: unknown = this[key];

		if (typeof value === 'object' && value !== null) {
			if ('publicKeyString' in value && typeof value.publicKeyString === 'object' && value.publicKeyString !== null) {
				if ('get' in value.publicKeyString && typeof value.publicKeyString.get === 'function') {
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
 *                 encryptedValue SEQUENCE {
 *                         value          OCTET STRING
 *                 }
 *         }
 * END
 */
type SensitiveAttributeSchema = [
	/* Version */
	version: bigint,
	/* Cipher Details */
	cipher: [
		/* Algorithm */
		algorithm: { type: 'oid', oid: string },
		/* IV or Nonce */
		iv: Buffer,
		/* Symmetric key, encrypted with the public key of the account */
		key: Buffer
	],
	/* Hashed Value */
	hashedValue: [
		/* Encrypted Salt */
		encryptedSalt: Buffer,
		/* Hashing Algorithm */
		algorithm: { type: 'oid', oid: string },
		/* Hash of <Encrypted Salt> || <Public Key> || <encryptedValue> || <Value> */
		value: Buffer
	],
	/* Encrypted Value, encrypted with the Cipher above */
	encryptedValue: Buffer
];

/**
 * Sequence validation tools, useful for @see ASN1.isValidSequenceSchema
 */
const validate = {
	/**
	 * Validate that the input is a BigInt
	 */
	isBigInt: function(input: unknown): input is bigint {
		return(typeof input === 'bigint');
	},

	/**
	 * Validate that the input os a context-specific tag
	 */
	isContext: function(tag: number, schema: Parameters<typeof ASN1.isValidSequenceSchema>[1][number]) {
		return(function(schemaInput: unknown) {
			if (typeof schemaInput !== 'object' || schemaInput === null) {
				return(false);
			}

			if (!('type' in schemaInput) || schemaInput.type !== 'context') {
				return(false);
			}

			if (!('value' in schemaInput) || schemaInput.value !== tag) {
				return(false);
			}

			if (!('contains' in schemaInput)) {
				return(false);
			}

			const retval = schema(schemaInput.contains);

			return(retval);
		});
	},

	/**
	 * Validate that the input is an ASN.1 OID
	 */
	isASNOID: createIs<{ type: 'oid', oid: string }>(),

	/**
	 * Validate that the input is a Buffer
	 */
	isBuffer: Buffer.isBuffer.bind(Buffer),

	/**
	 * Validate that the input is a Date
	 */
	isDate: util.isDate.bind(util),

	/**
	 * Validate that the input is a boolean
	 */
	isBoolean: util.isBoolean.bind(util),

	/**
	 * Validate that the input is a bitstring
	 */
	isBitstring: function(input: unknown): input is { type: 'bitstring', value: Buffer } {
		if (typeof input !== 'object' || input === null) {
			return(false);
		}

		if (!('type' in input) || input.type !== 'bitstring') {
			return(false);
		}

		if (!('value' in input)) {
			return(false);
		}

		return(Buffer.isBuffer(input.value));
	},

	/**
	 * Validate that the input is an ASN.1 Sequence
	 */
	isSequence: function(schema: Parameters<typeof ASN1.isValidSequenceSchema>[1]) {
		return(function(schemaInput: unknown) {
			if (!Array.isArray(schemaInput)) {
				return(false);
			}

			return(ASN1.isValidSequenceSchema(schemaInput, schema));
		});
	},

	/**
	 * Validate that the input is an array of a given type
	 */
	isArrayOf: function(schema: Parameters<typeof ASN1.isValidSequenceSchema>[1][number]) {
		return(function(schemaInput: unknown) {
			if (!Array.isArray(schemaInput)) {
				return(false);
			}

			for (const input of schemaInput) {
				if (!schema(input)) {
					return(false);
				}
			}

			return(true);
		});
	},

	/**
	 * Validate that the input is an ASN.1 set with an OID for a name a string for value
	 */
	isSet: createIs<{ type: 'set', name: { type: 'oid', oid: string }, value: string | { type: 'string', kind: string, value: string } }>()
};

function isSensitiveAttributeSchema(input: unknown): input is SensitiveAttributeSchema {
	if (!Array.isArray(input)) {
		return(false);
	}


	const retval = ASN1.isValidSequenceSchema(input, [
		/* Version */
		validate.isBigInt,

		/* Cipher Details */
		validate.isSequence([
			/* Algorithm */
			validate.isASNOID,
			/* IV or Nonce */
			validate.isBuffer,
			/* Symmetric key, encrypted with the public key of the account */
			validate.isBuffer
		]),

		/* Hashed Value */
		validate.isSequence([
			/* Encrypted Salt, encrypted with the Cipher above */
			validate.isBuffer,
			/* Hashing Algorithm */
			validate.isASNOID,
			/* Hash of <Encrypted Salt> || <Public Key> || <Encrypted Value> || <Value> */
			validate.isBuffer
		]),

		/* Encrypted Value, encrypted with the Cipher above */
		validate.isBuffer
	
	]);

	return(retval);
}

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
	#account: KeetaNetAccount;
	#value: Buffer | undefined;

	constructor(account: KeetaNetAccount, value?: ArrayBuffer | string) {
		this.#account = account;

		if (value) {
			this.set(value);
		}
	}

	set(value: ArrayBuffer | string) {
		if (typeof value === 'string') {
			this.#value = Buffer.from(value, 'utf-8');
		} else {
			this.#value = Buffer.from(value);
		}
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
			BigInt(0),
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
	#account: KeetaNetAccount;
	#info: ReturnType<SensitiveAttribute['decode']>;

	constructor(account: KeetaNetAccount, data: ArrayBuffer) {
		this.#account = account;
		this.#info = this.decode(data);
	}

	private decode(data: ArrayBuffer) {
		const decodedAttribute = ASN1.ASN1toJS(data);

		if (!isSensitiveAttributeSchema(decodedAttribute)) {
			throw(new Error('Unable to decode attribute'));
		}

		const decodedVersion = decodedAttribute[0];
		if (decodedVersion !== BigInt(0)) {
			throw(new Error(`Unsupported Sensitive Attribute version (${decodedVersion})`));;
		}

		return({
			version: decodedVersion + BigInt(1),
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

	async proove(): Promise<{ value: string; hash: { salt: string } }> {
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
	'fullName': '1.3.6.1.4.1.159660.1.0',
	'dateOfBirth': '1.3.6.1.4.1.159660.1.1',
	'address': '1.3.6.1.4.1.159660.1.2',
	'email': '1.3.6.1.4.1.159660.1.3',
	'phoneNumber': '1.3.6.1.4.1.159660.1.4'
};
type CertificateAttributeNames = keyof typeof CertificateAttributeOIDDB;

type CertificateSchema = [
	tbsCertificate: [
		/* Version */
		version: { type: 'context', value: 0, contains: bigint },
		/* Serial Number */
		serialNumber: bigint,
		/* Signature Algorithm */
		signatureAlgorithm: { type: 'oid', oid: string }[],
		/* Issuer */
		issuer: { type: 'set', name: { type: 'oid', oid: string }, value: string }[],
		/* Validity Period */
		validityPeriod: [Date, Date],
		/* Subject */
		issuer: { type: 'set', name: { type: 'oid', oid: string }, value: string }[],
		/* Subject Public Key */
		subjectPublicKey: ReturnType<typeof accountToASN1>,
		/* Extensions */
		extensions: {
			type: 'context',
			value: 3,
			contains: ([
				/* Extension */
				id: { type: 'oid', oid: string },
				/* Critical */
				critical: boolean,
				/* Value */
				value: Buffer
			] | [
				/* Extension */
				id: { type: 'oid', oid: string },
				/* Value */
				value: Buffer
			])[]
		},
	],
	/* Signature Algorithm */
	signatureAlgorithm: { type: 'oid', oid: string }[],
	/* Signature */
	signature: { type: 'bitstring', value: Buffer }
];

function isCertificateSchema(input: unknown): input is CertificateSchema {
	if (!Array.isArray(input)) {
		return(false);
	}

	const schema: Parameters<typeof ASN1.isValidSequenceSchema>[1] = [
		validate.isSequence([
			/* Version */
			validate.isContext(0, validate.isBigInt),
			/* Serial Number */
			validate.isBigInt,
			/* Signature Algorithm */
			validate.isArrayOf(validate.isASNOID),
			/* Issuer */
			validate.isArrayOf(validate.isSet),
			/* Validity Period */
			validate.isSequence([
				validate.isDate,
				validate.isDate
			]),
			/* Subject */
			validate.isArrayOf(validate.isSet),
			/* Subject Public Key */
			validate.isSequence([
				validate.isArrayOf(validate.isASNOID),
				validate.isBitstring
			]),
			validate.isContext(3,
				validate.isArrayOf(function(input: unknown) {
					if (!Array.isArray(input)) {
						return(false);
					}

					if (ASN1.isValidSequenceSchema(input, [
						validate.isASNOID,
						validate.isBuffer
					])) {
						return(true);
					}

					if (ASN1.isValidSequenceSchema(input, [
						validate.isASNOID,
						validate.isBoolean,
						validate.isBuffer
					])) {
						return(true);
					}

					return(false);
				})
			)
		]),
		/* Signature Algorithm */
		validate.isArrayOf(validate.isASNOID),
		/* Signature */
		validate.isBitstring
	];

	const retval = ASN1.isValidSequenceSchema(input, schema);

	return(retval);
}

type CertificateKYCAttributeSchema = [
	{ type: 'oid', oid: string },
	{ type: 'context', value: number, contains: Buffer }
];

function isValidAttribute(input: unknown): input is CertificateKYCAttributeSchema {
	if (!Array.isArray(input)) {
		return(false);
	}
	return(ASN1.isValidSequenceSchema(input, [
		validate.isASNOID,
		function(input: unknown) {
			if (validate.isContext(0, validate.isBuffer)(input)) {
				return(true);
			}
			if (validate.isContext(1, validate.isBuffer)(input)) {
				return(true);
			}
			return(false);
		}
	]));
}

type CertificateBuilderParams = {
	subject: KeetaNetAccount;
	issuer: KeetaNetAccount;
	validFrom: Date;
	validTo: Date;
	serialNumber: bigint | number;
};

export class CertificateBuilder {
	#params: Partial<CertificateBuilderParams>;
	#attributes: { [name: string]: { sensitive: boolean; value: ArrayBuffer | string } } = {};

	constructor(params?: Partial<CertificateBuilderParams>) {
		this.#params = {
			...params
		};
	}

	setAttribute(name: CertificateAttributeNames, sensitive: boolean, value: ArrayBuffer | string): void {
		this.#attributes[name] = { sensitive, value };
	}

	async build(params?: Partial<CertificateBuilderParams>): Promise<string> {
		const finalParams = {
			...this.#params,
			...params
		};

		/* Validate that required parameters are set */
		if (!('issuer' in finalParams)) {
			throw(new Error('"issuer" not set'));
		}

		if (!('subject' in finalParams)) {
			throw(new Error('"subject" not set'));
		}

		if (!('validFrom' in finalParams)) {
			throw(new Error('"validFrom" not set'));
		}

		if (!('validTo' in finalParams)) {
			throw(new Error('"validTo" not set'));
		}

		if (!('serialNumber' in finalParams)) {
			throw(new Error('"serialNumber" not set'));
		}


		const hashLib_ = KeetaNetClient.lib.Utils.Hash;
		const hashLib = {
			HashFunctionName: 'sha256',
			Hash: function(data: Buffer, len?: number): ArrayBuffer {
				const hash = crypto.createHash('sha256');
				hash.update(data);
				let retval = bufferToArrayBuffer(hash.digest());
				if (len !== undefined) {
					retval = retval.slice(0, len);
				}

				return(retval);
			}
		}

		const {
			oid: signatureAlgorithmOID,
			hashData: hashData
		} = (function() {
			switch (finalParams.issuer.keyType) {
				case AccountKeyAlgorithm.ECDSA_SECP256K1:
				case AccountKeyAlgorithm.ECDSA_SECP256R1:
					return({
						oid: `${hashLib.HashFunctionName}WithEcDSA`,
						hashData: true
					});
				case AccountKeyAlgorithm.ED25519:
					return({
						oid: 'ed25519',
						hashData: false
					});
			}

			throw(new Error('Unsupported key type'));
		})();

		function extension(oid: string, value: Parameters<typeof ASN1.JStoASN1>[0], critical?: boolean) {
			let criticalValue: [critical: boolean] | [] = [];
			if (critical !== undefined) {
				criticalValue = [critical];
			}

			const retval: [{ type: 'oid', oid: string }, value: Buffer] | [{ type: 'oid', oid: string }, critical: boolean, value: Buffer ] = [
				{ type: 'oid', oid: oid },
				...criticalValue,
				Buffer.from(ASN1.JStoASN1(value).toBER())
			];

			return(retval);
		}

		function accountToKeyId(account: KeetaNetAccount) {
			return(Buffer.from(hashLib.Hash(Buffer.concat([
				Buffer.from('KeetaKey', 'utf-8'),
				account.publicKeyAndType
			]), 20)));
		}

		/**
		 * Determine if the certificate is a Certificate Authority,
		 * and add the appropriate extensions
		 */
		let isCertificateAuthority = false;
		if (finalParams.issuer.comparePublicKey(finalParams.subject)) {
			isCertificateAuthority = true;
		}

		/**
		 * Extensions to add to the certificate
		 */
		let extensions = [];
		if (isCertificateAuthority) {
			extensions.push(
				/** Extension: Basic Constraints (CA) */
				extension('2.5.29.19', [true], true),
				/** Extension: Key Usage */
				extension('2.5.29.15', {
					type: 'bitstring',
					value: Buffer.from([0
						| (1 << 1) /* CRL Sign */
						| (1 << 2) /* Cert Sign */
						| (0 << 3) /* Key Agreement */
						| (0 << 4) /* Data Encipherment */
						| (0 << 5) /* Key Encipherment */
						| (1 << 6) /* Non Repudiation */
						| (1 << 7) /* Digital Signature */
					])
				}, true)
			);
		} else {
			extensions.push(
				/** Extension: Key Usage */
				extension('2.5.29.15', {
					type: 'bitstring',
					value: Buffer.from([0
						| (0 << 1) /* CRL Sign */
						| (0 << 2) /* Cert Sign */
						| (0 << 3) /* Key Agreement */
						| (0 << 4) /* Data Encipherment */
						| (0 << 5) /* Key Encipherment */
						| (1 << 6) /* Non Repudiation */
						| (1 << 7) /* Digital Signature */
					])
				}, true)
			);
		}

		/* Common Extensions */
		extensions.push(
			/** Extension: Authority Key Identifier */
			extension('2.5.29.35', [
				{ type: 'context', value: 0, contains: accountToKeyId(finalParams.issuer) }
			]),
			/** Extension: Subject Key Identifier */
			extension('2.5.29.14', accountToKeyId(finalParams.subject))
		);

		/* Encode the attributes */
		let certAttributes: CertificateKYCAttributeSchema[] = [];
		for (const [name, attribute] of Object.entries(this.#attributes)) {
			if (!(name in CertificateAttributeOIDDB)) {
				throw(new Error(`Unknown attribute: ${name}`));
			}
			const nameOID = CertificateAttributeOIDDB[name as keyof typeof CertificateAttributeOIDDB];

			let value: Buffer;
			if (attribute.sensitive) {
				const sensitiveAttribute = new SensitiveAttributeBuilder(finalParams.subject, attribute.value);
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
				value: attribute.sensitive ? 1 : 0,
				contains: value
			}]);
		}

		if (certAttributes.length > 0) {
			extensions.push(
				extension('1.3.6.1.4.1.159660.0.0', certAttributes)
			);
		}

		/**
		 * Generate the data to be signed within the certificate
		 */
		const tbsCertificateData: CertificateSchema[0] = [
			/* Version (v3) */
			{ type: 'context', value: 0, contains: BigInt(2) },

			/* Serial Number */
			BigInt(finalParams.serialNumber),

			/* Signature Algorithm */
			[
				/* Algorithm */
				{ type: 'oid', oid: signatureAlgorithmOID },
			],

			/* Issuer */
			[
				{
					type: 'set',
					name: {
						type: 'oid',
						oid: 'commonName'
					},
					value: finalParams.issuer.publicKeyString.get()
				}
			],

			/* Validity Period */
			[
				/* Not Before */
				finalParams.validFrom,
				/* Not After */
				finalParams.validTo
			],

			/* Subject */
			[
				{
					type: 'set',
					name: {
						type: 'oid',
						oid: 'commonName'
					},
					value: finalParams.subject.publicKeyString.get()
				}
			],

			/* Subject Public Key */
			accountToASN1(finalParams.subject),

			/* Extensions */
			{
				type: 'context',
				value: 3,
				contains: extensions
			}

		];
		const tbsCertificate = ASN1.JStoASN1(tbsCertificateData).toBER();

		const tbsCertificateBuffer = Buffer.from(tbsCertificate);

		/**
		 * Sign the certificate
		 */
		let toSign;
		if (hashData) {
			toSign = Buffer.from(hashLib.Hash(tbsCertificateBuffer));
		} else {
			toSign = tbsCertificateBuffer;
		}
		const signature = await finalParams.issuer.sign(toSign, {
			raw: true,
			forCert: true
		});

		/**
		 * Emit the final certificate
		 */
		const certificateObject: CertificateSchema = [
			/* TBS Certificate */
			tbsCertificateData,

			/* Signature Algorithm */
			[
				/* Algorithm */
				{ type: 'oid', oid: signatureAlgorithmOID },
			],

			/* Signature */
			{ type: 'bitstring', value: signature.getBuffer() }
		];

		const certificate = ASN1.JStoASN1(certificateObject).toBER();

		const certificatePEMLines = Buffer.from(certificate).toString('base64').split(/(.{64})/g).filter(function(line) {
			return(line.length > 0);
		});
		const certificatePEM = [
			'-----BEGIN CERTIFICATE-----',
			...certificatePEMLines,
			'-----END CERTIFICATE-----'
		].join('\n') + '\n';

		return(certificatePEM);
	}
}

export class Certificate {
	static readonly Builder: typeof CertificateBuilder = CertificateBuilder;
	readonly subject: KeetaNetAccount;
	readonly issuer: KeetaNetAccount;
	readonly notBefore: Date;
	readonly notAfter: Date;
	readonly serialNumber: bigint;
	readonly attributes: {
		[name: string]: {
			sensitive: true;
			value: SensitiveAttribute
		} | {
			sensitive: false;
			value: ArrayBuffer
		}
	};

	#parseCertificate(data: Buffer, inputSubjectAccount?: KeetaNetAccount) {
		const input = ASN1.ASN1toJS(bufferToArrayBuffer(data));
		const isCertificate = isCertificateSchema(input);
		if (!isCertificate) {
			throw(new Error('Invalid certificate: Parse error'));
		}

		const tbsCertificate = input[0];
		const version = tbsCertificate[0].contains;
		const serialNumber = tbsCertificate[1];
		const signatureAlgorithmSigned = tbsCertificate[2];
		const issuer = tbsCertificate[3];
		const validityPeriodBegin = tbsCertificate[4][0];
		const validityPeriodEnd = tbsCertificate[4][1];
		const subject = tbsCertificate[5];
		const subjectPublicKeyInfo = tbsCertificate[6];
		const extensions = tbsCertificate[7].contains;
		const signatureAlgorithm = input[1];
		const signature = input[2].value;

		/*
		 * Verify signature
		 */
		/* XXX:TODO */

		/*
		 * Perform basic checks
		 */
		if (version !== BigInt(2)) {
			throw(new Error(`Invalid certificate: Unsupported certificate version: ${version}`));
		}

		if (JSON.stringify(signatureAlgorithmSigned) !== JSON.stringify(signatureAlgorithm)) {
			throw(new Error('Invalid certificate: Signature algorithm mismatch'));
		}

		/*
		 * Compute the Issuer/Subject DN (Distinguished Name) and CN (Common Name)
		 */
		const issuerCN = issuer.find(function(nameValue) {
			return(nameValue.name.oid === 'commonName');
		})?.value;

		const subjectCN = subject.find(function(nameValue) {
			return(nameValue.name.oid === 'commonName');
		})?.value;

		const issuerDN = issuer.map(function(nameValue) {
			return(`${nameValue.name.oid}=${nameValue.value}`);
		}).join(', ');

		const subjectDN = subject.map(function(nameValue) {
			return(`${nameValue.name.oid}=${nameValue.value}`);
		}).join(', ');

		if (!issuerCN || !subjectCN) {
			throw(new Error('Invalid certificate: Missing common name for issuer or subject'));
		}

		const issuerAccount = KeetaNetClient.lib.Account.fromPublicKeyString(issuerCN);
		let subjectAccount = KeetaNetClient.lib.Account.fromPublicKeyString(subjectCN);

		/*
		 * Because we may need to perform cryptographic operations
		 * with the metadata, allow specifying a subject account
		 * to use which has a private key attached
		 */
		if (inputSubjectAccount !== undefined) {
			if (subjectAccount.comparePublicKey(inputSubjectAccount)) {
				subjectAccount = inputSubjectAccount;
			} else {
				throw(new Error('Invalid certificate: Subject account does not match the provided account'));
			}
		}

		/*
		 * Verify the subject public key info
		 */
		/* XXX:TODO */

		/*
		 * Process the extensions into an easier to work with form
		 */
		const processedExtensions = extensions.map(function(extension) {
			let critical = false;
			let oid: string;
			let value: Buffer;
			if (extension.length === 2) {
				oid = extension[0].oid;
				value = extension[1];
			} else if (extension.length === 3) {
				critical = extension[1];
				oid = extension[0].oid;
				value = extension[2];
			} else {
				throw(new Error('Invalid certificate: Invalid extension format'));
			}

			return({ oid, critical, value });
		});

		/*
		 * Verify that we understand all the critical extensions
		 */
		/* XXX:TODO */

		/*
		 * Add the KYC Attributes from the KYC Attributes extension
		 */
		const kycAttributesExtension = processedExtensions.find(function(extension) {
			return(extension.oid === '1.3.6.1.4.1.159660.0.0');
		});

		const kycAttributes = (() => {
			if (kycAttributesExtension === undefined) {
				return(undefined);
			}

			const toProcessKYC = ASN1.ASN1toJS(bufferToArrayBuffer(kycAttributesExtension.value));
			if (!Array.isArray(toProcessKYC)) {
				throw(new Error('Invalid certificate: Invalid KYC Attributes extension'));
			}

			const kycAttributesFlat = toProcessKYC.map(function(attribute): [name: string, InstanceType<typeof Certificate>['attributes'][string]] {
				if (!isValidAttribute(attribute)) {
					throw(new Error('Invalid certificate: Invalid KYC Attribute'));
				}

				const name = lookupByOID(attribute[0].oid, CertificateAttributeOIDDB);
				let sensitive;
				switch (attribute[1].value) {
					case 0:
						sensitive = false;
						break;
					case 1:
						sensitive = true;
						break;
					default:
						throw(new Error('Invalid certificate: Invalid KYC Attribute sensitive flag'));
				}

				const attributeContents = bufferToArrayBuffer(attribute[1].contains);

				if (sensitive) {
					const sensitiveAttributeContents = new SensitiveAttribute(subjectAccount, attributeContents);
					return([name, { sensitive: true, value: sensitiveAttributeContents }]);
				} else {
					return([name, { sensitive: false, value: attributeContents }]);
				}
			});

			const retval = Object.fromEntries(kycAttributesFlat);
			return(retval);
		})();

		return({
			serialNumber,
			issuer: {
				'$account': issuerAccount,
				'$dn': issuerDN,
				commonName: issuerCN
			},
			subject: {
				'$account': subjectAccount,
				'$dn': subjectDN,
				commonName: subjectCN
			},
			validity: {
				notBefore: validityPeriodBegin,
				notAfter: validityPeriodEnd
			},
			attributes: {
				kyc: kycAttributes
			}
		});
	}

	constructor(data: ArrayBuffer | string, subjectAccount?: KeetaNetAccount, moment?: Date) {
		let dataBuffer;
		if (typeof data === 'string') {
			const lines = data.split('\n');
			const startLineIndex = lines.findIndex(function(line) {
				return(line === '-----BEGIN CERTIFICATE-----');
			});
			if (startLineIndex === -1) {
				dataBuffer = Buffer.from(data, 'base64');
			} else {
				lines.splice(0, startLineIndex + 1);

				const endLineIndex = lines.findIndex(function(line) {
					return(line === '-----END CERTIFICATE-----');
				});

				if (endLineIndex === -1) {
					throw(new Error('Invalid PEM format'));
				}

				lines.splice(endLineIndex);

				dataBuffer = Buffer.from(lines.join(''), 'base64');
			}
		} else {
			dataBuffer = Buffer.from(data);
		}

		const certificate = this.#parseCertificate(dataBuffer, subjectAccount);
		this.serialNumber = certificate.serialNumber;
		this.issuer = certificate.issuer.$account;
		this.subject = certificate.subject.$account;
		this.notBefore = certificate.validity.notBefore;
		this.notAfter = certificate.validity.notAfter;
		this.attributes = certificate.attributes.kyc ?? {};
	}

	toJSON(): unknown/* XXX:TODO */ {
		return(toJSON({ ...this }));
	}
}

/* @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
