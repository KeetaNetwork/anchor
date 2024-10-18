import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as CurrencyInfo from '@keetapay/currency-info';
import type { Logger } from './log/index.ts';
import type { JSONSerializable } from './utils/json.ts';
import { assertNever } from './utils/never.js';
import { createIs, createAssert } from 'typia';

const ExternalURLMarker = '2b828e33-2692-46e9-817e-9b93d63f28fd';

type ExternalURL = { external: typeof ExternalURLMarker; url: string; };

type KeetaNetAccount = InstanceType<typeof KeetaNetClient.lib.Account>;

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */
type CountrySearchInput = CurrencyInfo.ISOCountryCode | CurrencyInfo.ISOCountryNumber | CurrencyInfo.Country;
type CountrySearchCanonical = CurrencyInfo.ISOCountryCode; /* XXX:TODO */

/**
 * A cache object
 */
type URLCacheObject = Map<string, {
	pass: true;
	value: JSONSerializable;
	expires: Date;
} | {
	pass: false;
	error: unknown;
	expires: Date;
}>;

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
		fx?: {
			inputCurrencyCodes: {
				outputCurrencyCodes: string[];
				kycProviders: string[];
			}[];
		};
		inbound?: {
			/* XXX:TODO */
		};
		outbound?: {
			/* XXX:TODO */
		};
		cards?: {
			/* XXX:TODO */
		};
	};
};

/**
 * Types of services which can be resolved
 */
type Services = keyof ServiceMetadata['services'];

/**
 * Search criteria for each service type
 */
type ServiceSearchCriteria<T extends Services> = {
	'banking': {
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
	'fx': {
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
	'inbound': {
		/* XXX:TODO */
	};
	'outbound': {
		/* XXX:TODO */
	};
	'cards': {
		/* XXX:TODO */
	};
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
	/**
	 * Caching Parameters
	 */
	cache?: Omit<NonNullable<MetadataConfig['cache']>, 'instance'>;
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
type ValuizeInput = JSONSerializablePrimitive | ValuizableObject | ValuizableArray;
type ValuizableArray = Array<ValuizableMethod | undefined>;
type ValuizableObject = { [key: string]: ValuizableMethod | undefined };

type ValuizableKind = 'any' | 'object' | 'array' | 'primitive' | 'string' | 'number' | 'boolean';
interface ValuizableMethod {
	(expect: 'object'): Promise<ValuizableObject>;
	(expect: 'array'): Promise<ValuizableArray>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
	(expect: 'string'): Promise<string>;
	(expect: 'number'): Promise<number>;
	(expect: 'boolean'): Promise<boolean>;
	(expect?: 'any'): Promise<ValuizeInput>;
	(expect?: ValuizableKind): Promise<ValuizeInput>;
};

interface ToValuizableExpectString {
	(expect: 'string'): Promise<string>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
};
interface ToValuizableExpectNumber {
	(expect: 'number'): Promise<number>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
};
interface ToValuizableExpectBoolean {
	(expect: 'boolean'): Promise<boolean>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
};
type ToValuizableObject<T extends Object> = {
	[K in keyof T]:
		T[K] extends string ? ToValuizableExpectString :
		T[K] extends number ? ToValuizableExpectNumber :
		T[K] extends boolean ? ToValuizableExpectBoolean :
		T[K] extends JSONSerializablePrimitive ?
			(expect: 'primitive') => Promise<JSONSerializablePrimitive> :
		T[K] extends Array<unknown> ?
			(expect: 'array') => Promise<ToValuizableObject<T[K]>> :
		T[K] extends object ?
			(expect: 'object') => Promise<ToValuizableObject<T[K]>> :
		T[K] extends (infer U | undefined) ?
			ToValuizable<U> | undefined :
		never;
};
type ToValuizable<T> = ToValuizableObject<{ tmp: T }>['tmp'];

/*
 * Access token to share with the Metadata object to allow it to
 * access the mutable stats object.
 */
const statsAccessToken = Symbol('statsAccessToken');

type MetadataConfig = {
	trustedCAs: ResolverConfig['trustedCAs'];
	client: KeetaNetClient.Client;
	logger?: ResolverConfig['logger'];
	resolver: Resolver;
	cache?: {
		instance: URLCacheObject;
		positiveTTL?: number;
		negativeTTL?: number;
	};
	parent?: Metadata;
};

type ValuizableInstance = { value: ValuizableMethod };

class Metadata implements ValuizableInstance {
	readonly #cache: Required<NonNullable<MetadataConfig['cache']>>;
	readonly #trustedCAs: ResolverConfig['trustedCAs'];
	readonly #client: KeetaNetClient.Client;
	readonly #logger: Logger | undefined;
	readonly #url: URL;
	readonly #resolver: Resolver;
	readonly #stats: ResolverStats;
	private readonly seenURLs: Set<string>;

	private static readonly instanceTypeID = 'Metadata:c85b3d67-9548-4042-9862-f6e6677690ac';

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

	constructor(url: string | URL, config: MetadataConfig) {
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
		this.#cache = {
			instance: config.cache?.instance ?? new Map(),
			positiveTTL: config.cache?.positiveTTL ?? 60 * 1000,
			negativeTTL: config.cache?.negativeTTL ?? 5 * 1000
		};
		this.#trustedCAs = config.trustedCAs;
		this.#client = config.client;
		this.#logger = config.logger;
		this.#resolver = config.resolver;
		this.#stats = this.#resolver._mutableStats(statsAccessToken);
		if (config.parent !== undefined) {
			this.seenURLs = config.parent.seenURLs;
		} else {
			this.seenURLs = new Set();
		}
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
		/*
		 * To ensure any circular references are handled correctly, we
		 * keep track of a chain of accessed URLs.  If we see the same
		 * URL twice, then we have a circular reference.
		 */
		if (this.seenURLs.has(cacheKey)) {
			return('');
		}
		this.seenURLs.add(cacheKey);

		let cacheVal = this.#cache.instance.get(cacheKey);
		/*
		 * Verify that the cache entry is still valid.  If it is not,
		 * then remove it from the cache.
		 */
		if (this.#cache.instance.has(cacheKey) && cacheVal !== undefined) {
			if (cacheVal.expires < new Date()) {
				this.#cache.instance.delete(cacheKey);
				cacheVal = undefined;
			}
		}

		if (this.#cache.instance.has(cacheKey) && cacheVal !== undefined) {
			if (cacheVal.expires < new Date()) {
				this.#cache.instance.delete(cacheKey);
			}

			this.#stats.cache.hit++;

			if (cacheVal.pass) {
				return(cacheVal.value);
			} else {
				throw(cacheVal.error);
			}
		}

		this.#stats.cache.miss++;

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
			this.#cache.instance.set(cacheKey, {
				pass: false,
				error: readError,
				expires: new Date(Date.now() + this.#cache.negativeTTL)
			});

			this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Read URL', url.toString(), 'failed:', readError);
			throw(readError);
		}

		this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Read URL', url.toString(), ':', retval);

		this.#cache.instance.set(cacheKey, {
			pass: true,
			value: retval,
			expires: new Date(Date.now() + this.#cache.positiveTTL)
		});

		return(retval);
	}

	private async resolveValue<T extends ExternalURL | undefined>(value: T): Promise<JSONSerializable>;
	private async resolveValue<T extends JSONSerializable | undefined>(value: T): Promise<T>;
	private async resolveValue<T extends JSONSerializable | ExternalURL | undefined>(value: T): Promise<T | JSONSerializable> {
		if (value === undefined) {
			return(value);
		}

		/*
		 * If the value passed in is a reference to an external URL, then
		 * we need to read that URL (and continue to resolve it).
		 */
		if (isExternalURL(value)) {
			const url = new URL(value.url);
			const retval = await this.readURL(url);

			return(await this.resolveValue(retval));
		}

		return(value);
	}

	private assertValuizableKind(input: ValuizeInput, expect: ValuizableKind) {
		switch (expect) {
			case 'any':
				return(input);
			case 'object':
				if (typeof input !== 'object') {
					throw(new Error(`expected an object, got ${typeof input}`));
				}

				if (input === null) {
					throw(new Error('expected an object, got null'));
				}

				if (Array.isArray(input)) {
					throw(new Error('expected an object, got an array'));
				}

				return(input);
			case 'array':
				if (!Array.isArray(input)) {
					throw(new Error(`expected an array, got ${typeof input}`));
				}

				return(input);
			case 'primitive':
				if ((typeof input === 'object' && input !== null) || input === undefined) {
					throw(new Error(`expected a primitive, got ${typeof input}`));
				}

				return(input);
			case 'string':
			case 'number':
			case 'boolean':
				if (typeof input !== expect) {
					throw(new Error(`expected a ${expect}, got ${typeof input}`));
				}
				return(input);
			default:
				assertNever(expect);
		}
	}

	private async valuize(value: JSONSerializable): Promise<ValuizeInput> {
		if (typeof value === 'object' && value !== null) {
			let newValue: ValuizableObject | ValuizableArray;
			if (Array.isArray(value)) {
				newValue = [];
			} else {
				newValue = {};
			}
			for (const key in value) {
				/*
				 * Since `key` is the index of the array or
				 * object, it is safe to use it to index
				 * into the array or object.
				 */
				// @ts-ignore
				const keyValue: JSONSerializable = value[key];

				if (isExternalURL(keyValue)) {
					const newMetadataObject = new Metadata(keyValue.url, {
						trustedCAs: this.#trustedCAs,
						client: this.#client,
						logger: this.#logger,
						resolver: this.#resolver,
						cache: this.#cache,
						parent: this
					});

					const newValuizableObject: ValuizableMethod = newMetadataObject.value.bind(newMetadataObject);

					// @ts-ignore
					newValue[key] = newValuizableObject;
				} else {
					/*
					 * This is safe because `assertValuizableKind` will
					 * ensure the correct output type
					 */
					// @ts-ignore
					const newValueEntry: ValuizableMethod = async (expect: ValuizableKind = 'any') => {
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
	async value(expect: 'string'): Promise<string>;
	async value(expect: 'number'): Promise<number>;
	async value(expect: 'boolean'): Promise<boolean>;
	async value(expect?: 'any'): Promise<ValuizeInput>;
	async value(expect?: ValuizableKind): Promise<ValuizeInput>;
	async value(expect: ValuizableKind = 'any'): Promise<ValuizeInput> {
		const value = await this.readURL(this.#url);

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

type ResolverLookupBankingResults = ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>;
const assertResolverLookupBankingResults = createAssert<ResolverLookupBankingResults>();

export class Resolver {
	readonly #root: ResolverConfig['root'];
	readonly #trustedCAs: ResolverConfig['trustedCAs'];
	readonly #client: KeetaNetClient.Client;
	readonly #logger: Logger | undefined;
	readonly #stats: ResolverStats;
	readonly #metadataCache: NonNullable<MetadataConfig['cache']>;

	readonly id: string;

	static readonly Metadata: typeof Metadata = Metadata;

	constructor(config: ResolverConfig) {
		this.#root = config.root;
		this.#trustedCAs = config.trustedCAs;
		this.#logger = config.logger;
		this.#metadataCache = {
			...config.cache,
			instance: new Map()
		};

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

	private async lookupBankingService(bankingServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'banking'>) {
		if (bankingServices === undefined) {
			return(undefined);
		}

		for (const checkBankingServiceID in bankingServices) {
			try {
				const checkBankingService = await bankingServices[checkBankingServiceID]?.('object');
				if (checkBankingService === undefined) {
					continue;
				}

				if (!('operations' in checkBankingService)) {
					continue;
				}

				if (!('countryCodes' in checkBankingService)) {
					continue;
				}

				if (!('currencyCodes' in checkBankingService)) {
					continue;
				}

				if (!('kycProviders' in checkBankingService)) {
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

				return(assertResolverLookupBankingResults(checkBankingService));
			} catch (checkBankingServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking banking service', checkBankingServiceID, ':', checkBankingServiceError, ' -- ignoring');
			}
		}

		return(undefined);
	}

	async lookup<T extends 'banking'>(service: T, criteria: ServiceSearchCriteria<T>): Promise<ResolverLookupBankingResults | undefined>;
	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<ResolverLookupBankingResults | undefined>;
	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<ResolverLookupBankingResults | undefined> {
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
			case 'banking': {
				const currentCriteria = criteria as ServiceSearchCriteria<'banking'>;
				const bankingServices = await definedServices.banking?.('object');
				this.#logger?.debug(`Resolver:${this.id}`, 'Banking Services:', bankingServices);

				return(await this.lookupBankingService(bankingServices, currentCriteria));
			}
			case 'fx':
			case 'inbound':
			case 'outbound':
			case 'cards':
				throw(new Error('not implemented'));
			default:
				assertNever(service);
		}
	}

	clearCache(): void {
		this.#metadataCache.instance.clear();
	}
}

export default Resolver;
