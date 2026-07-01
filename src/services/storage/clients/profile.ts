import type { KeetaStorageAnchorSession, StorageSubClientConfig } from '../client.js';
import type { Logger } from '../../../lib/log/index.js';
import type * as CurrencyInfo from '@keetanetwork/currency-info';
import { Errors } from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';
import { assertProfile, assertPublicProfile } from './profile.generated.js';

// #region Types

/**
 * Fields shared by every profile, regardless of account type.
 * Both fields are considered public and are mirrored into the public projection.
 */
interface BaseProfile<Type extends string> {
	accountType: Type;
	displayName: string;
}

/**
 * A profile for an individual account.
 * `firstName` and `lastName` are private; `displayName` and `accountType` are public.
 */
export interface PersonalProfile extends BaseProfile<'personal'> {
	firstName: string;
	lastName: string;
}

/**
 * A profile for a business account.
 * `companyName` and `country` are private; `displayName` and `accountType` are public.
 */
export interface BusinessProfile extends BaseProfile<'business'> {
	companyName: string;
	country: CurrencyInfo.ISOCountryCode;
}

/**
 * A full account profile, discriminated on `accountType`.
 */
export type Profile = PersonalProfile | BusinessProfile;

/**
 * The set of account types a profile can have.
 */
export type AccountType = Profile['accountType'];

/**
 * The public projection of a profile, stored separately so it can be served
 * to other accounts without exposing the private fields.
 */
export interface PublicProfile {
	accountType: AccountType;
	displayName: string;
}

// #endregion

// #region Interface

/**
 * Generic profile client interface.
 */
export interface ProfileClient {
	set(profile: Profile): Promise<void>;
	get(): Promise<Profile | null>;
	getPublic(): Promise<PublicProfile | null>;
	delete(): Promise<boolean>;
}

// #endregion

// #region Storage Implementation

/**
 * MIME type for profile data.
 */
const MIME_TYPE = 'application/json';

/**
 * Relative path of the full, owner-only profile object.
 */
const PROFILE_PRIVATE_FILENAME = 'private';

/**
 * Relative path of the public projection object.
 */
const PROFILE_PUBLIC_FILENAME = 'public';

/**
 * Storage Anchor-backed implementation of `ProfileClient`.
 * Stores a profile as a private full object plus a public projection via a `KeetaStorageAnchorSession`.
 */
export class StorageProfileClient implements ProfileClient {
	readonly #session: KeetaStorageAnchorSession;
	readonly #logger?: Logger | undefined;

	constructor(config: StorageSubClientConfig) {
		this.#session = config.session;
		this.#logger = config.logger;
	}

	#serialize(value: Profile | PublicProfile): Buffer {
		return(Buffer.from(JSON.stringify(value)));
	}

	#toPublic(profile: Profile): PublicProfile {
		return({
			accountType: profile.accountType,
			displayName: profile.displayName
		});
	}

	async set(profile: Profile): Promise<void> {
		this.#logger?.debug('StorageProfileClient::set', `Setting ${profile.accountType} profile`);

		const validated = assertProfile(profile);

		// Write the private (full) object first so a failed public write never
		// leaves a public projection without the owner's data. Not transactional.
		await this.#session.put(PROFILE_PRIVATE_FILENAME, this.#serialize(validated), {
			mimeType: MIME_TYPE,
			visibility: 'private'
		});

		await this.#session.put(PROFILE_PUBLIC_FILENAME, this.#serialize(this.#toPublic(validated)), {
			mimeType: MIME_TYPE,
			visibility: 'public'
		});

		this.#logger?.debug('StorageProfileClient::set', 'Profile set successfully');
	}

	async get(): Promise<Profile | null> {
		this.#logger?.debug('StorageProfileClient::get', 'Getting profile');

		const result = await this.#session.get(PROFILE_PRIVATE_FILENAME);
		if (!result) {
			this.#logger?.debug('StorageProfileClient::get', 'Profile not found');
			return(null);
		}

		this.#logger?.debug('StorageProfileClient::get', 'Profile retrieved');
		return(assertProfile(JSON.parse(result.data.toString())));
	}

	async getPublic(): Promise<PublicProfile | null> {
		this.#logger?.debug('StorageProfileClient::getPublic', 'Getting public profile');

		const url = await this.#session.getPublicUrl(PROFILE_PUBLIC_FILENAME);
		const response = await fetch(url);

		if (response.status === 404) {
			this.#logger?.debug('StorageProfileClient::getPublic', 'Public profile not found');
			return(null);
		}

		if (!response.ok) {
			throw(new Errors.InvalidResponse(`Failed to fetch public profile: ${response.status}`));
		}

		this.#logger?.debug('StorageProfileClient::getPublic', 'Public profile retrieved');
		return(assertPublicProfile(JSON.parse(await response.text())));
	}

	async delete(): Promise<boolean> {
		this.#logger?.debug('StorageProfileClient::delete', 'Deleting profile');

		const [ privateDeleted, publicDeleted ] = await Promise.all([
			this.#session.delete(PROFILE_PRIVATE_FILENAME),
			this.#session.delete(PROFILE_PUBLIC_FILENAME)
		]);

		const deleted = privateDeleted || publicDeleted;
		this.#logger?.debug('StorageProfileClient::delete', `Profile delete: ${deleted ? 'removed' : 'not found'}`);
		return(deleted);
	}
}

// #endregion
