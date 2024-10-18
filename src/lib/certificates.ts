import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as ASN1 from './utils/asn1.js';
import type { Logger } from './log/index.ts';
import { assertNever } from './utils/never.js';
import { createIs, createAssert } from 'typia';
import crypto from 'crypto';

type AccountKeyAlgorithm = InstanceType<typeof KeetaNetClient.lib.Account>['keyType'];
type KeetaNetAccount = ReturnType<typeof KeetaNetClient.lib.Account.fromSeed<AccountKeyAlgorithm>>;

/*
 * Database of permitted algorithms and their OIDs
 */
const OIDDB = {
	'aes-256-gcm': '2.16.840.1.101.3.4.1.46',
	'aes-256-cbc': '2.16.840.1.101.3.4.1.42',
	'sha2-256': '2.16.840.1.101.3.4.2.1',
	'sha3-256': '2.16.840.1.101.3.4.2.8'
};

function getOID(name: string) {
	if (name in OIDDB) {
		const oid = OIDDB[name as keyof typeof OIDDB];
		return oid;
	} else {
		throw new Error('Unknown algorithm');
	}
}

function lookupByOID(oid: string) {
	for (const [key, value] of Object.entries(OIDDB)) {
		if (key === oid) {
			return(key);
		}

		if (value === oid) {
			return(key);
		}
	}

	throw(new Error(`Unknown OID: ${oid}`));
}

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
				{ type: 'oid', oid: getOID(hashingAlgorithm) },
				/* Hash of <Encrypted Salt> || <Public Key> || <Value> */
				Buffer.from(hashedAndSaltedValue)
			],
			/* Encrypted Value */
			[
				/* Cipher Details */
				[
					/* Algorithm */
					{ type: 'oid', oid: getOID(cipher) },
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
				algorithm: lookupByOID(decodedAttribute[1][1].oid),
				value: decodedAttribute[1][2]
			},
			encryptedValue: {
				cipher: {
					algorithm: lookupByOID(decodedAttribute[2][0][0].oid),
					iv: decodedAttribute[2][0][1],
					key: decodedAttribute[2][0][2]
				},
				value: decodedAttribute[2][1]
			}
		});
	}

	async get() {
		const decryptedKey = await this.#account.decrypt(this.#info.encryptedValue.cipher.key);
		// @ts-ignore
		const cipher = crypto.createDecipheriv(this.#info.encryptedValue.cipher.algorithm, decryptedKey, this.#info.encryptedValue.cipher.iv);
		const decryptedValue = cipher.update(this.#info.encryptedValue.value);

		return(bufferToArrayBuffer(decryptedValue));
	}

	async proove() {
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
	async validateProof(proof: Awaited<ReturnType<this['proove']>>) {
		const plaintextValue = Buffer.from(proof.value, 'base64');
		const proofSaltBuffer = Buffer.from(proof.hash.salt, 'base64');

		const publicKeyBuffer = Buffer.from(this.#account.publicKey.get());
		const encryptedValue = this.#info.encryptedValue.value;

		const hashedAndSaltedValue = KeetaNetClient.lib.Utils.Hash.Hash(Buffer.concat([proofSaltBuffer, publicKeyBuffer, encryptedValue, plaintextValue]));
		const hashedAndSaltedValueBuffer = Buffer.from(hashedAndSaltedValue);

		return(this.#info.hashedValue.value.equals(hashedAndSaltedValueBuffer));
	}

	toJSON() {
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

/* @internal */
export const _Testing = {
	SensitiveAttributeBuilder,
	SensitiveAttribute
};
