import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as CurrencyInfo from '@keetapay/currency-info';
import type { Logger } from './log/index.ts';
import type { JSONSerializable } from './utils/json.ts';
import { assertNever } from './utils/never.js';
import { createIs } from 'typia';

const ExternalURLMarker = '2b828e33-2692-46e9-817e-9b93d63f28fd' as const;

type ExternalURL = { external: typeof ExternalURLMarker; url: string; };

type KeetaNetAccount = InstanceType<typeof KeetaNetClient.lib.Account>;

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */
type CountrySearchInput = CurrencyInfo.ISOCountryCode | CurrencyInfo.ISOCountryNumber | CurrencyInfo.Country;
type CountrySearchCanonical = CurrencyInfo.ISOCountryCode; /* XXX:TODO */

type AddUnionToObjectValues<T extends object, U> = {
    [K in keyof T]: T[K] extends object ? AddUnionToObjectValues<T[K], U> : U | T[K];
} | U;

/**
 * A cache object
 */
type URLCacheObject = Map<string, JSONSerializable>;

/**
 * Service Metadata General Structure
 */
type ServiceMetadata = {
	version: number;
	services: {
		banking?: {
			[id: string]: {
				operations: {
					createAccount?: string;
				};
				currencyCodes: string[];
				countryCodes: string[];
				kycProviders: string[];
			};
		};
	};
};

/**
 * Types of services which can be resolved
 */
type Services = 'BANKING' | 'FX' | 'INBOUND' | 'OUTBOUND' | 'CARDS';

/**
 * Search criteria for each service type
 */
type ServiceSearchCriteria<T extends Services> = {
	'BANKING': {
		/**
		 * Search for a banking provider which supports creating
		 * accounts in ALL of the following currencies.
		 */
		currencyCodes?: CurrencySearchInput[];
		/**
		 * Search for a banking provider which supports creating
		 * accounts in ANY of the following countries.
		 */
		countryCodes?: CountrySearchInput[];
		/**
		 * Search for a banking provider which supports creating
		 * accounts verified by ANY of the following KYC providers
		 * (DN).
		 */
		kycProviders?: string[]; /* XXX:TODO */
	};
	'FX': {
		/**
		 * Search for a provider which can convert from the following
		 * input currency
		 */
		inputCurrencyCode: CurrencySearchInput;
		/**
		 * Search for a provider which can convert to the following
		 * output currency
		 */
		outputCurrencyCode: CurrencySearchInput;
	};
	'INBOUND': {};
	'OUTBOUND': {};
	'CARDS': {};
}[T];

type ResolverConfig = {
	/**
	 * The "root" account to use as the basis for all lookups.  It should
	 * contain the authoritative information for resolving in its
	 * Metadata.
	 */
	root: KeetaNetAccount;
	/**
	 * A KeetaNet Client to access the network using.
	 */
	client: KeetaNetClient.Client | KeetaNetClient.UserClient;
	/**
	 * A list of trusted Certificate Authorities to use when connecting to
	 * external HTTPS services.
	 */
	trustedCAs: string[]; /* XXX:TODO */
	/**
	 * Logger to use for debugging
	 */
	logger?: Logger;
	/**
	 * ID for this instance of the resolver
	 */
	id?: string;
}

function convertToCurrencySearchCanonical(input: CurrencySearchInput): CurrencySearchCanonical {
	if (CurrencyInfo.Currency.isCurrencyCode(input)) {
		return(input);
	} else if (CurrencyInfo.Currency.isISOCurrencyNumber(input)) {
		input = new CurrencyInfo.Currency(input);
	}

	return(input.code);
}

function convertToCountrySearchCanonical(input: CountrySearchInput): CountrySearchCanonical {
	if (CurrencyInfo.Country.isCountryCode(input)) {
		return(input);
	} else if (CurrencyInfo.Country.isISOCountryNumber(input)) {
		input = new CurrencyInfo.Country(input);
	}

	return(input.code);
}

/**
 * Check if a value is an ExternalURL
 */
const isExternalURL = createIs<ExternalURL>();

type JSONSerializablePrimitive = Exclude<JSONSerializable, object>;

type ValuizableArray = Array<Valuizable | undefined>;
type ValuizableObject = { [key: string]: Valuizable | undefined };

type ValuizableKind = 'any' | 'object' | 'array' | 'primitive';
interface Valuizable {
	(expect: 'object'): Promise<ValuizableObject>;
	(expect: 'array'): Promise<ValuizableArray>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
	(expect?: 'any'): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined>;
	(expect?: ValuizableKind): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined>;
};

function expectObject(input: JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined): ValuizableObject {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`expected an object, got ${typeof input}`));
	}

	if (Array.isArray(input)) {
		throw(new Error('expected an object, got an array'));
	}

	return(input);
}

function expectArray(input: JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined): ValuizableArray {
	if (!Array.isArray(input)) {
		throw(new Error(`expected an array, got ${typeof input}`));
	}

	return(input);
}

function expectPrimitive(input: JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined): JSONSerializablePrimitive {
	if ((typeof input === 'object' && input !== null) || input === undefined) {
		throw(new Error(`expected a primitive, got ${typeof input}`));
	}

	return(input);
}

/*
 * Access token to share with the Metadata object to allow it to
 * access the mutable stats object.
 */
const statsAccessToken = Symbol('statsAccessToken');


class Metadata {
	#cache: URLCacheObject;
	#trustedCAs: ResolverConfig['trustedCAs'];
	#client: KeetaNetClient.Client;
	#logger: Logger | undefined;
	#url: URL;
	#resolver: Resolver;
	#stats: ResolverStats;

	private static instanceTypeID = 'Metadata:c85b3d67-9548-4042-9862-f6e6677690ac';

	static isInstance(value: unknown): value is Metadata {
		if (typeof value !== 'object' || value === null) {
			return(false);
		}
		if (!('instanceID' in value)) {
			return(false);
		}

		return(value.instanceID === Metadata.instanceTypeID);
	}

	static formatMetadata(metadata: JSONSerializable): string {
		return(Buffer.from(JSON.stringify(metadata)).toString('base64'));
	}

	constructor(url: string | URL, config: { trustedCAs: ResolverConfig['trustedCAs']; client: KeetaNetClient.Client; logger?: Logger | undefined; cache?: URLCacheObject; resolver: Resolver }) {
		/*
		 * Define an "instanceTypeID" as an unenumerable property to
		 * ensure that we can identify this object as an instance of
		 * Metadata, but we do not need to serialize it.
		 */
		Object.defineProperty(this, 'instanceTypeID', {
			value: Metadata.instanceTypeID,
			enumerable: false
		});
		this.#url = new URL(url);
		this.#cache = config.cache ?? new Map();
		this.#trustedCAs = config.trustedCAs;
		this.#client = config.client;
		this.#logger = config.logger;
		this.#resolver = config.resolver;
		this.#stats = this.#resolver._mutableStats(statsAccessToken);
	}

	private async parseMetadata(metadata: string) {
		const retval = await this.resolveValue(JSON.parse(metadata) as JSONSerializable);

		return(retval);
	}

	private async readKeetaNetURL(url: URL): Promise<JSONSerializable> {
		const accountString = url.hostname;
		const path = url.pathname;

		this.#stats.keetanet.reads++;

		if (path !== '/metadata') {
			throw(new Error(`Unsupported path: ${path}`));
		}

		let account;
		try {
			account = KeetaNetClient.lib.Account.fromPublicKeyString(accountString);
		} catch (accountError) {
			return('');
		}

		const accountInfo = await this.#client.getAccountInfo(account);
		const metadata = Buffer.from(accountInfo.info.metadata, 'base64').toString('utf-8');
		if (metadata === '') {
			return('');
		}

		this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Account info for', accountString, '=', accountInfo.info);
		const retval = await this.parseMetadata(metadata);
		return(retval);
	}

	private async readHTTPSURL(_ignore_url: URL): Promise<JSONSerializable> {
		throw(new Error('not implemented'));
	}

	private async readURL(url: URL) {
		this.#stats.reads++;

		const cacheKey = url.toString();
		if (this.#cache.has(cacheKey)) {
			this.#stats.cache.hit++;
			return(this.#cache.get(cacheKey));
		}

		this.#stats.cache.miss++;

		/*
		 * To ensure any circular references are handled correctly, we
		 * temporarily cache the URL with an empty value.
		 */
		this.#cache.set(cacheKey, '');

		let retval;
		try {
			const protocol = url.protocol;
			if (protocol === 'keetanet:') {
				retval = await this.readKeetaNetURL(url);
			} else if (protocol === 'https:') {
				retval = await this.readHTTPSURL(url);
			} else {
				throw(new Error(`Unsupported protocol: ${protocol}`));
			}
		} catch (readError) {
			this.#cache.delete(cacheKey);
			this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Read URL', url.toString(), 'failed:', readError);
			throw(readError);
		}

		this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Read URL', url.toString(), ':', retval);

		this.#cache.set(cacheKey, retval);

		return(retval);
	}

	private async resolveValue<T extends JSONSerializable | ExternalURL | undefined>(value: T): Promise<Exclude<T, ExternalURL>> {
		if (value === undefined) {
			// @ts-ignore
			return(undefined);
		}

		/*
		 * If the value passed in is a reference to an external URL, then
		 * we need to read that URL (and continue to resolve it).
		 */
		if (isExternalURL(value)) {
			const url = new URL(value.url);
			const retval = await this.readURL(url);

			// @ts-ignore
			return(await this.resolveValue(retval));
		}

		// @ts-ignore
		return(value);
	}

	private assertValuizableKind(input: JSONSerializablePrimitive | ValuizableObject | ValuizableArray, expect: ValuizableKind) {
		switch (expect) {
			case 'any':
				return(input);
			case 'object':
				return(expectObject(input));
			case 'array':
				return(expectArray(input));
			case 'primitive':
				return(expectPrimitive(input));
			default:
				assertNever(expect);
		}
	}

	private async valuize(value: JSONSerializable): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray> {
		if (typeof value === 'object' && value !== null) {
			let newValue: ValuizableObject | ValuizableArray;
			if (Array.isArray(value)) {
				newValue = [];
			} else {
				newValue = {};
			}
			for (const key in value) {
				// @ts-ignore
				const keyValue: JSONSerializable = value[key];

				if (isExternalURL(keyValue)) {
					const newMetadataObject = new Metadata(keyValue.url, {
						trustedCAs: this.#trustedCAs,
						client: this.#client,
						logger: this.#logger,
						resolver: this.#resolver,
						cache: this.#cache
					});

					const newValuizableObject: Valuizable = newMetadataObject.value.bind(newMetadataObject);

					// @ts-ignore
					newValue[key] = newValuizableObject;
				} else {
					// @ts-ignore
					const newValueEntry: Valuizable = async (expect: ValuizableKind = 'any') => {
						const retval = this.assertValuizableKind(await this.valuize(keyValue), expect);
						return(retval);
					};

					// @ts-ignore
					newValue[key] = newValueEntry;
				}
			}

			return(newValue);
		} else {
			return(value);
		}
	}

	async value(expect: 'object'): Promise<ValuizableObject>;
	async value(expect: 'array'): Promise<ValuizableArray>;
	async value(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
	async value(expect?: 'any'): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined>;
	async value(expect?: ValuizableKind): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined>;
	async value(expect: ValuizableKind = 'any'): Promise<JSONSerializablePrimitive | ValuizableObject | ValuizableArray | undefined> {
		const value = await this.readURL(this.#url);
		if (value === undefined) {
			return(undefined);
		}

		const retval = this.assertValuizableKind(await this.valuize(value), expect);

		return(retval);
	}
}


type ResolverStats = {
	keetanet: {
		reads: number;
	};
	https: {
		reads: number;
	};
	reads: number;
	cache: {
		hit: number;
		miss: number;
	}
};

export class Resolver {
	#root: ResolverConfig['root'];
	#trustedCAs: ResolverConfig['trustedCAs'];
	#client: KeetaNetClient.Client;
	#logger: Logger | undefined;
	#stats: ResolverStats;
	#metadataCache: URLCacheObject;

	readonly id: string;

	static Metadata: typeof Metadata = Metadata;

	constructor(config: ResolverConfig) {
		this.#root = config.root;
		this.#trustedCAs = config.trustedCAs;
		this.#logger = config.logger;
		this.#metadataCache = new Map();
		this.id = config.id ?? crypto.randomUUID();

		this.#logger?.debug(`Resolver:${this.id}`, 'Creating resolver with root account', this.#root.publicKeyString.get());

		if (KeetaNetClient.Client.isInstance(config.client)) {
			this.#client = config.client;
		} else {
			this.#client = config.client.client;
		}

		this.#stats = {
			keetanet: {
				reads: 0
			},
			https: {
				reads: 0
			},
			reads: 0,
			cache: {
				hit: 0,
				miss: 0
			}
		};
	}

	/** @internal */
	_mutableStats(accessToken: Symbol) {
		if (accessToken !== statsAccessToken) {
			throw(new Error('Invalid access token'));
		}

		return(this.#stats);
	}

	get stats(): ResolverStats {
		return(structuredClone(this.#stats));
	}

	private async lookupBankingService(bankingServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'BANKING'>) {
		if (bankingServices === undefined) {
			return(undefined);
		}

		for (const checkBankingServiceID in bankingServices) {
			try {
				const checkBankingService = await bankingServices[checkBankingServiceID]?.('object');
				if (checkBankingService === undefined) {
					continue;
				}

				if (criteria.currencyCodes !== undefined) {
					const checkBankingServiceCurrencyCodes = await Promise.all(((await checkBankingService.currencyCodes?.('array')) ?? []).map(function(item) {
						return(item?.('primitive'));
					}));

					let acceptable = true;
					for (const checkCurrencyCode of criteria.currencyCodes) {
						const checkCurrencyCodeCanonical = convertToCurrencySearchCanonical(checkCurrencyCode);
						if (!checkBankingServiceCurrencyCodes.includes(checkCurrencyCodeCanonical)) {
							acceptable = false;
							break;
						}
					}

					if (!acceptable) {
						continue;
					}
				}

				if (criteria.countryCodes !== undefined) {
					const checkBankingServiceCountryCodes = await Promise.all(((await checkBankingService.countryCodes?.('array')) ?? []).map(function(item) {
						return(item?.('primitive'));
					}));
					this.#logger?.debug(`Resolver:${this.id}`, 'Checking country codes:', criteria.countryCodes, 'against', checkBankingServiceCountryCodes, 'for', checkBankingServiceID);

					let acceptable = true;
					for (const checkCountryCode of criteria.countryCodes) {
						const checkCountryCodeCanonical = convertToCountrySearchCanonical(checkCountryCode);
						if (!checkBankingServiceCountryCodes.includes(checkCountryCodeCanonical)) {
							acceptable = false;
							break;
						}
					}

					if (!acceptable) {
						continue;
					}
				}

				return(checkBankingService);
			} catch (checkBankingServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking banking service', checkBankingServiceID, ':', checkBankingServiceError, ' -- ignoring');
			}
		}

		return(undefined);
	}

	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<undefined | ValuizableObject> {
		const rootURL = new URL(`keetanet://${this.#root.publicKeyString.get()}/metadata`);
		const metadata = new Metadata(rootURL, {
			trustedCAs: this.#trustedCAs,
			client: this.#client,
			logger: this.#logger,
			resolver: this,
			cache: this.#metadataCache
		});
		const rootMetadata = await metadata.value('object');
		this.#logger?.debug(`Resolver:${this.id}`, 'Root Metadata:', rootMetadata);

		if (!('version' in rootMetadata)) {
			throw(new Error('Root metadata is missing "version" property'));
		}

		const rootMetadataVersion = await rootMetadata.version?.('primitive');
		if (rootMetadataVersion !== 1) {
			throw(new Error(`Unsupported metadata version: ${rootMetadataVersion}`));
		}

		/*
		 * Get the services object
		 */
		const definedServicesProperty = rootMetadata.services;
		if (definedServicesProperty === undefined) {
			throw(new Error('Root metadata is missing "services" property'));
		}
		const definedServices = await definedServicesProperty('object');

		this.#logger?.debug(`Resolver:${this.id}`, 'Looking up', service, 'with criteria:', criteria, 'in', definedServices);
		switch (service) {
			case 'BANKING': {
				const currentCriteria = criteria as ServiceSearchCriteria<'BANKING'>;
				const bankingServices = await definedServices.banking?.('object');
				this.#logger?.debug(`Resolver:${this.id}`, 'Banking Services:', bankingServices);

				return(await this.lookupBankingService(bankingServices, currentCriteria));
			}
			case 'FX':
			case 'INBOUND':
			case 'OUTBOUND':
			case 'CARDS':
				throw(new Error('not implemented'));
			default:
				assertNever(service);
		}
	}

	clearCache(): void {
		this.#metadataCache.clear();
	}
}

export default Resolver;
