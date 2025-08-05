import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import CurrencyInfo from '@keetanetwork/currency-info';
import type { Logger } from './log/index.ts';
import type { JSONSerializable } from './utils/json.ts';
import { assertNever } from './utils/never.js';
import { Buffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';

import { createIs, createAssert } from 'typia';

type ExternalURL = { external: '2b828e33-2692-46e9-817e-9b93d63f28fd'; url: string; };

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
				kycProviders?: string[];
			};
		};
		kyc?: {
			[id: string]: {
				operations: {
					/**
					 * Check if the KYC provider can
					 * service a more specific locality
					 * (optional)
					 */
					checkLocality?: string;
					/**
					 * Request an estimate for a KYC
					 * verification (optional)
					 */
					getEstimate?: string;
					/**
					 * Begin the KYC verification process
					 * with this KYC provider
					 */
					createVerification?: string;
					/**
					 * Get the certificate for the
					 * KYC verification
					 */
					getCertificates?: string;
				};
				/**
				 * Country codes which this KYC provider can
				 * validate accounts in.  If this is not
				 * specified, then the KYC provider can
				 * validate accounts in any country.
				 */
				countryCodes?: string[];
				/**
				 * The Certificate Authority (CA) Certificate
				 * that this KYC provider uses to sign KYC
				 * certificates.  This is used to identify the
				 * KYC provider.
				 */
				ca: string;
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
			workInProgress?: true;
		};
		outbound?: {
			/* XXX:TODO */
			workInProgress?: true;
		};
		cards?: {
			/* XXX:TODO */
			workInProgress?: true;
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
	'kyc': {
		/**
		 * Search for a KYC provider which can verify accounts in ALL
		 * of the following countries.
		 */
		countryCodes: CountrySearchInput[];
	};
	'inbound': {
		/* XXX:TODO */
		workInProgress: true;
	};
	'outbound': {
		/* XXX:TODO */
		workInProgress: true;
	};
	'cards': {
		/* XXX:TODO */
		workInProgress: true;
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
type ValuizableArray = (ValuizableMethod | undefined)[];
type ValuizableObject = { [key: string]: ValuizableMethod | undefined };

type ValuizableKind = 'any' | 'object' | 'array' | 'primitive' | 'string' | 'number' | 'boolean';
interface ValuizableMethod {
	(expect: 'object'): Promise<ValuizableObject>;
	(expect: 'array'): Promise<ValuizableArray>;
	(expect: 'primitive'): Promise<JSONSerializablePrimitive>;
	(expect: 'string'): Promise<string>;
	(expect: 'number'): Promise<number>;
	(expect: 'boolean'): Promise<boolean>;
	(expect: 'any'): Promise<ValuizeInput>;
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
/* eslint-disable @stylistic/indent */
type ToValuizableObject<T extends object> = {
	[K in keyof T]:
		T[K] extends string ? ToValuizableExpectString :
		T[K] extends number ? ToValuizableExpectNumber :
		T[K] extends boolean ? ToValuizableExpectBoolean :
		T[K] extends JSONSerializablePrimitive ?
			(expect: 'primitive') => Promise<JSONSerializablePrimitive> :
		T[K] extends unknown[] ?
			(expect: 'array') => Promise<ToValuizableObject<T[K]>> :
		T[K] extends object ?
			(expect: 'object') => Promise<ToValuizableObject<T[K]>> :
		T[K] extends (infer U | undefined) ?
			ToValuizable<U> | undefined :
		never;
};
type ToValuizable<T> = ToValuizableObject<{ tmp: T }>['tmp'];

type ToJSONValuizableObject<T extends object> = {
	[K in keyof T]: (
		T[K] extends object ?
			ToJSONValuizableObject<T[K]> :
		T[K] extends (object | undefined) ?
			ToJSONValuizableObject<NonNullable<T[K]>> | undefined :
		T[K]
	) | ExternalURL;
};
type ToJSONValuizable<T> = ToJSONValuizableObject<{ tmp: T }>['tmp'];

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

const assertServiceMetadata = createAssert<ToJSONValuizable<ServiceMetadata>>();

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

	/**
	 * Format the supplied Metadata as appropriate to be included
	 * within the Metadata field of a KeetaNet acccount to serve
	 * as the Metadata for the Resolver.
	 */
	static formatMetadata(metadata: ToJSONValuizable<ServiceMetadata>): string;
	// eslint-disable-next-line @typescript-eslint/unified-signatures
	static formatMetadata(metadata: JSONSerializable): string;
	static formatMetadata(metadata: JSONSerializable | ToJSONValuizable<ServiceMetadata>): string {
		return(Buffer.from(JSON.stringify(metadata)).toString('base64'));
	}

	/**
	 * Assert that the supplied value is a valid Metadata Root Object
	 */
	static assertMetadata(value: unknown): asserts value is ToJSONValuizable<ServiceMetadata> {
		assertServiceMetadata(value);
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
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			instance: config.cache?.instance ?? new Map() satisfies URLCacheObject as URLCacheObject,
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
		/*
		 * JSON.parse() will always return a JSONSerializable,
		 * and not `unknown`, so we can safely cast it.
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
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

		let account: KeetaNetAccount | string;
		try {
			account = KeetaNetClient.lib.Account.fromPublicKeyString(accountString);
		} catch {
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

	private async readHTTPSURL(url: URL): Promise<JSONSerializable> {
		this.#stats.https.reads++;

		const results = await fetch(url.toString(), {
			method: 'GET',
			headers: {
				'Accept': 'application/json'
			}
		});

		if (!results.ok) {
			throw(new Error(`Error HTTP status ${results.status} ${results.statusText} for ${url.toString()}`));
		}

		if (results.status === 204) {
			/*
			 * 204 No Content is a valid response, so we return an empty
			 * object.
			 */
			return({});
		}

		if (results.status !== 200) {
			throw(new Error(`Unexpected HTTP status ${results.status} for ${url.toString()}`));
		}

		const metadata = JSON.stringify(await results.json());

		this.#logger?.debug(`Resolver:${this.#resolver.id}`, 'Read URL', url.toString(), ':', metadata);

		const retval = await this.parseMetadata(metadata);

		return(retval);
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

		/*
		 * Verify that the cache entry is still valid.  If it is not,
		 * then remove it from the cache.
		 */
		let cacheVal = this.#cache.instance.get(cacheKey);

		if (this.#cache.instance.has(cacheKey) && cacheVal !== undefined) {
			if (cacheVal.expires < new Date()) {
				this.#cache.instance.delete(cacheKey);
				cacheVal = undefined;
			}
		}

		if (cacheVal !== undefined) {
			this.#stats.cache.hit++;

			if (cacheVal.pass) {
				return(cacheVal.value);
			} else {
				throw(cacheVal.error);
			}
		}

		this.#stats.cache.miss++;

		let retval: JSONSerializable;
		try {
			const protocol = url.protocol;
			if (protocol === 'keetanet:') {
				retval = await this.readKeetaNetURL(url);
			} else if (protocol === 'https:') {
				retval = await this.readHTTPSURL(url);
			} else {
				this.#stats.unsupported.reads++;
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
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

					if (Array.isArray(newValue)) {
						throw(new Error('internal error: newValue is an array, but it should be an object since it is an external field, which can  only be an object'));
					}
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

					/*
					 * TypeScript doesn't track that `key`
					 * is a valid index regardless of the
					 * type of `newValue` is an array or an
					 * object, so we need to use `@ts-ignore`
					 */
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
	async value(expect: 'any'): Promise<ValuizeInput>;
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
	unsupported: {
		reads: number;
	};
	reads: number;
	cache: {
		hit: number;
		miss: number;
	}
};

type ResolverLookupBankingResults = { [id: string]: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]> };
type ResolverLookupKYCResults = { [id: string]: ToValuizableObject<NonNullable<ServiceMetadata['services']['kyc']>[string]> };
const assertResolverLookupBankingResult = function(input: unknown): ResolverLookupBankingResults[string] {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
	}

	if (!('operations' in input)) {
		throw(new Error('Expected "operations" key in KYC service, but it was not found'));
	}

	if ((typeof input.operations !== 'object' || input.operations === null) && typeof input.operations !== 'function') {
		throw(new Error(`Expected "operations" to be an object | function, got ${typeof input.operations}`));
	}

	if (typeof input.operations !== 'function') {
		for (const [operation, operationValue] of Object.entries(input.operations)) {
			if (typeof operation !== 'string') {
				throw(new Error(`Expected "operations" to be an object with string keys, got ${typeof operation}`));
			}

			if (typeof operationValue !== 'string') {
				throw(new Error(`Expected "operations.${operation}" to be a string, got ${typeof operationValue}`));
			}
		}
	}

	if (!('countryCodes' in input)) {
		throw(new Error('Expected "countryCodes" to be present, but it was not found'));
	}

	if (typeof input.countryCodes !== 'function' && !Array.isArray(input.countryCodes)) {
		throw(new Error(`Expected "countryCodes" to be an array | function, got ${typeof input.countryCodes}`));
	}

	if (Array.isArray(input.countryCodes)) {
		for (const countryCode of input.countryCodes) {
			if (typeof countryCode !== 'string') {
				throw(new Error(`Expected "countryCodes" to be an array of strings, got ${typeof countryCode}`));
			}
		}
	}

	if (!('currencyCodes' in input)) {
		throw(new Error('Expected "currencyCodes" to be present, but it was not found'));
	}

	if (Array.isArray(input.currencyCodes)) {
		for (const currencyCode of input.currencyCodes) {
			if (typeof currencyCode !== 'string') {
				throw(new Error(`Expected "currencyCodes" to be an array of strings, got ${typeof currencyCode}`));
			}
		}
	}

	if ('kycProviders' in input) {
		if (typeof input.kycProviders !== 'function' && !Array.isArray(input.kycProviders)) {
			throw(new Error(`Expected "kycProviders" to be an array | function, got ${typeof input.kycProviders}`));
		}

		if (Array.isArray(input.kycProviders)) {
			for (const kycProvider of input.kycProviders) {
				if (typeof kycProvider !== 'string') {
					throw(new Error(`Expected "kycProviders" to be an array of strings, got ${typeof kycProvider}`));
				}
			}
		}
	}

	// @ts-ignore
	return(input);

};
const assertResolverLookupKYCResult = function(input: unknown): ResolverLookupKYCResults[string] {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
	}

	if (!('operations' in input)) {
		throw(new Error('Expected "operations" key in KYC service, but it was not found'));
	}

	if ((typeof input.operations !== 'object' || input.operations === null) && typeof input.operations !== 'function') {
		throw(new Error(`Expected "operations" to be an object | function, got ${typeof input.operations}`));
	}

	if (typeof input.operations !== 'function') {
		for (const [operation, operationValue] of Object.entries(input.operations)) {
			if (typeof operation !== 'string') {
				throw(new Error(`Expected "operations" to be an object with string keys, got ${typeof operation}`));
			}

			if (typeof operationValue !== 'string') {
				throw(new Error(`Expected "operations.${operation}" to be a string, got ${typeof operationValue}`));
			}
		}
	}

	if (!('ca' in input)) {
		throw(new Error('Expected "ca" key in KYC service, but it was not found'));
	}

	if (typeof input.ca !== 'string' && typeof input.ca !== 'function') {
		throw(new Error(`Expected "ca" to be a string | function, got ${typeof input.ca}`));
	}

	if ('countryCodes' in input) {
		if (typeof input.countryCodes !== 'function' && !Array.isArray(input.countryCodes)) {
			throw(new Error(`Expected "countryCodes" to be an array | function, got ${typeof input.countryCodes}`));
		}

		if (Array.isArray(input.countryCodes)) {
			for (const countryCode of input.countryCodes) {
				if (typeof countryCode !== 'string') {
					throw(new Error(`Expected "countryCodes" to be an array of strings, got ${typeof countryCode}`));
				}
			}
		}
	}

	// @ts-ignore
	return(input);
};

class Resolver {
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
			unsupported: {
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
	_mutableStats(accessToken: symbol) {
		if (accessToken !== statsAccessToken) {
			throw(new Error('Invalid access token'));
		}

		return(this.#stats);
	}

	get stats(): ResolverStats {
		return(structuredClone(this.#stats));
	}

	private async lookupBankingServices(bankingServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'banking'>) {
		if (bankingServices === undefined) {
			return(undefined);
		}

		const retval: ResolverLookupBankingResults = {};
		for (const checkBankingServiceID in bankingServices) {
			try {
				const checkBankingService = await bankingServices[checkBankingServiceID]?.('object');
				if (checkBankingService === undefined) {
					continue;
				}

				if (!('operations' in checkBankingService)) {
					continue;
				}

				if (criteria.currencyCodes !== undefined) {
					const currencyCodes = await checkBankingService.currencyCodes?.('array') ?? [];
					const checkBankingServiceCurrencyCodes = await Promise.all(currencyCodes.map(async function(item) {
						return(await item?.('primitive'));
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
					const countryCodes = await checkBankingService.countryCodes?.('array') ?? [];
					const checkBankingServiceCountryCodes = await Promise.all(countryCodes.map(async function(item) {
						return(await item?.('primitive'));
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

				retval[checkBankingServiceID] = assertResolverLookupBankingResult(checkBankingService);
			} catch (checkBankingServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking banking service', checkBankingServiceID, ':', checkBankingServiceError, ' -- ignoring');
			}
		}

		if (Object.keys(retval).length === 0) {
			/*
			 * If we didn't find any banking services, then we return
			 * undefined to indicate that no services were found.
			 */
			return(undefined);
		}

		return(retval);
	}

	private async lookupKYCServices(kycServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'kyc'>) {
		if (kycServices === undefined) {
			return(undefined);
		}

		const retval: ResolverLookupKYCResults = {};
		for (const checkKYCServiceID in kycServices) {
			try {
				const checkKYCService = await kycServices[checkKYCServiceID]?.('object');
				if (checkKYCService === undefined) {
					continue;
				}

				if (!('operations' in checkKYCService)) {
					continue;
				}

				if (criteria.countryCodes !== undefined) {
					let acceptable = true;
					/*
					 * If the KYC service does not have a countryCodes
					 * property, then it can validate accounts in any
					 * country, so we skip this check.
					 */
					if ('countryCodes' in checkKYCService) {
						const countryCodes = await checkKYCService.countryCodes?.('array') ?? [];
						const checkKYCServiceCountryCodes = await Promise.all(countryCodes.map(async function(item) {
							return(await item?.('string'));
						}));
						this.#logger?.debug(`Resolver:${this.id}`, 'Checking country codes:', criteria.countryCodes, 'against', checkKYCServiceCountryCodes, 'for', checkKYCServiceID);

						for (const checkCountryCode of criteria.countryCodes) {
							const checkCountryCodeCanonical = convertToCountrySearchCanonical(checkCountryCode);
							if (!checkKYCServiceCountryCodes.includes(checkCountryCodeCanonical)) {
								acceptable = false;
								break;
							}
						}
					}

					if (!acceptable) {
						continue;
					}
				}

				retval[checkKYCServiceID] = assertResolverLookupKYCResult(checkKYCService);
			} catch (checkKYCServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking KYC service', checkKYCServiceID, ':', checkKYCServiceError, ' -- ignoring');
			}
		}

		if (Object.keys(retval).length === 0) {
			/*
			 * If we didn't find any banking services, then we return
			 * undefined to indicate that no services were found.
			 */
			return(undefined);
		}

		return(retval);
	}

	async lookup<T extends 'banking'>(service: T, criteria: ServiceSearchCriteria<'banking'>): Promise<ResolverLookupBankingResults | undefined>;
	async lookup<T extends 'kyc'>(service: T, criteria: ServiceSearchCriteria<'kyc'>): Promise<ResolverLookupKYCResults | undefined>;
	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<ResolverLookupBankingResults | ResolverLookupKYCResults | undefined>;
	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<ResolverLookupBankingResults | ResolverLookupKYCResults | undefined> {
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

		/*
		 * We need to create a link between the service type and the
		 * search criteria type, so we can use the correct type
		 * for the criteria -- to do that we create an object
		 * that links them together.
		 */
		type LookupArgs = {
			[S in Services]: { service: S; criteria: ServiceSearchCriteria<S> }
		}[Services];
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const args = { service, criteria } as LookupArgs;

		this.#logger?.debug(`Resolver:${this.id}`, 'Looking up', args.service, 'with criteria:', args.criteria, 'in', definedServices);
		switch (args.service) {
			case 'banking': {
				const currentCriteria = args.criteria;
				const bankingServices = await definedServices.banking?.('object');
				this.#logger?.debug(`Resolver:${this.id}`, 'Banking Services:', bankingServices);

				return(await this.lookupBankingServices(bankingServices, currentCriteria));
			}
			case 'kyc': {
				const currentCriteria = args.criteria;
				const kycServices = await definedServices.kyc?.('object');
				this.#logger?.debug(`Resolver:${this.id}`, 'KYC Services:', kycServices);

				return(await this.lookupKYCServices(kycServices, currentCriteria));
			}
			case 'fx':
			case 'inbound':
			case 'outbound':
			case 'cards':
				throw(new Error('not implemented'));
			default:
				assertNever(args);
		}
	}

	clearCache(): void {
		this.#metadataCache.instance.clear();
		this.#stats.cache.hit = 0;
		this.#stats.cache.miss = 0;
		this.#stats.https.reads = 0;
		this.#stats.keetanet.reads = 0;
		this.#stats.unsupported.reads = 0;
		this.#stats.reads = 0;
	}
}

export default Resolver;
export type {
	ServiceMetadata,
	ServiceSearchCriteria,
	Services
};
