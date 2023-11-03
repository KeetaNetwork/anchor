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
import AnchorMetadataError from './error/metadata';


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

export type EncryptedMetadataWithoutHeader = [
	// Boolean indicating that the data is not encrypted
	true,
	// The compressed un-encrypted data
	EncryptedMetadataASN1Schema
];

export type PlaintextMetadataWithoutHeader = [
	// Boolean indicating that the data is not encrypted
	false,
	// The compressed un-encrypted data
	PlaintextMetadataASN1Schema
];

export type NetworkMetadataASN1Schema = [
	// The version of the metadata schema
	bigint,
	...(EncryptedMetadataWithoutHeader | PlaintextMetadataWithoutHeader)
];

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

	for (const value of input) {
		if (typeof value !== 'object' || value.type !== 'bitstring') {
			return(false);
		}
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
				throw new AnchorMetadataError('METADATA_ENCRYPTION_KEY_INVALID_SET', 'Encryption key should not be set if data is not encrypted');
			} else {
				throw new AnchorMetadataError('METADATA_ENCRYPTION_KEY_REQUIRED', 'Data is not encrypted, cannot get encryption key');
			}
		}

		return(this.#_encryptionKey);
	}

	constructor(data: Metadata, encryptionKey?: ArrayBuffer) {
		this.#data = data;

		if (this.#data.keys.length > 0 && !encryptionKey) {
			throw new AnchorMetadataError('METADATA_ENCRYPTION_KEY_REQUIRED', 'Encryption key must be defined if constructing metadata store with encrypted data');
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
	static async #decryptKey(
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

				const key = await principal.decrypt(symmetricKey);

				return({ principal, key });
			}
		}

		throw new AnchorMetadataError('METADATA_COULD_NOT_FIND_PRINCIPAL_DECRYPTION_MATCH', 'Could not find principal able to decrypt metadata');
	}

	/**
	 * Encrypts the metadata object with the given key and sets the object's iv.
	 *
	 * @returns The encrypted metadata and the initialization vector
	 */
	static #encryptDataWithKey(data: Buffer, key: Buffer, iv: Buffer): Buffer {
		const cipher = crypto.createCipheriv(MetadataStore.algorithm, key, iv);

		const encryptedData = Buffer.concat([
			cipher.update(data),
			cipher.final()
		]);

		return(encryptedData);
	}

	/**
	 * Decrypts and inflates the metadata object.
	 *
	 * @returns The decrypted metadata
	 */
	static async #decryptData(
		principals: Account[],
		encryptedData: ArrayBuffer,
		initializationVector: ArrayBuffer,
		encryptedKeys: KeyStore[]
	): Promise<{ data: ArrayBuffer, decryptedKey: ArrayBuffer }> {
		const decryptedKey = await MetadataStore.#decryptKey(principals, encryptedKeys);
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
	static #buildKeyStore(publicKey: Buffer, encryptedKey: Buffer): KeyStore {
		return({
			publicKey: new BufferStorage(bufferToArrayBuffer(publicKey), publicKey.byteLength),
			symmetricKey: new BufferStorage(bufferToArrayBuffer(encryptedKey), encryptedKey.byteLength)
		});
	}

	/**
	 * Get the array of the encryption keys.
	 *
	 * @returns The encrypted key array
	 */
	static #getEncryptionKeysSequence(keys: KeyStore[]): [ASN1BitString, ASN1BitString][] {
		return(keys.map(function(key) {
			return([
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
		}));
	}

	#getIV() {
		if (!this.data.iv) {
			this.data.iv = bufferToArrayBuffer(crypto.randomBytes(16));
		}

		return(this.data.iv);
	}

	/**
	 * Compiles the ASN.1 for the metadata object.
	 *
	 * @returns The ASN.1 BER data
	 */
	async #buildASN1(): Promise<ArrayBuffer> {
		const compressedData = zlib.deflateSync(Buffer.from(this.data.value, 'utf-8'));

		const headerSequence = [
			this.version
		] as const;

		let finalSequence: NetworkMetadataASN1Schema;
		if (this.isEncrypted) {
			const iv = Buffer.from(this.#getIV());

			finalSequence = [
				...headerSequence,
				// Boolean indicating that the data is encrypted
				true,
				[
					// The sequence of keys and encrypted encryption keys
					MetadataStore.#getEncryptionKeysSequence(this.data.keys),

					// The IV
					iv,

					// The encrypted data
					MetadataStore.#encryptDataWithKey(compressedData, Buffer.from(this.#encryptionKey), iv)
				]
			];
		} else {
			finalSequence = [
				...headerSequence,
				// Boolean indicating that the data is decrypted
				false,
				// The raw decrypted data
				[ compressedData ]
			];
		}

		return(JStoASN1(finalSequence).toBER(false));
	}

	/**
	 * Create a NetworkMetadataStore using an account and the BER data.
	 * XXX:TODO Handle versioning
	 *
	 * @returns The NetworkMetadataStore
	 */
	static async fromData(
		data: ArrayBuffer | string,
		principals: Account[] = []
	): Promise<MetadataStore> {
		if (typeof data === 'string') {
			data = 	bufferToArrayBuffer(Buffer.from(data, 'base64'));
		}

		const sequence = ASN1toJS(data);

		if (!isValidNetworkMetadataSchema(sequence)) {
			throw new AnchorMetadataError('METADATA_INVALID_ASN1_SCHEMA', 'Invalid ASN.1 Sequence: Invalid schema');
		}

		const version = sequence[0];
		if (version !== BigInt(0)) {
			throw new AnchorMetadataError('METADATA_INVALID_VERSION', `Cannot parse version ${version}`);
		}

		const isEncrypted = sequence[1];
		const sequenceData = sequence[2];

		let initializationVector: ArrayBuffer | undefined;
		let encryptedKeys: KeyStore[];
		let bufferData;
		let decryptedKey: ArrayBuffer | undefined;
		if (isEncrypted) {
			if (principals === undefined || principals.length < 1) {
				throw new AnchorMetadataError('METADATA_PRINCIPAL_REQUIRED_TO_DECRYPT', 'Principal is required to decrypt the metadata');
			}

			if (!isValidEncryptedMetadataASN1Schema(sequenceData)) {
				throw new AnchorMetadataError('METADATA_INVALID_ASN1_SCHEMA', 'Invalid encrypted metadata sequence');
			}

			const encryptedData = bufferToArrayBuffer(sequenceData[2]);

			encryptedKeys = [];
			for (const asn1key of sequenceData[0]) {
				const [ publicKey, encryptedKey ] = asn1key;
				encryptedKeys.push(MetadataStore.#buildKeyStore(publicKey.value, encryptedKey.value));
			}

			if (encryptedKeys.length === 0) {
				throw new AnchorMetadataError('METADATA_KEYS_REQUIRED_WHEN_ENCRYPTED', 'At least one key is required when metadata is encrypted');
			}

			initializationVector = bufferToArrayBuffer(sequenceData[1]);

			const decryptResponse = await MetadataStore.#decryptData(
				principals,
				encryptedData,
				initializationVector,
				encryptedKeys
			);

			bufferData = decryptResponse.data;
			decryptedKey = decryptResponse.decryptedKey;
		} else {
			if (!isValidPlaintextMetadataASN1Schema(sequenceData)) {
				throw new AnchorMetadataError('METADATA_INVALID_ASN1_SCHEMA', 'Invalid plaintext metadata sequence');
			}

			bufferData = bufferToArrayBuffer(sequenceData[0]);
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
			throw new AnchorMetadataError('METADATA_ACCOUNT_MUST_SUPPORT_ENCRYPTION', 'The account does not support encryption');
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

		const publicKey = account.publicKey.getBuffer();
		const encryptedKey = Buffer.from(await account.encrypt(this.#_encryptionKey));

		this.data.keys.push(MetadataStore.#buildKeyStore(publicKey, encryptedKey));
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
	async revokeAccess(account: GenericAccount) {
		if (!this.isEncrypted) {
			throw new AnchorMetadataError('METADATA_CANNOT_REVOKE_ACCESS_NOT_ENCRYPTED', 'Cannot revoke access when data is not encrypted');
		}

		const foundMatches = findIndexesOfKeyInKeyStores(this.data.keys, account);

		if (this.data.keys.length - foundMatches.length <= 0) {
			throw new AnchorMetadataError('METADATA_CANNOT_REVOKE_ACCESS_LAST_ACCOUNT', 'Cannot revoke access to last account');
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
		const sequence = await this.#buildASN1();

		const buf = Buffer.from(sequence);

		if (asBuffer) {
			return(buf);
		}

		return(buf.toString('base64'));
	}
}
