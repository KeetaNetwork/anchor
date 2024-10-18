import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as ASN1 from './utils/asn1.js';
import type { Logger } from './log/index.ts';
import { assertNever } from './utils/never.js';
import { createIs, createAssert } from 'typia';
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
				{ type: 'oid', oid: 'ed25519' },
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


const bufferToArrayBuffer = KeetaNetClient.lib.Utils.Helper.bufferToArrayBuffer.bind(KeetaNetClient.lib.Utils.Helper);

/**
 * Sensitive Attribute Schema
 *
 * ASN.1 Schema:
 * SensitiveAttributes DEFINITIONS ::= BEGIN
 *         SensitiveAttribute ::= SEQUENCE {
 *                 version        INTEGER { v1(0) },
 *                 hashedValue    SEQUENCE {
 *                         encryptedSalt  OCTET STRING,
 *                         algorithm      OBJECT IDENTIFIER,
 *                         value          OCTET STRING
 *                 },
 *                 encryptedValue SEQUENCE {
 *                         cipher         SEQUENCE {
 *                                 algorithm    OBJECT IDENTIFIER,
 *                                 ivOrNonce    OCTET STRING,
 *                                 key          OCTET STRING
 *                         },
 *                         value          OCTET STRING
 *                 }
 *         }
 * END
 */
type SensitiveAttributeSchema = [
	/* Version */
	version: bigint,
	/* Hashed Value */
	hashedValue: [
		/* Encrypted Salt */
		encryptedSalt: Buffer,
		/* Hashing Algorithm */
		algorithm: { type: 'oid', oid: string },
		/* Hash of <Encrypted Salt> || <Public Key> || <encryptedValue> || <Value> */
		value: Buffer
	],
	/* Encrypted Value */
	encryptedValue: [
		/* Cipher Details */
		cipher: [
			/* Algorithm */
			algorithm: { type: 'oid', oid: string },
			/* IV or Nonce */
			iv: Buffer,
			/* Symmetric key, encrypted with the public key of the account */
			key: Buffer
		],
		/* Encrypted Value, encrypted with the Cipher above */
		value: Buffer
	]
];

const isSensitiveAttributeSchema = function(input: unknown): input is SensitiveAttributeSchema {
	if (!Array.isArray(input)) {
		return(false);
	}

	const isBigInt = function(input: unknown): input is bigint {
		return(typeof input === 'bigint');
	}

	const isASNOID = createIs<{ type: 'oid', oid: string }>();
	const isBuffer = Buffer.isBuffer.bind(Buffer);
	const isSequence = function(schema: Parameters<typeof ASN1.isValidSequenceSchema>[1]) {
		return(function(schemaInput: unknown) {
			if (!Array.isArray(schemaInput)) {
				return(false);
			}

			return(ASN1.isValidSequenceSchema(schemaInput, schema));
		});
	}

	const retval = ASN1.isValidSequenceSchema(input, [
		/* Version */
		isBigInt,

		/* Hashed Value */
		isSequence([
			/* Encrypted Salt */
			isBuffer,
			/* Hashing Algorithm */
			isASNOID,
			/* Hash of <Encrypted Salt> || <Public Key> || <Encrypted Value> || <Value> */
			isBuffer
		]),
		/* Encrypted Value */
		isSequence([
			/* Cipher Details */
			isSequence([
				/* Algorithm */
				isASNOID,
				/* IV or Nonce */
				isBuffer,
				/* Symmetric key, encrypted with the public key of the account */
				isBuffer
			]),
			/* Encrypted Value, encrypted with the Cipher above */
			isBuffer
		])
	
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
		const encryptedSalt = await this.#account.encrypt(salt);

		const hashingAlgorithm = KeetaNetClient.lib.Utils.Hash.HashFunctionName;
		const publicKey = Buffer.from(this.#account.publicKey.get());

		const cipher = 'aes-256-gcm';
		const key = crypto.randomBytes(32);
		const nonce = crypto.randomBytes(12);
		const encryptedKey = await this.#account.encrypt(key);

		const cipherObject = crypto.createCipheriv(cipher, key, nonce);
		let encryptedValue = cipherObject.update(this.#value);
		encryptedValue = Buffer.concat([encryptedValue, cipherObject.final()]);

		const saltedValue = Buffer.concat([salt, publicKey, encryptedValue, this.#value]);
		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(saltedValue);

		const attributeStructure: SensitiveAttributeSchema = [
			/* Version */
			BigInt(0),
			/* Hashed Value */
			[
				/* Encrypted Salt */
				Buffer.from(encryptedSalt),
				/* Hashing Algorithm */
				{ type: 'oid', oid: getOID(hashingAlgorithm, sensitiveAttributeOIDDB) },
				/* Hash of <Encrypted Salt> || <Public Key> || <Value> */
				Buffer.from(hashedAndSaltedValue)
			],
			/* Encrypted Value */
			[
				/* Cipher Details */
				[
					/* Algorithm */
					{ type: 'oid', oid: getOID(cipher, sensitiveAttributeOIDDB) },
					/* IV or Nonce */
					nonce,
					/* Symmetric key, encrypted with the public key of the account */
					Buffer.from(encryptedKey)
				],
				/* Encrypted Value, encrypted with the Cipher above */
				encryptedValue
			]
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
			hashedValue: {
				encryptedSalt: decodedAttribute[1][0],
				algorithm: lookupByOID(decodedAttribute[1][1].oid, sensitiveAttributeOIDDB),
				value: decodedAttribute[1][2]
			},
			encryptedValue: {
				cipher: {
					algorithm: lookupByOID(decodedAttribute[2][0][0].oid, sensitiveAttributeOIDDB),
					iv: decodedAttribute[2][0][1],
					key: decodedAttribute[2][0][2]
				},
				value: decodedAttribute[2][1]
			}
		});
	}

	async get(): Promise<ArrayBuffer> {
		const decryptedKey = await this.#account.decrypt(this.#info.encryptedValue.cipher.key);
		// @ts-ignore
		const cipher = crypto.createDecipheriv(this.#info.encryptedValue.cipher.algorithm, decryptedKey, this.#info.encryptedValue.cipher.iv);
		const decryptedValue = cipher.update(this.#info.encryptedValue.value);

		return(bufferToArrayBuffer(decryptedValue));
	}

	async proove(): Promise<{ value: string; hash: { salt: string } }> {
		const value = await this.get();
		const salt = Buffer.from(await this.#account.decrypt(this.#info.hashedValue.encryptedSalt));

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
		const encryptedValue = this.#info.encryptedValue.value;

		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(Buffer.concat([proofSaltBuffer, publicKeyBuffer, encryptedValue, plaintextValue]));
		const hashedAndSaltedValueBuffer = Buffer.from(hashedAndSaltedValue);

		return(this.#info.hashedValue.value.equals(hashedAndSaltedValueBuffer));
	}

	toJSON(): unknown/* XXX:TODO */ {
		const retval: unknown = JSON.parse(JSON.stringify(this.#info, function(key, convertedValue) {
			const value = this[key];
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

	setAttribute(name: string, sensitive: boolean, value: ArrayBuffer | string): void {
		this.#attributes[name] = { sensitive, value };
	}

	async build(params?: Partial<CertificateBuilderParams>): Promise<string> {
		const finalParams = {
			...this.#params,
			...params
		};

		/* XXX:TODO: Validate the parameters */
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

		const hashLib = KeetaNetClient.lib.Utils.Hash;
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

		const subjectPublicKeyAlgo = (function() {
			switch (finalParams.subject.keyType) {
				case AccountKeyAlgorithm.ECDSA_SECP256K1:
					return([
						{ type: 'oid', oid: 'ecdsa' },
						{ type: 'oid', oid: 'secp256k1' }
					]);
				case AccountKeyAlgorithm.ECDSA_SECP256R1:
					return([
						{ type: 'oid', oid: 'ecdsa' },
						{ type: 'oid', oid: 'secp256r1' }
					]);
				case AccountKeyAlgorithm.ED25519:
					return([
						{ type: 'oid', oid: 'ed25519' }
					]);
			}
		})();

		/**
		 * Generate the data to be signed within the certificate
		 */
		const tbsCertificateData = [
			/* Version (v3) */
			{ type: 'context', value: 0, contains: BigInt(2) },

			/* Serial Number */
			finalParams.serialNumber,

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
			accountToASN1(finalParams.subject)

			/* Extensions (XXX:TODO) */
		];
		console.debug('Data to be signed:', util.inspect(tbsCertificateData, { depth: 20, colors: true }));
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
		const signature = await finalParams.issuer.sign(toSign);

		/**
		 * Emit the final certificate
		 */
		const certificate = ASN1.JStoASN1([
			/* TBS Certificate */
			tbsCertificateData,

			/* Signature Algorithm */
			[
				/* Algorithm */
				{ type: 'oid', oid: signatureAlgorithmOID },
			],

			/* Signature */
			{ type: 'bitstring', value: signature.getBuffer() }
		]).toBER();

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

	constructor(data: ArrayBuffer | string, moment?: Date) {
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
		const certificateObject = new crypto.X509Certificate(dataBuffer);

		const issuerDNPublicKey = certificateObject.issuer.replace(/^CN=/, '');
		const subjectDNPublicKey = certificateObject.subject.replace(/^CN=/, '');
		this.issuer = KeetaNetClient.lib.Account.toAccount(issuerDNPublicKey);
		this.subject = KeetaNetClient.lib.Account.toAccount(subjectDNPublicKey);
		this.notBefore = new Date(certificateObject.validFrom);
		this.notAfter = new Date(certificateObject.validTo);
		this.serialNumber = BigInt(certificateObject.serialNumber);

		if (false) {
			/* XXX:TODO */
			const subjectPublicKey = cryptoKeyToAccount(certificateObject.publicKey);
			if (!subjectPublicKey.comparePublicKey(this.subject)) {
				throw(new Error('Certificate subject does not match public key'));
			}
		}

		const issuerKey = accountToCryptoKey(this.issuer);
		console.debug('Certificate:', certificateObject);
		console.debug('Issuer Key:', issuerKey);
		if (!certificateObject.verify(issuerKey)) {
			throw(new Error('Certificate is invalid'));
		}

		/* XXX:TODO */
		this.attributes = {};
	}

	toJSON(): void/* XXX:TODO */ {
		throw(new Error('not implemented'));
	}
}

/* @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
