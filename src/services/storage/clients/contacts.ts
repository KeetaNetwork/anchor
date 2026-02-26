import type { AssetTransferInstructions } from '../../asset-movement/common.js';
import type { KeetaStorageAnchorSession } from '../client.js';
import { hash } from '../../../lib/utils/tests/hash.js';
import { Errors } from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';
import { assertContact } from './contacts.generated.js';

// #region Types

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A contact address derived from `AssetTransferInstructions`
 */
export type ContactAddress = DistributiveOmit<
	AssetTransferInstructions,
	'value' | 'assetFee' | 'totalReceiveAmount' | 'persistentAddressId'
>;

/**
 * A stored contact with metadata and an address.
 */
export type Contact = {
	id: string;
	label: string;
	address: ContactAddress;
};

// #endregion

// #region Interface

/**
 * Generic contacts client interface
 */
export interface ContactsClient {
	deriveId(address: ContactAddress): string;

	create(options: {
		label: string;
		address: ContactAddress;
	}): Promise<Contact>;

	get(id: string): Promise<Contact | null>;

	update(id: string, options: {
		label?: string;
		address?: ContactAddress;
	}): Promise<Contact>;

	delete(id: string): Promise<boolean>;

	list(options?: {
		type?: ContactAddress['type'];
	}): Promise<Contact[]>;
}

// #endregion

// #region Storage Implementation

const MIME_TYPE = 'application/json';

function canonicalizeValue(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return(JSON.stringify(value));
	}
	if (Array.isArray(value)) {
		return('[' + value.map(canonicalizeValue).join(',') + ']');
	}

	const keys = Object.keys(value).sort();
	const pairs: string[] = [];
	for (const key of keys) {
		pairs.push(JSON.stringify(key) + ':' + canonicalizeValue((value as { [k: string]: unknown })[key]));
	}

	return('{' + pairs.join(',') + '}');
}

function canonicalizeContactAddress(address: ContactAddress): string {
	return(canonicalizeValue(address));
}

/**
 * Storage Anchor-backed implementation of `ContactsClient`.
 * Stores contacts as encrypted JSON objects via a `KeetaStorageAnchorSession`.
 */
export class StorageContactsClient implements ContactsClient {
	readonly #session: KeetaStorageAnchorSession;

	constructor(session: KeetaStorageAnchorSession) {
		this.#session = session;
	}

	deriveId(address: ContactAddress): string {
		return(hash(canonicalizeContactAddress(address)));
	}

	#serialize(contact: Contact): Buffer {
		return(Buffer.from(JSON.stringify(contact)));
	}

	#deserialize(data: Buffer): Contact {
		return(assertContact(JSON.parse(data.toString())));
	}

	async create(options: {
		label: string;
		address: ContactAddress;
	}): Promise<Contact> {
		const id = this.deriveId(options.address);
		const contact: Contact = {
			id,
			label: options.label,
			address: options.address
		};

		await this.#session.put(id, this.#serialize(contact), {
			mimeType: MIME_TYPE,
			tags: [options.address.type]
		});

		return(contact);
	}

	async get(id: string): Promise<Contact | null> {
		const result = await this.#session.get(id);
		if (!result) {
			return(null);
		}

		return(this.#deserialize(result.data));
	}

	async update(id: string, options: {
		label?: string;
		address?: ContactAddress;
	}): Promise<Contact> {
		const existing = await this.get(id);
		if (!existing) {
			throw(new Errors.DocumentNotFound(`Contact not found: ${id}`));
		}

		const newAddress = options.address ?? existing.address;
		const newId = this.deriveId(newAddress);

		const updated: Contact = {
			id: newId,
			label: options.label ?? existing.label,
			address: newAddress
		};

		if (newId !== id) {
			await this.#session.delete(id);
		}

		await this.#session.put(newId, this.#serialize(updated), {
			mimeType: MIME_TYPE,
			tags: [updated.address.type]
		});

		return(updated);
	}

	async delete(id: string): Promise<boolean> {
		return(await this.#session.delete(id));
	}

	async list(options?: {
		type?: ContactAddress['type'];
	}): Promise<Contact[]> {
		const searchResult = await this.#session.search({
			pathPrefix: this.#session.workingDirectory,
			...(options?.type ? { tags: [options.type] } : {})
		});

		const contacts: Contact[] = [];
		for (const metadata of searchResult.results) {
			const result = await this.#session.get(metadata.path);
			if (result) {
				contacts.push(this.#deserialize(result.data));
			}
		}

		return(contacts);
	}
}

// #endregion
