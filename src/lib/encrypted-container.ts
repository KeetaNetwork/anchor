import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as util from 'node:util';

import { Account } from '@keetanetwork/keetanet-node/dist/lib/account.js';
import {
	ASN1toJS,
	JStoASN1
} from '@keetanetwork/keetanet-node/dist/lib/utils/asn1.js';
import { bufferToArrayBuffer } from '@keetanetwork/keetanet-node/dist/lib/utils/helper.js';
import { isArray } from './utils/array.js';

const zlibDeflate = util.promisify(zlib.deflate);
const zlibInflate = util.promisify(zlib.inflate);

/*
 * ASN.1 Schema
 *
 * EncryptedContainer DEFINITIONS ::=
 * BEGIN
 * 	Version	::= INTEGER { v1(0) }
 *
 * 	KeyStore ::= SEQUENCE {
 * 		publicKey              BIT STRING,
 * 		encryptedSymmetricKey  BIT STRING,
 * 		...
 * 	}
 *
 * 	EncryptedContainerBox ::= SEQUENCE {
 * 		keys                   SEQUENCE OF KeyStore,
 * 		initializationVector   OCTET STRING,
 * 		encryptedValue         OCTET STRING,
 * 		...
 * 	}
 *
 * 	PlaintextContainerBox ::= SEQUENCE {
 * 		plainValue             OCTET STRING,
 * 		...
 * 	}
 *
 * 	EncryptedContainerPackage ::= SEQUENCE {
 * 		version                Version (v1),
 * 		isEncrypted            BOOLEAN (TRUE),
 * 		encryptedBox           EncryptedContainerBox,
 * 		...
 * 	}
 *
 * 	PlaintextContainerPackage ::= SEQUENCE {
 * 		version                Version (v1),
 * 		isEncrypted            BOOLEAN (FALSE),
 * 		plaintextBox           PlaintextContainerBox,
 * 		...
 * 	}
 * END
 */

interface ASN1BitString {
	type: 'bitstring';
	value: Buffer;
}

function isASN1BitString(input: unknown): input is ASN1BitString {
	if (typeof input !== 'object' || input === null) {
		return(false);
	}

	if (!('type' in input)) {
		return(false);
	}

	if (typeof input.type !== 'string') {
		return(false);
	}

	if (!('value' in input)) {
		return(false);
	}

	if (!Buffer.isBuffer(input.value)) {
		return(false);
	}

	return(true);
}

type EncryptedContainerKeyStore = [
	/* publicKey */
	ASN1BitString,

	/* encryptedSymmetricKey */
	ASN1BitString
];

type EncryptedContainerBoxEncrypted = [
	/* keys */
	EncryptedContainerKeyStore[],

	/* initializationVector */
	Buffer,

	/* value */
	Buffer
];

type EncryptedContainerBoxPlaintext = [
	/* value */
	Buffer
];

type EncryptedContainerPackage = [
	/* version */
	number,

	/* isEncrypted */
	true,

	/* data */
	EncryptedContainerBoxEncrypted
] | [
	/* version */
	number,

	/* isEncrypted */
	false,

	/* data */
	EncryptedContainerBoxPlaintext
];

/**
* Compiles the ASN.1 for the container
*
* @returns The ASN.1 DER data
*/
async function buildASN1(plaintext: Buffer, toEncryptedBox: false): Promise<Buffer>;
async function buildASN1(plaintext: Buffer, toEncryptedBox: true, algorithm: string, keys: Account[], cipherKey: Buffer, cipherIV: Buffer): Promise<Buffer>;
async function buildASN1(plaintext: Buffer, toEncryptedBox: boolean, algorithm?: string, keys?: Account[], cipherKey?: Buffer, cipherIV?: Buffer): Promise<Buffer>;
async function buildASN1(plaintext: Buffer, toEncryptedBox: boolean, algorithm?: string, keys?: Account[], cipherKey?: Buffer, cipherIV?: Buffer): Promise<Buffer> {
	const compressedPlaintext = await zlibDeflate(plaintext);

	const sequence: Partial<EncryptedContainerPackage> = [];

	/*
	 * Version v1 (0)
	 */
	sequence[0] = 0;

	/*
	 * Encrypted box or Plaintext box
	 */
	sequence[1] = toEncryptedBox;

	/*
	 * Encrypted container box
	 */
	if (sequence[1]) {
		if (keys === undefined || cipherKey === undefined || cipherIV === undefined || algorithm === undefined) {
			throw(new Error('internal error: Unsupported method invocation'));
		}

		const cipher = crypto.createCipheriv(
			algorithm,
			cipherKey,
			cipherIV
		);

		const encryptedData = Buffer.concat([
			cipher.update(compressedPlaintext),
			cipher.final()
		]);

		const cipherKeyArrayBuffer = bufferToArrayBuffer(cipherKey);

		const encryptionKeysSequence = await Promise.all(keys.map(async function(key) {
			const encryptedSymmetricKey = Buffer.from(await key.encrypt(cipherKeyArrayBuffer));
			const retval: EncryptedContainerKeyStore = [
				{
					type: 'bitstring',
					value: key.publicKeyAndType
				}, {
					type: 'bitstring',
					value: encryptedSymmetricKey
				}
			];

			return(retval);
		}));

		sequence[2] = [
			encryptionKeysSequence,
			cipherIV,
			encryptedData
		];
	} else {
		/*
		 * Otherwise we simply pass in the compressed data
		 */
		sequence[2] = [compressedPlaintext];
	}

	const outputASN1 = JStoASN1(sequence);
	const outputDER = Buffer.from(outputASN1.toBER(false));

	return(outputDER);
}

function parseASN1Bare(input: Buffer) {
	const inputSequence = ASN1toJS(bufferToArrayBuffer(input));
	if (!isArray(inputSequence, 3)) {
		throw(new Error('Malformed data detected (incorrect base format)'));
	}

	const version = inputSequence[0];
	if (typeof version !== 'bigint') {
		throw(new Error('Malformed data detected (version expected at position 0)'));
	}

	if (version !== BigInt(0)) {
		throw(new Error('Malformed data detected (unsupported version)'));
	}

	const isEncrypted = inputSequence[1];
	if (typeof isEncrypted !== 'boolean') {
		throw(new Error('Malformed data detected (encrypted flag expected at position 1)'));
	}

	const value: unknown = inputSequence[2];
	if (!Array.isArray(value)) {
		throw(new Error('Malformed data detected (data expected at position 2)'));
	}

	let containedCompressed: Buffer;
	let cipherInfo;
	if (isEncrypted) {
		if (!isArray(value, 3)) {
			throw(new Error('Malformed data (incorrect number of elements within position 2 -- expected 3)'));
		}

		const keyInfoUnchecked = value[0];
		if (!isArray(keyInfoUnchecked)) {
			throw(new Error('Malformed data (expected sequence at position 2.0)'));
		}

		const keyInfo = keyInfoUnchecked.map(function(checkKeyInfo) {
			if (!isArray(checkKeyInfo, 2)) {
				throw(new Error('Malformed key information (expected sequence of 2 at position 2.0.x)'));
			}

			const publicKeyWrapper = checkKeyInfo[0];
			if (!isASN1BitString(publicKeyWrapper)) {
				throw(new Error('Malformed key information (expected bitstring for public key at position 2.0.x)'));
			}

			const publicKeyBuffer = publicKeyWrapper.value;
			const publicKey = Account.fromPublicKeyAndType(publicKeyBuffer);

			const encryptedSymmetricKeyWrapper = checkKeyInfo[1];
			if (!isASN1BitString(encryptedSymmetricKeyWrapper)) {
				throw(new Error('Malformed key information (expected bitstring for cipher key at position 2.0.x)'));
			}

			const encryptedSymmetricKey = encryptedSymmetricKeyWrapper.value;

			return({
				publicKey,
				encryptedSymmetricKey
			});
		});


		const cipherIV = value[1];
		if (!Buffer.isBuffer(cipherIV)) {
			throw(new Error('Malformed data (cipher IV expected at position 2.1)'));
		}

		const encryptedCompressedValue = value[2];
		if (!Buffer.isBuffer(encryptedCompressedValue)) {
			throw(new Error('Malformed data (encrypted compressed buffer expected at position 2.2)'));
		}

		cipherInfo = {
			keys: keyInfo,
			cipherIV: cipherIV,
			encryptedData: encryptedCompressedValue
		};

		containedCompressed = encryptedCompressedValue;
	} else {
		if (!isArray(value, 1)) {
			throw(new Error('Malformed data (incorrect number of elements within position 2 -- expected 1)'));
		}

		const containedCompressedUnchecked = value[0];
		if (!Buffer.isBuffer(containedCompressedUnchecked)) {
			throw(new Error('Malformed data (compressed buffer expected at position 2.0)'));
		}

		containedCompressed = containedCompressedUnchecked;
	}

	return({
		version: version,
		isEncrypted: isEncrypted,
		innerValue: containedCompressed,
		...cipherInfo
	});
}

async function parseASN1Decrypt(inputInfo: ReturnType<typeof parseASN1Bare>, algorithm?: string, keys?: Account[]) {
	let containedCompressed: Buffer;
	let cipherInfo;
	if (inputInfo.isEncrypted) {
		if (keys === undefined || keys.length === 0) {
			throw(new Error('Encrypted Container found with encryption but no keys for decryption supplied'));
		}

		if (algorithm === undefined) {
			throw(new Error('Encrypted Container found with encryption but no algorithm supplied'));
		}

		const keyInfo = inputInfo.keys;
		if (keyInfo === undefined) {
			throw(new Error('internal error: Encrypted container found with missing keys'));
		}

		let decryptionKeyInfo;
		for (const checkKeyInfo of keyInfo) {
			for (const key of keys) {
				if (!key.hasPrivateKey) {
					continue;
				}

				if (key.comparePublicKey(checkKeyInfo.publicKey)) {
					decryptionKeyInfo = {
						...checkKeyInfo,
						privateKey: key
					};

					break;
				}
			}
		}

		if (decryptionKeyInfo === undefined) {
			throw(new Error('No keys found which can perform decryption on the supplied encryption box'));
		}

		const cipherKey = Buffer.from(await decryptionKeyInfo.privateKey.decrypt(bufferToArrayBuffer(decryptionKeyInfo.encryptedSymmetricKey)));

		const cipherIV = inputInfo.cipherIV;
		if (cipherIV === undefined) {
			throw(new Error('internal error: No Cipher IV found'));
		}

		const encryptedCompressedValue = inputInfo.innerValue;
		const decipher = crypto.createDecipheriv(algorithm, cipherKey, cipherIV);
		containedCompressed = Buffer.concat([
			decipher.update(encryptedCompressedValue),
			decipher.final()
		]);

		cipherInfo = {
			isEncrypted: true,
			keys: keyInfo,
			cipherIV: cipherIV,
			cipherKey: cipherKey,
			encryptedData: encryptedCompressedValue
		};
	} else {
		containedCompressed = inputInfo.innerValue;
		cipherInfo = {
			isEncrypted: false
		};
	}

	const plaintext = await zlibInflate(containedCompressed);

	return({
		version: inputInfo.version,
		plaintext: plaintext,
		...cipherInfo
	});

}

async function parseASN1(input: Buffer, algorithm?: string, keys?: Account[]) {
	const inputInfo = parseASN1Bare(input);
	const retval = await parseASN1Decrypt(inputInfo, algorithm, keys);

	return(retval);
}

export class EncryptedContainer {
	private static readonly algorithm = 'aes-256-cbc';

	/**
	 * Flag indicating whether we support exporting the plaintext
	 */
	#mayAccessPlaintext = true;

	/**
	 * Set of accounts which can access the data
	 */
	#principals: Account[];

	/**
	 * The plaintext/unencrypted data, if undefined then it has not been generated
	 */
	#plaintext: Buffer | undefined;

	/**
	 * The encrypted (and formatted) data, if undefined then it has not been generated
	 */
	#encrypted: Buffer | undefined;

	/**
	 * The symmetric cipher key
	 */
	#cipherKey?: Buffer;

	/**
	 * The symmetric cipher IV
	 */
	#cipherIV: Buffer | undefined;

	/**
	 * The symmetric cipher algorithm
	 */
	#cipherAlgo = EncryptedContainer.algorithm;

	/**
	 * A flag to indicate whether or not encryption is used for this box
	 * at all or not -- currently this will always be true
	 */
	#plaintextEncryptedBuffer = false;

	constructor(principals: Account[]) {
		this.#principals = principals;
		this.#plaintext = Buffer.alloc(0);
	}

	/**
	 * Create an instance of the EncryptedContainer from an encrypted blob,
	 * it will need to be decryptable with one of the specified principals
	 *
	 * After decryption happens, the list of principals with access to the
	 * resource will be reset to what is contained within the encrypted
	 * container
	 */
	static fromEncryptedBuffer(data: Buffer, principals: Account[]): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		retval.setEncryptedBuffer(data);
		retval.#computeAndSetKeyInfo();

		return(retval);
	}

	/**
	 * Create an instance of the EncryptedContainer from a plaintext.
	 * It will be decryptable by any one of the specified principals
	 */
	static fromPlaintext(data: string | Buffer, principals: Account[], locked = true): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		if (locked) {
			retval.disablePlaintext();
		}

		retval.setPlaintext(data);

		return(retval);
	}

	/**
	 * Set the plaintext to the specified value
	 */
	setPlaintext(data: string | Buffer): void {
		if (typeof data === 'string') {
			data = Buffer.from(data, 'utf-8');
		}

		this.#plaintext = data;
		this.#encrypted = undefined;
	}

	/**
	 * Set the encrypted blob to the specified value
	 */
	setEncryptedBuffer(data: Buffer): void {
		this.#encrypted = data;
		this.#plaintext = undefined;
	}

	/*
	 * Populate the symmetric key parameters from the encrypted blob
	 */
	#computeAndSetKeyInfo() {
		if (this.#encrypted === undefined) {
			throw(new Error('No encrypted data available'));
		}

		const plaintextWrapper = parseASN1Bare(this.#encrypted);

		/*
		 * Compute the new accounts by merging the input from the
		 * data and the existing list of principals
		 */
		/**
		 * The existing principals from the blob, with existing
		 * principals substituted in where appropriate
		 */
		const blobPrincipals = (plaintextWrapper.keys ?? []).map((keyInfo) => {
			const currentPublicKey = keyInfo.publicKey;
			if (!currentPublicKey.isAccount()) {
				throw(new Error('internal error: Non-account found within the encryption key list'));
			}

			for (const checkExistingKey of this.#principals) {
				if (checkExistingKey.comparePublicKey(currentPublicKey)) {
					return(checkExistingKey);
				}
			}

			return(currentPublicKey);
		});

		this.#cipherIV = plaintextWrapper?.cipherIV;
		this.#principals = blobPrincipals;

		return(plaintextWrapper);
	}

	/**
	 * Populate the plaintext (as well as symmetric key parameters) from
	 * the encrypted blob
	 */
	async #computePlaintext() {
		if (this.#plaintext !== undefined) {
			return(this.#plaintext);
		}

		if (this.#encrypted === undefined) {
			throw(new Error('No plaintext nor encrypted data available'));
		}

		const info = this.#computeAndSetKeyInfo();

		const plaintextWrapper = await parseASN1Decrypt(info, this.#cipherAlgo, this.#principals);
		const plaintext = plaintextWrapper.plaintext;

		return(plaintext);
	}

	/**
	 * Populate the encrypted blob from the plaintext and symmetric key
	 * parameters.  If the symmetric key parameters have not been
	 * initialized they will be initialized at this time.
	 */
	async #computeEncrypted() {
		if (this.#encrypted !== undefined) {
			return(this.#encrypted);
		}

		if (this.#plaintext === undefined) {
			throw(new Error('No encrypted nor plaintext data available'));
		}

		this.#cipherKey = crypto.randomBytes(32);
		this.#cipherIV = crypto.randomBytes(16);

		/**
		 * structured data is the ASN.1 encoded structure
		 */
		const structuredData = await buildASN1(
			this.#plaintext,
			!this.#plaintextEncryptedBuffer,
			this.#cipherAlgo,
			this.#principals,
			this.#cipherKey,
			this.#cipherIV
		);

		return(structuredData);
	}

	/**
	 * Grant access to the secret for account(s) synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	grantAccessSync(accounts: Account[] | Account): void {
		if (this.#plaintext === undefined) {
			throw(new Error('Unable to grant access, plaintext not available'));
		}

		this.#encrypted = undefined;

		if (!Array.isArray(accounts)) {
			accounts = [accounts];
		}

		this.#principals.push(...accounts);
	}

	/**
	 * Grant access to the secret for account(s).
	 */
	async grantAccess(accounts: Account[] | Account): Promise<void> {
		this.#plaintext = await this.#computePlaintext();

		this.grantAccessSync(accounts);
	}

	/**
	 * Revoke access to the secret for an account synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	revokeAccessSync(account: Account): void {
		if (this.#plaintext === undefined) {
			throw(new Error('Unable to revoke access, plaintext not available'));
		}

		this.#encrypted = undefined;

		this.#principals = this.#principals.filter(function(checkAccount) {
			return(!checkAccount.comparePublicKey(account));
		});
	}

	/**
	 * Revoke access to the secret for an account
	 */
	async revokeAccess(account: Account): Promise<void> {
		this.#plaintext = await this.#computePlaintext();
		this.revokeAccessSync(account);
	}

	/**
	 * Disable access to the plaintext from this instance
	 */
	disablePlaintext(): void {
		this.#mayAccessPlaintext = false;
	}

	async #getPlaintextInternal() {
		this.#plaintext = await this.#computePlaintext();

		if (this.#plaintext === undefined) {
			throw(new Error('internal error: Plaintext could not be decoded'));
		}

		/*
		 * Make a copy of our internal buffer so that any changes made
		 * to either our internal buffer or by our caller do not
		 * interfere
		 */
		return(Buffer.from(this.#plaintext));
	}

	/**
	 * Get the plaintext for this instance
	 */
	async getPlaintext(): Promise<Buffer> {
		if (!this.#mayAccessPlaintext) {
			throw(new Error('May not access plaintext'));
		}

		return(await this.#getPlaintextInternal());
	}

	/**
	 * Get the serializable encrypted buffer which can be stored and reconstructed
	 */
	async getEncryptedBuffer(): Promise<Buffer> {
		this.#encrypted = await this.#computeEncrypted();

		if (this.#encrypted === undefined) {
			throw(new Error('internal error: Encrypted could not be decoded'));
		}

		return(Buffer.from(this.#encrypted));
	}

	/**
	 * Get the list of accounts which have access to read the plaintext of
	 * this container
	 */
	get principals(): Account[] {
		return(this.#principals);
	}
}

/** @internal */
export const _Testing = {
	buildASN1: buildASN1,
	parseASN1: parseASN1
};

export default EncryptedContainer;
