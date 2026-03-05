import type { AssetTransferInstructions, RecipientResolved, KeetaNetAccount } from '../../asset-movement/common.js';
import type { AssetLocationLike, PickChainLocation } from '../../asset-movement/lib/location.js';
import type { KeetaStorageAnchorSession } from '../client.js';
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

	constructor(session: KeetaStorageAnchorSession) {
		this.#session = session;
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
			tags: contactTags(options.address)
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

		await this.#session.put(newId, this.#serialize(updated), {
			mimeType: MIME_TYPE,
			tags: contactTags(updated.address)
		});

		if (newId !== id) {
			try {
				await this.#session.delete(id);
			} catch {
				// Put succeeded; old contact is now orphaned
			}
		}

		return(updated);
	}

	async delete(id: string): Promise<boolean> {
		return(await this.#session.delete(id));
	}

	async list(options?: {
		location?: AssetLocationLike;
	}): Promise<Contact[]> {
		const criteria: { pathPrefix: string; tags?: string[] } = {
			pathPrefix: this.#session.workingDirectory
		};

		if (options?.location) {
			criteria.tags = [locationToTag(options.location)];
		}

		const searchResult = await this.#session.search(criteria);

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
