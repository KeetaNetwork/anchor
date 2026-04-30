import type { AssetTransferInstructions, RecipientResolved, KeetaNetAccount, Rail } from '../../asset-movement/common.js';
import type { AssetLocationLike, PickChainLocation } from '../../asset-movement/lib/location.js';
import type { KeetaStorageAnchorSession, StorageSubClientConfig } from '../client.js';
import type { Logger } from '../../../lib/log/index.js';
import type { StorageObjectMetadata } from '../common.js';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { convertAssetLocationToString } from '../../asset-movement/lib/location.js';
import { Errors } from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';
import { assertContact } from './contacts.generated.js';

// #region Types

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The structural shape of a transfer instruction, excluding transaction-specific fields.
 */
export type TransferInstructionShape = DistributiveOmit<
	AssetTransferInstructions,
	'value' | 'assetFee' | 'totalReceiveAmount' | 'persistentAddressId'
>;

/**
 * The type of provider information allowed for a contact address.
 */
export type ProviderInformationType = 'username' | 'template';

/**
 * The type of recipient for a persistent address template.
 */
export type PersistentAddressTemplateRecipient = Extract<RecipientResolved, { type: 'persistent-address' }>;

/**
 * Base interface for contact addresses with narrowed generic parameters.
 */
export interface ContactAddressBase<
	RecipientType extends RecipientResolved,
	Location extends AssetLocationLike,
	ProviderInformationAllowedTypes extends ProviderInformationType
> {
	recipient: RecipientType;
	location?: Location;
	providerInformation?: { [providerId: string]: ProviderInformationAllowedTypes[] };
	pastInstructions?: TransferInstructionShape[];
}

export type KeetaAssetLocation = PickChainLocation<'keeta'> | `chain:keeta:${bigint}`;

/**
 * A contact address for a Keeta account.
 */
export type KeetaContactAddress = ContactAddressBase<string, KeetaAssetLocation, 'username'>;

/**
 * A contact address for a persistent address template.
 */
export type TemplateContactAddress = ContactAddressBase<PersistentAddressTemplateRecipient, AssetLocationLike, 'template'>;

/**
 * A contact address for a non-Keeta, non-persistent-address recipient.
 */
export type OtherContactAddress = ContactAddressBase<
	Exclude<RecipientResolved, KeetaNetAccount | PersistentAddressTemplateRecipient>,
	Exclude<AssetLocationLike, KeetaAssetLocation>,
	'template'
>;

export type ContactAddress = KeetaContactAddress | TemplateContactAddress | OtherContactAddress;

/**
 * A stored contact with metadata and an address.
 */
export interface Contact {
	id: string;
	label: string;
	address: ContactAddress;
	rail?: Rail;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SharedStorageObjectMetadata extends Pick<StorageObjectMetadata, 'createdAt' | 'updatedAt'> {};

export interface ContactWithMetadata extends Contact, SharedStorageObjectMetadata {}

interface ContactOptions extends Omit<Contact, 'id'>, Partial<Pick<Contact, 'id'>> {}

// #endregion

// #region Interface

/**
 * Generic contacts client interface
 */
export interface ContactsClient {
	deriveId(address: ContactAddress): string;

	create(options: ContactOptions): Promise<Contact>;

	get(id: string): Promise<Contact | null>;

	update(id: string, options: {
		label?: string;
		address?: ContactAddress;
	}): Promise<Contact>;

	delete(id: string): Promise<boolean>;

	list(options?: {
		location?: AssetLocationLike;
	}): Promise<Contact[]>;
}

// #endregion

// #region Storage Implementation

/**
 * MIME type for contact data.
 */
const MIME_TYPE = 'application/json';

/**
 * Canonicalize a contact address for use in ID derivation.
 * Excludes metadata fields (`providerInformation`, `pastInstructions`) that are not part of contact identity.
 *
 * @param address - The contact address to canonicalize.
 *
 * @returns The canonicalized string representation of the contact address identity fields.
 */
function canonicalizeContactAddress(address: ContactAddress): string {
	const { providerInformation: _, pastInstructions: __, ...identity } = address; // eslint-disable-line @typescript-eslint/no-unused-vars
	return(JSON.stringify(identity, function(_key: string, value: unknown): unknown {
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			const obj = value as { [k: string]: unknown };
			return(Object.fromEntries(
				Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
			));
		}

		return(value);
	}));
}

/**
 * Convert an asset location to a tag for use in storage.
 *
 * @param location - The asset location to convert to a tag.
 *
 * @returns The tag string.
 */
function locationToTag(location: AssetLocationLike): string {
	const str = convertAssetLocationToString(location);

	const parts = str.split(':');
	return(parts.join('-'));
}

/**
 * Convert a contact address to a list of tags for use in storage.
 *
 * @param address - The contact address to convert to tags.
 *
 * @returns The list of tags.
 */
function contactTags(address: ContactAddress): string[] {
	if (address.location) {
		return([locationToTag(address.location)]);
	}

	return([]);
}

/**
 * Storage Anchor-backed implementation of `ContactsClient`.
 * Stores contacts as encrypted JSON objects via a `KeetaStorageAnchorSession`.
 */
export class StorageContactsClient implements ContactsClient {
	readonly #session: KeetaStorageAnchorSession;
	readonly #logger?: Logger | undefined;

	constructor(config: StorageSubClientConfig) {
		this.#session = config.session;
		this.#logger = config.logger;
	}

	deriveId(address: ContactAddress): string {
		const data = Buffer.from(canonicalizeContactAddress(address));
		const hash = KeetaNetLib.Utils.Hash.Hash(data);

		const result = Buffer.from(hash).toString('hex');
		return(result);
	}

	#serialize(contact: Contact): Buffer {
		return(Buffer.from(JSON.stringify(contact)));
	}

	#deserialize(data: Buffer, metadata: SharedStorageObjectMetadata): ContactWithMetadata;
	#deserialize(data: Buffer, metadata: null): Contact;
	#deserialize(data: Buffer, metadata: SharedStorageObjectMetadata | null): ContactWithMetadata | Contact;
	#deserialize(data: Buffer, metadata: SharedStorageObjectMetadata | null): ContactWithMetadata | Contact {
		const contact = assertContact(JSON.parse(data.toString()));

		if (metadata) {
			return({
				...contact,
				...metadata
			});
		} else {
			return(contact);
		}
	}

	async create(options: ContactOptions): Promise<Contact> {
		const id = options.id ?? this.deriveId(options.address);
		this.#logger?.debug('StorageContactsClient::create', `Creating contact ${id}`);

		const contact: Contact = assertContact({
			id,
			label: options.label,
			address: options.address,
			...(options.rail !== undefined ? { rail: options.rail } : {})
		});

		await this.#session.put(id, this.#serialize(contact), {
			mimeType: MIME_TYPE,
			tags: contactTags(options.address)
		});

		this.#logger?.debug('StorageContactsClient::create', `Contact created: ${id}`);
		return(contact);
	}

	async get(id: string, includeMetadata: true): Promise<ContactWithMetadata | null>;
	async get(id: string, includeMetadata?: false): Promise<Contact | null>;
	async get(id: string, includeMetadata?: boolean) {
		this.#logger?.debug('StorageContactsClient::get', `Getting contact ${id}`);

		const [ result, metadata ] = await Promise.all([
			this.#session.get(id),
			includeMetadata ? this.#session.getMetadata(id) : Promise.resolve(null)
		]);

		if (!result) {
			this.#logger?.debug('StorageContactsClient::get', `Contact not found: ${id}`);
			return(null);
		}

		this.#logger?.debug('StorageContactsClient::get', `Contact retrieved: ${id}`);
		return(this.#deserialize(result.data, metadata));
	}

	async update(id: string, options: {
		label?: string;
		address?: ContactAddress;
	}): Promise<Contact> {
		this.#logger?.debug('StorageContactsClient::update', `Updating contact ${id}`);

		const existing = await this.get(id);
		if (!existing) {
			throw(new Errors.DocumentNotFound(`Contact not found: ${id}`));
		}

		const newAddress = options.address ?? existing.address;
		const newId = this.deriveId(newAddress);

		const updated: Contact = assertContact({
			id: newId,
			label: options.label ?? existing.label,
			address: newAddress,
			...(existing.rail !== undefined ? { rail: existing.rail } : {})
		});

		await this.#session.put(newId, this.#serialize(updated), {
			mimeType: MIME_TYPE,
			tags: contactTags(updated.address)
		});

		if (newId !== id) {
			try {
				await this.#session.delete(id);
			} catch (error) {
				this.#logger?.warn('StorageContactsClient::update', `Failed to delete old contact ${id} after re-keying to ${newId}`, error);
			}
		}

		this.#logger?.debug('StorageContactsClient::update', `Contact updated: ${newId}`);
		return(updated);
	}

	async delete(id: string): Promise<boolean> {
		this.#logger?.debug('StorageContactsClient::delete', `Deleting contact ${id}`);
		const result = await this.#session.delete(id);
		this.#logger?.debug('StorageContactsClient::delete', `Contact delete ${id}: ${result ? 'removed' : 'not found'}`);
		return(result);
	}

	async list(options?: {
		location?: AssetLocationLike;
	}): Promise<ContactWithMetadata[]> {
		this.#logger?.debug('StorageContactsClient::list', 'Listing contacts');

		const criteria: { pathPrefix: string; tags?: string[] } = {
			pathPrefix: this.#session.workingDirectory
		};

		if (options?.location) {
			criteria.tags = [locationToTag(options.location)];
		}

		const searchResult = await this.#session.search(criteria);
		const contacts: ContactWithMetadata[] = [];
		for (const metadata of searchResult.results) {
			const result = await this.#session.get(metadata.path);
			if (result) {
				try {
					contacts.push(this.#deserialize(result.data, metadata));
				} catch (error) {
					this.#logger?.warn('StorageContactsClient::list', `Skipping corrupt contact at ${metadata.path}`, error);
				}
			}
		}

		this.#logger?.debug('StorageContactsClient::list', `Listed ${contacts.length} contacts`);
		return(contacts);
	}
}

// #endregion
