import type { KeetaStorageAnchorSession, StorageSubClientConfig } from '../client.js';
import type { Logger } from '../../../lib/log/index.js';
import type * as CurrencyInfo from '@keetanetwork/currency-info';
import { Errors } from '../common.js';
import { Buffer } from '../../../lib/utils/buffer.js';
import { assertProfile, assertPublicProfile, assertPrivateProfile } from './profile.generated.js';

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
 * The private fields of an individual account, stored on their own in the private object.
 */
export interface PersonalPrivateProfile {
	firstName: string;
	lastName: string;
}

/**
 * The private fields of a business account, stored on their own in the private object.
 */
export interface BusinessPrivateProfile {
	companyName: string;
	country: CurrencyInfo.ISOCountryCode;
}

/**
 * The private fields of a profile, stored on their own in the private object.
 * A non-discriminated union, but its members have disjoint required keys, so typia
 * validates it structurally.
 */
export type PrivateProfile = PersonalPrivateProfile | BusinessPrivateProfile;

/**
 * A profile for an individual account.
 * `firstName` and `lastName` are private; `displayName` and `accountType` are public.
 */
export type PersonalProfile = BaseProfile<'personal'> & PersonalPrivateProfile;

/**
 * A profile for a business account.
 * `companyName` and `country` are private; `displayName` and `accountType` are public.
 */
export type BusinessProfile = BaseProfile<'business'> & BusinessPrivateProfile;

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
export type PublicProfile = BaseProfile<AccountType>;

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

	#serialize(value: PrivateProfile | PublicProfile): Buffer {
		return(Buffer.from(JSON.stringify(value)));
	}

	#toPublic(profile: Profile): PublicProfile {
		return({
			accountType: profile.accountType,
			displayName: profile.displayName
		});
	}

	#toPrivate(profile: Profile): PrivateProfile {
		if (profile.accountType === 'personal') {
			return({
				firstName: profile.firstName,
				lastName: profile.lastName
			});
		}

		return({
			companyName: profile.companyName,
			country: profile.country
		});
	}

	async set(profile: Profile): Promise<void> {
		this.#logger?.debug('StorageProfileClient::set', `Setting ${profile.accountType} profile`);

		const validated = assertProfile(profile);

		await this.#session.put(PROFILE_PRIVATE_FILENAME, this.#serialize(this.#toPrivate(validated)), {
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

		const [ privateResult, publicResult ] = await Promise.all([
			this.#session.get(PROFILE_PRIVATE_FILENAME),
			this.#session.get(PROFILE_PUBLIC_FILENAME)
		]);

		if (!privateResult || !publicResult) {
			this.#logger?.debug('StorageProfileClient::get', 'Profile not found');
			return(null);
		}

		const publicProfile = assertPublicProfile(JSON.parse(publicResult.data.toString()));
		const privateProfile = assertPrivateProfile(JSON.parse(privateResult.data.toString()));

		this.#logger?.debug('StorageProfileClient::get', 'Profile retrieved');

		return(assertProfile({ ...publicProfile, ...privateProfile }));
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

		const [ privateResult, publicResult ] = await Promise.allSettled([
			this.#session.delete(PROFILE_PRIVATE_FILENAME),
			this.#session.delete(PROFILE_PUBLIC_FILENAME)
		]);

		if (privateResult.status === 'rejected') {
			this.#logger?.warn('StorageProfileClient::delete', 'Failed to delete private profile object', privateResult.reason);
		}

		if (publicResult.status === 'rejected') {
			this.#logger?.warn('StorageProfileClient::delete', 'Failed to delete public profile object', publicResult.reason);
		}

		if (privateResult.status === 'rejected') {
			throw(privateResult.reason);
		}

		if (publicResult.status === 'rejected') {
			throw(publicResult.reason);
		}

		const deleted = privateResult.value || publicResult.value;
		this.#logger?.debug('StorageProfileClient::delete', `Profile delete: ${deleted ? 'removed' : 'not found'}`);
		return(deleted);
	}
}

// #endregion
