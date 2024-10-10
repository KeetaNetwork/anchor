import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as util from 'node:util';

import { Account } from '@keetapay/keetanet-node/dist/lib/account.js';
import {
	ASN1toJS,
	JStoASN1
} from '@keetapay/keetanet-node/dist/lib/utils/asn1.js';
import type {
	ASN1OID
} from '@keetapay/keetanet-node/dist/lib/utils/asn1.js';
import { bufferToArrayBuffer } from '@keetapay/keetanet-node/dist/lib/utils/helper.js';
import { isArray } from './utils/array.js';

const zlibDeflate = util.promisify(zlib.deflate);
const zlibInflate = util.promisify(zlib.inflate);

/*
 * ASN.1 Schema
 *
 * EncryptedContainer DEFINITIONS ::=
 * BEGIN
 *         Version        ::= INTEGER { v2(1) }
 * 
 *         KeyStore ::= SEQUENCE {
 *                 publicKey              OCTET STRING,
 *                 encryptedSymmetricKey  OCTET STRING,
 *                 ...
 *         }
 * 
 *         EncryptedContainerBox ::= SEQUENCE {
 *                 keys                   SEQUENCE OF KeyStore,
 *                 encryptionAlgorithm    OBJECT IDENTIFIER,
 *                 initializationVector   OCTET STRING,
 *                 encryptedValue         OCTET STRING,
 *                 ...
 *         }
 * 
 *         PlaintextContainerBox ::= SEQUENCE {
 *                 plainValue             OCTET STRING,
 *                 ...
 *         }
 * 
 *         ContainerPackage ::= SEQUENCE {
 *                 version                Version (v2),
 *                 encryptedContainer     [0] EXPLICIT EncryptedContainerBox OPTIONAL,
 *                 plaintextContainer     [1] EXPLICIT PlaintextContainerBox OPTIONAL,
 *                 ...
 *         } (WITH COMPONENTS {
 *                 encryptedContainer PRESENT,
 *                 plaintextContainer ABSENT
 *         } |
 *         WITH COMPONENTS {
 *                 encryptedContainer ABSENT,
 *                 plaintextContainer PRESENT
 *         })
 * END
 * 
 */

type EncryptedContainerKeyStore = [
	/* publicKey */
	Buffer,

	/* encryptedSymmetricKey */
	Buffer
];

type EncryptedContainerBoxEncrypted = [
	/* keys */
	EncryptedContainerKeyStore[],

	/* encryptionAlgorithm */
	ASN1OID,

	/* initializationVector */
	Buffer,

	/* value */
	Buffer
];

type EncryptedContainerBoxPlaintext = [
	/* value */
	Buffer
];

type ContainerPackage = [
	/* version */
	number,

	{
		type: 'context'
		value: 0,
		contains: EncryptedContainerBoxEncrypted
	} | {
		type: 'context',
		value: 1,
		contains: EncryptedContainerBoxPlaintext
	}
];

type CipherOptions = {
	/**
	 * The symmetric cipher key (if any)
	 */
	cipherKey: Buffer | undefined;
	/**
	 * The symmetric cipher IV (if any)
	 */
	cipherIV: Buffer | undefined;
	/**
	 * The symmetric cipher algorithm
	 */
	cipherAlgo: string;
}

type ASN1Options = Required<CipherOptions> & {
	/**
	 * The set of accounts to encrypt the formatted data
	 */
	keys: Account[];
}

const oidDB = {
	'aes-256-cbc': '2.16.840.1.101.3.4.1.42'
} as const;

/**
* Compiles the ASN.1 for the container
*
* @returns The ASN.1 DER data
*/
async function buildASN1(plaintext: Buffer, encryptionOptions?: ASN1Options): Promise<Buffer> {
	const compressedPlaintext = await zlibDeflate(plaintext);

	const sequence: Partial<ContainerPackage> = [];

	/*
	 * Version v2 (1)
	 */
	sequence[0] = 1;

	/*
	 * Encrypted container box
	 */
	if (encryptionOptions) {
		const { keys, cipherKey, cipherIV, cipherAlgo } = encryptionOptions;

		if (keys === undefined || keys.length === 0 || cipherKey === undefined || cipherIV === undefined || cipherAlgo === undefined) {
			throw(new Error('internal error: Unsupported method invocation'));
		}

		if (!(cipherAlgo in oidDB)) {
			throw(new Error(`Unsupported algorithm: ${cipherAlgo}`));
		}

		const algorithmOID = oidDB[cipherAlgo as keyof typeof oidDB];

		const cipher = crypto.createCipheriv(
			cipherAlgo,
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
				key.publicKeyAndType,
				encryptedSymmetricKey
			];

			return(retval);
		}));

		sequence[1] = {
			type: 'context',
			value: 0,
			contains: [
				encryptionKeysSequence,
				{ type: 'oid', oid: algorithmOID },
				cipherIV,
				encryptedData
			]
		};
	} else {
		/*
		 * Otherwise we simply pass in the compressed data
		 */
		sequence[1] = {
			type: 'context',
			value: 1,
			contains: [compressedPlaintext]
		};
	}

	const outputASN1 = JStoASN1(sequence);
	const outputDER = Buffer.from(outputASN1.toBER(false));

	return(outputDER);
}

function parseASN1Bare(input: Buffer, acceptableEncryptionAlgorithms = ['aes-256-cbc', 'null']) {
	const inputSequence = ASN1toJS(bufferToArrayBuffer(input));
	if (!isArray(inputSequence, 2)) {
		throw(new Error('Malformed data detected (incorrect base format)'));
	}

	const version = inputSequence[0];
	if (typeof version !== 'bigint') {
		throw(new Error('Malformed data detected (version expected at position 0)'));
	}

	if (version !== BigInt(1)) {
		throw(new Error('Malformed data detected (unsupported version)'));
	}

	const valueBox = inputSequence[1];
	if (typeof valueBox !== 'object' || valueBox === null) {
		throw(new Error('Malformed data detected (data expected at position 1)'));
	}

	if (!('type' in valueBox) || typeof valueBox.type !== 'string') {
		throw(new Error('Malformed data detected (expected type at position 1)'));
	}

	if (valueBox.type !== 'context') {
		throw(new Error('Malformed data detected (expected context at position 1)'));
	}

	if (!('value' in valueBox) || typeof valueBox.value !== 'number') {
		throw(new Error('Malformed data detected (expected context value at position 1)'));
	}

	if (valueBox.value !== 0 && valueBox.value !== 1) {
		throw(new Error('Malformed data detected (expected context value of 0 or 1)'));
	}

	if (!('contains' in valueBox) || typeof valueBox.contains !== 'object' || valueBox.contains === null) {
		throw(new Error('Malformed data detected (expected contents at position 1)'));
	}

	let isEncrypted;
	if (valueBox.value === 0) {
		isEncrypted = true;
	} else {
		isEncrypted = false;
	}

	const value = valueBox.contains;
	let containedCompressed: Buffer;
	let cipherInfo;
	if (isEncrypted) {
		if (!isArray(value, 4)) {
			throw(new Error('Malformed data (incorrect number of elements within position 1 -- expected 4)'));
		}

		const keyInfoUnchecked = value[0];
		if (!isArray(keyInfoUnchecked)) {
			throw(new Error('Malformed data (expected sequence at position 2.0)'));
		}

		const keyInfo = keyInfoUnchecked.map(function(checkKeyInfo) {
			if (!isArray(checkKeyInfo, 2)) {
				throw(new Error('Malformed key information (expected sequence of 2 at position 1.0.x)'));
			}

			const publicKeyBuffer = checkKeyInfo[0];
			if (!Buffer.isBuffer(publicKeyBuffer)) {
				throw(new Error('Malformed key information (expected octet string for public key at position 1.0.x)'));
			}
			const publicKey = Account.fromPublicKeyAndType(publicKeyBuffer);

			const encryptedSymmetricKey = checkKeyInfo[1];
			if (!Buffer.isBuffer(encryptedSymmetricKey)) {
				throw(new Error('Malformed key information (expected octet string for cipher key at position 1.0.x)'));
			}

			return({
				publicKey,
				encryptedSymmetricKey
			});
		});

		const encryptionAlgorithmOID = value[1];
		/* XXX:TODO */
		const encryptionAlgorithm = 'aes-256-cbc';

		const cipherIV = value[2];
		if (!Buffer.isBuffer(cipherIV)) {
			throw(new Error('Malformed data (cipher IV expected at position 1.2)'));
		}

		const encryptedCompressedValue = value[3];
		if (!Buffer.isBuffer(encryptedCompressedValue)) {
			throw(new Error('Malformed data (encrypted compressed buffer expected at position 1.3)'));
		}

		cipherInfo = {
			keys: keyInfo,
			cipherIV: cipherIV,
			encryptedData: encryptedCompressedValue,
			encryptionAlgorithm: encryptionAlgorithm
		};

		containedCompressed = encryptedCompressedValue;
	} else {
		if (!isArray(value, 1)) {
			throw(new Error('Malformed data (incorrect number of elements within position 1 -- expected 1)'));
		}

		const containedCompressedUnchecked = value[0];
		if (!Buffer.isBuffer(containedCompressedUnchecked)) {
			throw(new Error('Malformed data (compressed buffer expected at position 1.0)'));
		}

		if (!acceptableEncryptionAlgorithms.includes('null')) {
			throw(new Error('Malformed data (plaintext found but the null encryption algorithm is not acceptable)'));
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

async function parseASN1Decrypt(inputInfo: ReturnType<typeof parseASN1Bare>, keys?: Account[]) {
	let containedCompressed: Buffer;
	let cipherInfo;
	if (inputInfo.isEncrypted) {
		if (keys === undefined || keys.length === 0) {
			throw(new Error('Encrypted Container found with encryption but no keys for decryption supplied'));
		}

		const algorithm = inputInfo.encryptionAlgorithm;
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

async function parseASN1(input: Buffer, keys?: Account[]) {
	const inputInfo = parseASN1Bare(input);
	const retval = await parseASN1Decrypt(inputInfo, keys);

	return(retval);
}



type EncryptedContainerInfo = Pick<CipherOptions, 'cipherAlgo'> & {
	/**
	 * Set of accounts which can access the data
	 */
	principals: Account[];
}

type UnencryptedContainerInfo = {
	/**
	 * Unencrypted container should not have any principals
	 */
	principals: null;
}

export class EncryptedContainer {
	private static readonly algorithm = 'aes-256-cbc';

	/**
	 * Flag indicating whether we support exporting the plaintext
	 */
	#mayAccessPlaintext = true;

	/**
	 * Encryption details
	 */
	protected _internalState: EncryptedContainerInfo | UnencryptedContainerInfo;

	/**
	 * The plaintext or encoded (and possibly encrypted) data
	 */
	#data:
		{ plaintext: Buffer } |
		{ encoded: Buffer } |
		{ plaintext: Buffer, encoded: Buffer };

	constructor(principals: Account[] | null) {
		if (principals === null) {
			this._internalState = {
				principals: null
			};
		} else {
			this._internalState = {
				principals: principals,
				cipherAlgo: EncryptedContainer.algorithm
			}
		};
		this.#data = { plaintext: Buffer.alloc(0) };
	}

	get encrypted(): boolean {
		return(this._internalState.principals !== null);
	}

	#isEncrypted(): this is { _internalState: EncryptedContainerInfo } {
		return(this.encrypted);
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

		retval.#setEncodedBuffer(data);
		retval.#computeAndSetKeyInfo(true);

		return(retval);
	}

	static fromEncodedBuffer(data: Buffer, principals: Account[] | null): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		retval.#setEncodedBuffer(data);
		retval.#computeAndSetKeyInfo(false);

		return(retval);
	}

	/**
	 * Create an instance of the EncryptedContainer from a plaintext.
	 *
	 * It will be decryptable by any one of the specified principals
	 *
	 * @param data The plaintext data to encrypt or encode
	 * @param principals The list of principals who can access the data if it is null then the data is not encrypted
	 * @param locked If true, the plaintext data will not be accessible from this instance; otherwise it will be -- default depends on principals
	 * @returns The EncryptedContainer instance with the plaintext data and principals set
	 */
	static fromPlaintext(data: string | Buffer, principals: Account[] | null, locked?: boolean): EncryptedContainer {
		const retval = new EncryptedContainer(principals);

		if (locked === undefined) {
			locked = true;
			if (principals === null) {
				locked = false;
			}
		}

		if (locked) {
			retval.disablePlaintext();
		}

		retval.setPlaintext(data);

		return(retval);
	}

	/**
	 * Set the plaintext buffer to the specified value
	 */
	setPlaintext(data: string | Buffer): void {
		if (typeof data === 'string') {
			data = Buffer.from(data, 'utf-8');
		}

		this.#data = { plaintext: data };
	}

	/**
	 * Set the encoded blob to the specified value
	 */
	#setEncodedBuffer(data: Buffer): void {
		this.#data = { encoded: data };
	}

	private get _encoded(): Buffer | undefined {
		if ('encoded' in this.#data && this.#data.encoded !== undefined) {
			return(this.#data.encoded);
		}

		return(undefined);
	}

	private get _plaintext(): Buffer | undefined {
		if ('plaintext' in this.#data && this.#data.plaintext !== undefined) {
			return(this.#data.plaintext);
		}

		return(undefined);
	}

	/*
	 * Return the decoded data from the encoded blob
	 * and populate the symmetric key parameters from the encoded blob if it is encrypted
	 */
	#computeAndSetKeyInfo(mustBeEncrypted: boolean) {
		if (this._encoded === undefined) {
			throw(new Error('No encoded data available'));
		}

		const plaintextWrapper = parseASN1Bare(this._encoded);

		if (mustBeEncrypted && !plaintextWrapper.isEncrypted) {
			throw(new Error('Unable to set key information from plaintext -- it is not encrypted but that was required'));
		}

		if (plaintextWrapper.isEncrypted) {
			const principals = this._internalState.principals;
			if (principals === null) {
				throw(new Error('May not encrypt data with a null set of principals'));
			}

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

				for (const checkExistingKey of principals) {
					if (checkExistingKey.comparePublicKey(currentPublicKey)) {
						return(checkExistingKey);
					}
				}

				return(currentPublicKey);
			});

			this._internalState.principals = blobPrincipals;

			// Confirm updated principals are populated correctly which sets container to encrypted
			if (this.encrypted !== true) {
				throw(new Error('internal error: Encrypted data found but not marked as encrypted'));
			}
		} else {
			this._internalState.principals = null;

			if (this.encrypted !== false) {
				throw(new Error('internal error: Plaintext data found but marked as encrypted'));
			}
		}

		return(plaintextWrapper);
	}

	/**
	 * Populate the plaintext (as well as symmetric key parameters) from
	 * the encoded blob
	 */
	async #computePlaintext() {
		if (this._plaintext) {
			return(this._plaintext);
		}

		if (this._encoded === undefined) {
			throw(new Error('No plaintext or encoded data available'));
		}


		const info = this.#computeAndSetKeyInfo(this.encrypted);

		let principals = this._internalState.principals;
		if (info.isEncrypted) {
			if (principals === null) {
				throw(new Error('May not decrypt data with a null set of principals'));
			}
		} else {
			principals = [];
		}

		const plaintextWrapper = await parseASN1Decrypt(info, principals);
		const plaintext = plaintextWrapper.plaintext;

		this.#data = { ...this.#data, plaintext };

		return(plaintext);
	}

	/**
	 * Compute the encoded version of the plaintext data
	 */
	async #computePlaintextEncoded() {
		if (this._plaintext === undefined) {
			throw(new Error('No plaintext data available'));
		}

		const structuredData = await buildASN1(
			this._plaintext
		);

		return(structuredData);
	}

	/**
	 * Populate the encrypted blob from the plaintext and symmetric key
	 * parameters.  If the symmetric key parameters have not been
	 * initialized they will be initialized at this time.
	 */
	async #computeEncryptedEncoded() {
		if (this._plaintext === undefined) {
			throw(new Error('No encrypted nor plaintext data available'));
		}

		if (!this.#isEncrypted()) {
			throw(new Error('internal error: Asked to encrypt a plaintext buffer'));
		}

		/**
		 * structured data is the ASN.1 encoded structure
		 */
		const structuredData = await buildASN1(
			this._plaintext,
			{
				keys: this._internalState.principals,
				cipherKey: crypto.randomBytes(32),
				cipherIV: crypto.randomBytes(16),
				cipherAlgo: this._internalState.cipherAlgo
			}
		);

		this.#data = { ...this.#data, encoded: structuredData };

		return(structuredData);
	}

	async #computeEncoded() {
		if (this._encoded !== undefined) {
			return(this._encoded);
		}

		if (!this.encrypted) {
			return(await this.#computePlaintextEncoded());
		} else {
			return(await this.#computeEncryptedEncoded());
		}
	}

	/**
	 * Grant access to the secret for account(s) synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	grantAccessSync(accounts: Account[] | Account): void {
		if (this._plaintext === undefined) {
			throw(new Error('Unable to grant access, plaintext not available'));
		}

		if (!this.#isEncrypted()) {
			throw(new Error('May not manage access to a plaintext container'));
		}

		if (!Array.isArray(accounts)) {
			accounts = [accounts];
		}

		// Encoded data is invalidated with the new permissions so set only the plaintext data
		this.setPlaintext(this._plaintext);

		this._internalState.principals.push(...accounts);
	}

	/**
	 * Grant access to the secret for account(s).
	 */
	async grantAccess(accounts: Account[] | Account): Promise<void> {
		await this.#computePlaintext();

		this.grantAccessSync(accounts);
	}

	/**
	 * Revoke access to the secret for an account synchronously.  This
	 * assumes the plaintext has already been computed and will fail
	 * if it is not
	 */
	revokeAccessSync(account: Account): void {
		if (this._plaintext === undefined) {
			throw(new Error('Unable to revoke access, plaintext not available'));
		}

		if (!this.#isEncrypted()) {
			throw(new Error('May not manage access to a plaintext container'));
		}

		// Encoded data is invalidated with the new permissions so set only the plaintext data
		this.setPlaintext(this._plaintext);

		this._internalState.principals = this._internalState.principals.filter(function(checkAccount) {
			return(!checkAccount.comparePublicKey(account));
		});
	}

	/**
	 * Revoke access to the secret for an account
	 */
	async revokeAccess(account: Account): Promise<void> {
		await this.#computePlaintext();

		this.revokeAccessSync(account);
	}

	/**
	 * Disable access to the plaintext from this instance
	 */
	disablePlaintext(): void {
		this.#mayAccessPlaintext = false;
	}

	/**
	 * Get the plaintext for this instance
	 */
	async getPlaintext(): Promise<Buffer> {
		if (!this.#mayAccessPlaintext) {
			throw(new Error('May not access plaintext'));
		}

		const plaintext = await this.#computePlaintext();

		if (plaintext === undefined) {
			throw(new Error('internal error: Plaintext could not be decoded'));
		}

		/*
		 * Make a copy of our internal buffer so that any changes made
		 * to either our internal buffer or by our caller do not
		 * interfere
		 */
		return(Buffer.from(plaintext));
	}

	/**
	 * Get the serializable buffer which can be stored and reconstructed
	 */
	async getEncodedBuffer(): Promise<Buffer> {
		const serialized = await this.#computeEncoded();

		if (serialized === undefined) {
			throw(new Error('internal error: Could not encode data'));
		}

		/*
		 * Make a copy of our internal buffer so that any changes made
		 * to either our internal buffer or by our caller do not
		 * interfere
		 */
		return(Buffer.from(serialized));
	}

	/**
	 * Get the list of accounts which have access to read the plaintext of
	 * this container
	 */
	get principals(): Account[] {
		if (!this.#isEncrypted()) {
			throw(new Error('May not manage access to a plaintext container'));
		}

		return(this._internalState.principals);
	}
}

/** @internal */
export const _Testing = {
	buildASN1: buildASN1,
	parseASN1: parseASN1
};

export default EncryptedContainer;
