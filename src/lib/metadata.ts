import * as zlib from 'zlib';
import * as crypto from 'crypto';

import BufferStorage from '@keetapay/keetanet-client/lib/utils/buffer';
import type { GenericAccount } from '@keetapay/keetanet-client/lib/account';
import type Account from '@keetapay/keetanet-client/lib/account';
import { bufferToArrayBuffer, isBuffer } from '@keetapay/keetanet-client/lib/utils/helper';
import {
	ASN1toJS,
	isValidSequenceSchema,
	JStoASN1
} from '@keetapay/keetanet-client/lib/utils/asn1';


/**
 * ASN.1 Schema
 *
 * NetworkMetadata DEFINITIONS AUTOMATIC TAGS ::=
 * BEGIN
 *	 KeyStore ::= SEQUENCE {
 *		 publicKey              BIT STRING,
 *		 encryptedSymmetricKey  BIT STRING
 *	 }
 *
 *	 Version	::= INTEGER { v1(0) }
 *
 *	 Metadata ::= SEQUENCE {
 *		 keys                 SEQUENCE OF KeyStore OPTIONAL,
 *		 initializationVector OCTET STRING OPTIONAL,
 *		 value                OCTET STRING
 *	 }
 *
 *	 MetadataPackage ::= SEQUENCE {
 *		 version      Version DEFAULT v1,
 *		 isEncrypted  BOOLEAN DEFAULT FALSE,
 *		 data         Metadata
 *	 }
 * END
 */
interface MetadataPackage {
	version: bigint;
	isEncrypted: boolean;
	data: Metadata;
}

interface KeyStore {
	publicKey: BufferStorage;
	symmetricKey: BufferStorage;
}

export interface Metadata {
	keys: KeyStore[];
	iv?: ArrayBuffer;
	value: string;
}

type EncryptedMetadataASN1Schema = [
	[ASN1BitString, ASN1BitString][],
	Buffer,
	Buffer
];

type NetworkMetadataASN1Schema = [bigint, boolean, EncryptedMetadataASN1Schema | PlaintextMetadataASN1Schema];

type PlaintextMetadataASN1Schema = [Buffer];
type KeyStoreASN1Schema = [Buffer, Buffer];

/**
 * XXX:TODO ASN.1 utils should export this
 */
interface ASN1BitString {
	type: 'bitstring';
	value: Buffer;
}

function isValidKeyStoreASN1Schema(input: unknown): input is KeyStoreASN1Schema {
	if (!Array.isArray(input)) {
		return(false);
	}

	if (input.length !== 2) {
		return(false);
	}

	// Public key
	if (typeof input[0] !== 'object' || input[0].type !== 'bitstring') {
		return(false);
	}

	// Symmetric key
	if (typeof input[1] !== 'object' || input[1].type !== 'bitstring') {
		return(false);
	}

	return(true);
}

function isValidPlaintextMetadataASN1Schema(input: unknown): input is PlaintextMetadataASN1Schema {
	if (!Array.isArray(input)) {
		return(false);
	}

	if (input.length !== 1) {
		return(false);
	}

	// Data
	if (!isBuffer(input[0])) {
		return(false);
	}

	return(true);
}

function isValidEncryptedMetadataASN1Schema(input: unknown): input is EncryptedMetadataASN1Schema {
	if (!Array.isArray(input)) {
		return(false);
	}

	if (input.length !== 3) {
		return(false);
	}

	// Encryption keys
	if (!Array.isArray(input[0])) {
		return(false);
	} else {
		for (const key of input[0]) {
			if (!isValidKeyStoreASN1Schema(key)) {
				return(false);
			}
		}
	}

	// Initialization Vector
	if (!isBuffer(input[1])) {
		return(false);
	}

	// Data
	if (!isBuffer(input[2])) {
		return(false);
	}

	return(true);
}

function isValidNetworkMetadataSchema(input: any): input is NetworkMetadataASN1Schema {
	if (!input || !Array.isArray(input) || input[0] === undefined) {
		return(false);
	}

	if (input[0] !== BigInt(0)) {
		return(false);
	}

	return(isValidSequenceSchema(input, [
		(val) => typeof val === 'bigint',
		(val) => typeof val === 'boolean',
		input[1]
			? isValidEncryptedMetadataASN1Schema
			: isValidPlaintextMetadataASN1Schema
	]));
}

function findIndexesOfKeyInKeyStores(keys: KeyStore[], account: GenericAccount) {
	const foundIndexes = [];

	for (let index = 0; index < keys.length; index++) {
		const publicKey = keys[index].publicKey.getBuffer();

		if (Buffer.compare(publicKey, account.publicKey.getBuffer()) === 0) {
			foundIndexes.push(index);
		}
	}

	return(foundIndexes);
}

export class MetadataStore implements MetadataPackage {
	static readonly algorithm = 'aes-256-cbc';

	#data: Metadata;
	#_encryptionKey?: ArrayBuffer;

	readonly version: bigint = BigInt(0);

	get #encryptionKey() {
		if (!this.#_encryptionKey) {
			if (this.isEncrypted) {
				throw new Error('Encryption key should not be set if data is not encrypted');
			} else {
				throw new Error('Data is not encrypted, cannot get encryption key');
			}
		}

		return(this.#_encryptionKey);
	}

	constructor(data: Metadata, encryptionKey?: ArrayBuffer) {
		this.#data = data;

		if (this.#data.keys.length > 0 && !encryptionKey) {
			throw new Error('Encryption key must be defined if constructing metadata store with encrypted data');
		}
	}

	static async createFromPlainText(data: string, encryptFor: Account[] = []) {
		const created = new this({ value: data, keys: [] });

		for (const account of encryptFor) {
			await created.grantAccess(account);
		}

		return(created);
	}

	get isEncrypted(): boolean {
		return(this.#data.keys.length > 0);
	}

	get data(): Metadata {
		return(this.#data);
	}

	/**
	 * Creates a simple encryption key from random bytes.
	 *
	 * @returns The encryption key
	 */
	static #generateEncryptionKey(): ArrayBuffer {
		return(bufferToArrayBuffer(crypto.randomBytes(32)));
	}

	/**
	 * Gets the decrypted encryption key from the encrypted keys array.
	 *
	 * @returns The encryption key
	 */
	private static async decryptKey(
		principals: Account[],
		keys: KeyStore[]
	): Promise<{ principal: Account, key: ArrayBuffer }> {
		for (const principal of principals) {
			if (!principal.hasPrivateKey) {
				continue;
			}

			const foundKeyMatches = findIndexesOfKeyInKeyStores(keys, principal);

			for (const tryKeyIndex of foundKeyMatches) {
				const tryKey = keys[tryKeyIndex];

				const symmetricKey = bufferToArrayBuffer(tryKey.symmetricKey.getBuffer());
				try {
					const key = await principal.decrypt(symmetricKey);
					return({ principal, key });
				} catch (e) {
					throw new Error(`Unable to decrypt metadata encryption key: ${e}`);
				}
			}
		}

		throw new Error('Unable to decrypt metadata encryption key');
	}

	/**
	 * Gets the metadata value and zlib compresses it.
	 *
	 * @returns The deflated data
	 */
	private getCompressedData(): ArrayBuffer {
		const bufferData = Buffer.from(this.data.value, 'utf-8');
		const compressedData = zlib.deflateSync(bufferData);

		return(bufferToArrayBuffer(compressedData));
	}

	/**
	 * Encrypts the metadata object with the given key and sets the object's iv.
	 *
	 * @returns The encrypted metadata and the initialization vector
	 */
	private encryptData(data: ArrayBuffer, key: ArrayBuffer): { data: ArrayBuffer; iv: ArrayBuffer } {
		const initializationVector = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv(
			MetadataStore.algorithm,
			Buffer.from(key),
			initializationVector
		);

		const encryptedData = Buffer.concat([
			cipher.update(Buffer.from(data)),
			cipher.final()
		]);

		this.data.iv = bufferToArrayBuffer(initializationVector);

		return({
			data: bufferToArrayBuffer(encryptedData),
			iv: this.data.iv
		});
	}

	/**
	 * Decrypts and inflates the metadata object.
	 *
	 * @returns The decrypted metadata
	 */
	private static async decryptData(
		principals: Account[],
		encryptedData: ArrayBuffer,
		initializationVector: ArrayBuffer,
		encryptedKeys: KeyStore[]
	): Promise<{ data: ArrayBuffer, decryptedKey: ArrayBuffer }> {
		const decryptedKey = await MetadataStore.decryptKey(principals, encryptedKeys);
		const initVector = Buffer.from(initializationVector);
		const decipher = crypto.createDecipheriv(MetadataStore.algorithm, Buffer.from(decryptedKey.key), initVector);
		const encryptedBufferData = Buffer.from(encryptedData);
		const decryptedData = Buffer.concat([
			decipher.update(encryptedBufferData),
			decipher.final()
		]);

		return({
			data: bufferToArrayBuffer(decryptedData),
			decryptedKey: decryptedKey.key
		});
	}

	/**
	 * Builds a Keystore object from the public key and the encrypted key.
	 *
	 * @returns The Keystore object
	 */
	private static buildKeyStore(publicKey: ArrayBuffer, encryptedKey: ArrayBuffer): KeyStore {
		return({
			publicKey: new BufferStorage(publicKey, publicKey.byteLength),
			symmetricKey: new BufferStorage(encryptedKey, encryptedKey.byteLength)
		});
	}

	/**
	 * Get the array of the encryption keys.
	 *
	 * @returns The encrypted key array
	 */
	private getEncryptionKeysSequence(): [ASN1BitString, ASN1BitString][] {
		const encryptionKeysSequence: [ASN1BitString, ASN1BitString][] = [];

		for (const key of this.data.keys) {
			encryptionKeysSequence.push([
				// Public Key
				{
					type: 'bitstring',
					value: key.publicKey.getBuffer()
				},
				// Symmetric Key
				{
					type: 'bitstring',
					value: key.symmetricKey.getBuffer()
				}
			]);
		}

		return(encryptionKeysSequence);
	}

	/**
	 * Compiles the ASN.1 for the metadata object.
	 *
	 * @returns The ASN.1 BER data
	 */
	private async buildASN1(): Promise<ArrayBuffer> {
		const compressedData = this.getCompressedData();
		const sequence: Partial<NetworkMetadataASN1Schema> = [];
		const dataSequence: Partial<EncryptedMetadataASN1Schema> = [];

		sequence.push(this.version);

		let finalData: ArrayBuffer;

		const isEncrypted = this.isEncrypted;

		sequence.push(isEncrypted);

		if (isEncrypted) {
			const encryptionKeysSequence = this.getEncryptionKeysSequence();
			const { data, iv } = this.encryptData(compressedData, this.#encryptionKey);

			dataSequence.push(encryptionKeysSequence);
			dataSequence.push(Buffer.from(iv));

			finalData = data;
		} else {
			finalData = compressedData;
		}

		dataSequence.push(Buffer.from(finalData));

		if (!isValidEncryptedMetadataASN1Schema(dataSequence) && !isValidPlaintextMetadataASN1Schema(dataSequence)) {
			throw new Error('internal error: Constructed invalid data schema');
		}

		sequence.push(dataSequence);

		if (!isValidNetworkMetadataSchema(sequence)) {
			throw new Error('internal error: Constructed invalid metadata sequence');
		}

		return(JStoASN1(sequence).toBER(false));
	}

	/**
	 * Create a NetworkMetadataStore using an account and the BER data.
	 * XXX:TODO Handle versioning
	 *
	 * @returns The NetworkMetadataStore
	 */
	static async fromData(
		data: ArrayBuffer | string,
		principals?: Account[]
	): Promise<MetadataStore> {
		if (typeof data === 'string') {
			data = 	bufferToArrayBuffer(Buffer.from(data, 'base64'));
		}

		const sequence = ASN1toJS(data);

		if (!isValidNetworkMetadataSchema(sequence)) {
			throw new Error('Invalid ASN.1 Sequence: Invalid schema');
		}

		const isEncrypted = sequence[1];
		const sequenceData = sequence[2];

		let initializationVector: ArrayBuffer | undefined;
		let encryptedKeys: KeyStore[];
		let bufferData;
		let decryptedKey: ArrayBuffer | undefined;
		if (isEncrypted) {
			if (principals === undefined || principals.length < 1) {
				throw new Error('Principal is required to decrypt the metadata');
			}

			/*
			 * We can safely assert the type is EncryptedMetadataASN1Schema
			 * because we narrowed it before -- TypeScript just can't
			 * follow the flow in reverse to narrow it for us.
			 */
			// eslint-disable-next-line no-type-assertion/no-type-assertion
			const schemaData = sequenceData as EncryptedMetadataASN1Schema;
			const encryptedData = bufferToArrayBuffer(schemaData[2]);

			encryptedKeys = [];
			for (const asn1key of schemaData[0]) {
				const [publicKey, encryptedKey] = asn1key;
				const publicKeyBuffer = bufferToArrayBuffer(publicKey.value);
				const encryptedKeyBuffer = bufferToArrayBuffer(encryptedKey.value);

				encryptedKeys.push(MetadataStore.buildKeyStore(publicKeyBuffer, encryptedKeyBuffer));
			}

			initializationVector = bufferToArrayBuffer(schemaData[1]);
			({ data: bufferData, decryptedKey } = await MetadataStore.decryptData(
				principals,
				encryptedData,
				initializationVector,
				encryptedKeys
			));
		} else {
			/*
			 * We can safely assert the type is PlaintextMetadataASN1Schema
			 * because we narrowed it before -- TypeScript just can't
			 * follow the flow in reverse to narrow it for us.
			 */
			// eslint-disable-next-line no-type-assertion/no-type-assertion
			const schemaData = sequenceData as PlaintextMetadataASN1Schema;
			bufferData = bufferToArrayBuffer(schemaData[0]);
			encryptedKeys = [];
		}

		const decompressedData = zlib.inflateSync(Buffer.from(bufferData)).toString('utf-8');

		return(new MetadataStore({
			keys: encryptedKeys,
			iv: initializationVector,
			value: decompressedData
		}, decryptedKey));
	}

	/**
	 * Decrypts the encryption key and encrypts it with the provided account's
	 * public key. The new encrypted key is then added to the list of keys.
	 */
	async grantAccess(account: Account) {
		if (!account.supportsEncryption) {
			throw new Error('The account does not support encryption');
		}

		if (this.data.keys.length > 0) {
			// Account is already added
			if (findIndexesOfKeyInKeyStores(this.data.keys, account).length > 0) {
				return;
			}
		}

		if (!this.#_encryptionKey) {
			this.#_encryptionKey = MetadataStore.#generateEncryptionKey();
		}

		const publicKey = bufferToArrayBuffer(account.publicKey.getBuffer());
		const encryptedKey = await account.encrypt(this.#_encryptionKey);

		this.data.keys.push(MetadataStore.buildKeyStore(publicKey, encryptedKey));
	}

	checkAccountHasAccess(account: Account) {
		const found = findIndexesOfKeyInKeyStores(this.data.keys, account);

		if (found.length > 1) {
			// XXX:TODO What to do here
		}

		return(found.length > 0);
	}

	/**
	 * Revokes the key to the metadata for the specified account.
	 */
	async revokeAccess(account: GenericAccount): Promise<void> {
		if (this.data.keys.length === 0) {
			return;
		}

		const foundMatches = findIndexesOfKeyInKeyStores(this.data.keys, account);

		if (this.data.keys.length - foundMatches.length <= 0) {
			throw new Error('Cannot revoke access to last account');
		}

		let removedCount = 0;
		for (const index of foundMatches) {
			this.data.keys.splice(index - removedCount, 1);
			removedCount++;
		}
	}

	/**
	 * Builds and encrypts (if supported) the metadata to a base64 encoded string
	 * for the specified account.
	 *
	 * @returns The base64 encoded string
	 */
	async build(asBuffer: true): Promise<Buffer>;
	async build(asBuffer?: false): Promise<string>;
	async build(asBuffer?: boolean) {
		const sequence = await this.buildASN1();

		const buf = Buffer.from(sequence);

		if (asBuffer) {
			return(buf);
		}

		return(buf.toString('base64'));
	}
}
