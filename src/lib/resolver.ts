import * as KeetaNetClient from '@keetanetwork/keetanet-client';
import type { GenericAccount as KeetaNetGenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import * as CurrencyInfo from '@keetanetwork/currency-info';
import type { Logger } from './log/index.ts';
import type { JSONSerializable } from './utils/json.ts';
import type { DeepPartial } from './utils/types.ts';
import { assertNever } from './utils/never.js';
import { Buffer } from './utils/buffer.js';
import crypto from './utils/crypto.js';

import { createIs, createAssert } from 'typia';
import { convertAssetLocationInputToCanonical, type MovableAssetSearchInput, type AssetLocationString, type AssetWithRailsMetadata, type Rail, type SupportedAssets, convertAssetOrPairSearchInputToCanonical } from '../services/asset-movement/common.js';

type ExternalURL = { external: '2b828e33-2692-46e9-817e-9b93d63f28fd'; url: string; };

type KeetaNetAccount = InstanceType<typeof KeetaNetClient.lib.Account>;
const KeetaNetAccount: typeof KeetaNetClient.lib.Account = KeetaNetClient.lib.Account;
type KeetaNetAccountTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetClient.lib.Account<typeof KeetaNetAccount.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;

/**
 * Canonical form of a currency code for use in the ServiceMetadata
 * Which is either the ISO currency code (e.g. "USD", "EUR", "JPY")
 * or a cryptocurrency code prefixed with a dollar sign (e.g. "$BTC", "$ETH")
 */
type ServiceMetadataCurrencyCodeCanonical = CurrencyInfo.ISOCurrencyCode | `$${string}`;
/**
 * Input types which can be used to search for which token represents
 * a given currency or cryptocurrency.
 */
type CurrencySearchInput = ServiceMetadataCurrencyCodeCanonical | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = ServiceMetadataCurrencyCodeCanonical;
type CountrySearchInput = CurrencyInfo.ISOCountryCode | CurrencyInfo.ISOCountryNumber | CurrencyInfo.Country;
type CountrySearchCanonical = CurrencyInfo.ISOCountryCode; /* XXX:TODO */

const isCurrencySearchCanonical = createIs<CurrencySearchCanonical>();

type ServiceMetadataAuthenticationType = {
	method: 'keeta-account';
	type: 'required' | 'optional' | 'none';
};
type ServiceMetadataEndpoint = string | { url: string; options?: { authentication?: ServiceMetadataAuthenticationType; }}
// #region Global Service Metadata
/**
 * Service Metadata General Structure
 */
type ServiceMetadata = {
	version: number;
	/**
	 * Map of the currency code to the token public key which
	 * represents that currency.
	 */
	currencyMap: {
		[currencyCode in ServiceMetadataCurrencyCodeCanonical]?: KeetaNetAccountTokenPublicKeyString;
	};
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
		/**
		 * Foreign Exchange (FX) services
		 *
		 * This is used to identify service providers which
		 * can convert currency from one currency to another.
		 */
		fx?: {
			/**
			 * Provider ID which identifies the FX provider
			 */
			[id: string]: {
				operations: {
					/**
					 * Get an estimate for a currency
					 * conversion (optional)
					 */
					getEstimate?: string;
					/**
					 * Get a quote for a currency
					 * conversion
					 */
					getQuote: string;
					/**
					 * Create an exchange to convert
					 * currency
					 */
					createExchange: string;
					/**
					 * Get the status of an exchange
					 * which was previously created
					 */
					getExchangeStatus: string;
				};
				/**
				 * Path for which can be used to identify which
				 * currencies this FX provider can convert
				 * between.
				 */
				from: {
					/**
					 * Currency code which this FX provider can
					 * convert from
					 */
					currencyCodes: KeetaNetAccountTokenPublicKeyString[];
					/**
					 * Currency codes which this FX provider can
					 * convert to from the `from.currencyCode`
					 */
					to: KeetaNetAccountTokenPublicKeyString[];
					/**
					 * KYC providers which this FX provider
					 * supports (DN) -- if not specified,
					 * then it does not require KYC.
					 */
					kycProviders?: string[];
				}[];
			}
		};
		assetMovement?: {
			[id: string]: {
				operations: {
					initiateTransfer?: ServiceMetadataEndpoint;
					getTransferStatus?: ServiceMetadataEndpoint;
					createPersistentForwardingTemplate?: ServiceMetadataEndpoint;
					listPersistentForwardingTemplate?: ServiceMetadataEndpoint;
					createPersistentForwarding?: ServiceMetadataEndpoint;
					listPersistentForwarding?: ServiceMetadataEndpoint;
					listTransactions?: ServiceMetadataEndpoint;
					shareKYC?: ServiceMetadataEndpoint;
				};

				supportedAssets: {
					asset: KeetaNetAccountTokenPublicKeyString | ServiceMetadataCurrencyCodeCanonical | ([ KeetaNetAccountTokenPublicKeyString | ServiceMetadataCurrencyCodeCanonical, KeetaNetAccountTokenPublicKeyString | ServiceMetadataCurrencyCodeCanonical ]);

					paths: {
						pair: [ AssetWithRailsMetadata, AssetWithRailsMetadata ]

						/**
						 * KYC providers which this Asset Movement Provider
						 * supports (DN) -- if not specified,
						 * then it does not require KYC.
						 */
						kycProviders?: string[];
					}[];
				}[];
			}
		};
		cards?: {
			[id: string]: {
				/* XXX:TODO */
				workInProgress?: true;
			};
		};
	};
};

type ServiceMetadataExternalizable = ToJSONValuizable<ServiceMetadata>;

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
		inputCurrencyCode?: CurrencySearchInput | KeetaNetAccountTokenPublicKeyString;
		/**
		 * Search for a provider which can convert to the following
		 * output currency
		 */
		outputCurrencyCode?: CurrencySearchInput | KeetaNetAccountTokenPublicKeyString;
		/**
		 * Search for a provider which supports ANY of the following
		 * KYC providers
		 */
		kycProviders?: string[];
	};
	'kyc': {
		/**
		 * Search for a KYC provider which can verify accounts in ALL
		 * of the following countries.
		 */
		countryCodes: CountrySearchInput[];
	};
	'assetMovement': {
		asset?: MovableAssetSearchInput | { from: MovableAssetSearchInput; to: MovableAssetSearchInput; };
		from?: AssetLocationString;
		to?: AssetLocationString;
		/**
		 * Search for a provider which supports ANY of the following rail(s)
		 */
		rail?: Rail | Rail[] | undefined;
		/**
		 * Search for a provider which supports ANY of the following
		 * KYC providers
		 */
		kycProviders?: string[];
	};
	'cards': {
		/* XXX:TODO */
		workInProgress: true;
	};
}[T];

type ResolverLookupServiceResults<Service extends Services> = { [id: string]: ToValuizableObject<NonNullable<ServiceMetadata['services'][Service]>[string]> };

type ServicesMetadataLookupMap = {
	[Service in Services]: {
		criteria: ServiceSearchCriteria<Service>;
		results: ResolverLookupServiceResults<Service>;
	};
};

function assertValidCountryCodes(input: unknown): asserts input is { countryCodes: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>['countryCodes'] } {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
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
}

function assertValidOptionalCountryCodes(input: unknown): asserts input is { countryCodes?: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>['countryCodes'] } {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
	}

	if (!('countryCodes' in input)) {
		return;
	}

	assertValidCountryCodes(input);
}

function assertValidCurrencyCodes(input: unknown): asserts input is { currencyCodes: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>['currencyCodes'] } {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
	}

	if (!('currencyCodes' in input)) {
		throw(new Error('Expected "currencyCodes" to be present, but it was not found'));
	}

	if (typeof input.currencyCodes !== 'function' && !Array.isArray(input.currencyCodes)) {
		throw(new Error(`Expected "currencyCodes" to be an array | function, got ${typeof input.currencyCodes}`));
	}

	if (Array.isArray(input.currencyCodes)) {
		for (const currencyCode of input.currencyCodes) {
			if (typeof currencyCode !== 'string') {
				throw(new Error(`Expected "currencyCodes" to be an array of strings, got ${typeof currencyCode}`));
			}
		}
	}
}

function assertValidOperationsBanking(input: unknown): asserts input is { operations: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>['operations'] } {
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
}

function assertValidOperationsKYC(input: unknown): asserts input is { operations: ToValuizableObject<NonNullable<ServiceMetadata['services']['kyc']>[string]>['operations'] } {
	/* XXX:TODO: Validate the specific operations */
	assertValidOperationsBanking(input);
}

function assertValidOperationsFX(input: unknown): asserts input is { operations: ToValuizableObject<NonNullable<ServiceMetadata['services']['fx']>[string]>['operations'] } {
	/* XXX:TODO: Validate the specific operations */
	assertValidOperationsBanking(input);
}

function assertValidOperationsAssetMovement(input: unknown): asserts input is { operations: ToValuizableObject<NonNullable<ServiceMetadata['services']['assetMovement']>[string]>['operations'] } {
	/* XXX:TODO: Validate the specific operations */
	assertValidOperationsBanking(input);
}

function assertValidOptionalKYCProviders(input: unknown): asserts input is { kycProviders?: ToValuizableObject<NonNullable<ServiceMetadata['services']['banking']>[string]>['kycProviders'] } {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
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
}

function assertValidCA(input: unknown): asserts input is { ca: ToValuizableObject<NonNullable<ServiceMetadata['services']['kyc']>[string]>['ca'] } {
	if (typeof input !== 'object' || input === null) {
		throw(new Error(`Expected an object, got ${typeof input}`));
	}

	if (!('ca' in input)) {
		throw(new Error('Expected "ca" key in KYC service, but it was not found'));
	}

	if (typeof input.ca !== 'string' && typeof input.ca !== 'function') {
		throw(new Error(`Expected "ca" to be a string | function, got ${typeof input.ca}`));
	}
}

const assertResolverLookupBankingResult = function(input: unknown): ResolverLookupServiceResults<'banking'>[string] {
	assertValidOperationsBanking(input);
	assertValidCountryCodes(input);
	assertValidCurrencyCodes(input);
	assertValidOptionalKYCProviders(input);

	return(input);

};
const assertResolverLookupKYCResult = function(input: unknown): ResolverLookupServiceResults<'kyc'>[string] {
	assertValidOperationsKYC(input);
	assertValidOptionalCountryCodes(input);
	assertValidCA(input);

	return(input);
};

const assertResolverLookupFXResult = async function(input: unknown): Promise<ResolverLookupServiceResults<'fx'>[string]> {
	assertValidOperationsFX(input);

	if (!('from' in input)) {
		throw(new Error('Expected "from" key in FX service, but it was not found'));
	}

	const fromUnrealized = input.from;
	// eslint-disable-next-line @typescript-eslint/no-use-before-define
	if (!Metadata.isValuizable(fromUnrealized)) {
		throw(new Error(`Expected "from" to be an Valuizable, got ${typeof fromUnrealized}`));
	}

	// XXX:TODO: Perform deeper validation of the "from" structure
	await fromUnrealized('array');

	// XXX:TODO: Perform deeper validation of the "from" structure
	// @ts-ignore
	return(input);
};

const assertResolverLookupAssetMovementResults = async function(input: unknown): Promise<ResolverLookupServiceResults<'assetMovement'>[string]> {
	assertValidOperationsAssetMovement(input);
	// assertValidOperationsKYC(input);
	// assertValidOptionalCountryCodes(input);
	// assertValidCA(input);
	if (!('supportedAssets' in input)) {
		throw(new Error('Expected "supportedAssets" key in asset movement service, but it was not found'));
	}

	const fromUnrealized = input.supportedAssets;
	// eslint-disable-next-line @typescript-eslint/no-use-before-define
	if (!Metadata.isValuizable(fromUnrealized)) {
		throw(new Error(`Expected "supportedAssets" to be an Valuizable, got ${typeof fromUnrealized}`));
	}

	// XXX:TODO: Perform deeper validation of the "supportedAssets" structure
	await fromUnrealized('array');

	// XXX:TODO: Perform deeper validation of the "supportedAssets" structure
	// @ts-ignore
	return(input);
};

// #endregion

// #region Validation

async function isValidOperations(input: unknown): Promise<{ operations: ValuizableMethod } | false> {
	if (typeof input !== 'object' || input === null) {
		return(false);
	}

	if (!('operations' in input)) {
		return(false);
	}

	const operations = input.operations;
	// eslint-disable-next-line @typescript-eslint/no-use-before-define
	if (!Metadata.isValuizable(operations)) {
		return(false);
	}

	return({
		...input,
		operations
	});
}

function convertToCurrencySearchCanonical(input: CurrencySearchInput): CurrencySearchCanonical {
	if (CurrencyInfo.Currency.isCurrencyCode(input)) {
		return(input);
	} else if (CurrencyInfo.Currency.isISOCurrencyNumber(input)) {
		input = new CurrencyInfo.Currency(input);
		return(input.code);
	} else if (typeof input === 'string') {
		return(input);
	} else if (input === null) {
		throw(new Error('Invalid currency input: null'));
	} else if ('code' in input) {
		return(input.code);
	} else {
		throw(new Error(`Invalid currency input: ${input}`));
	}
}

async function hasAllCurrencyCodes(input: unknown, criteria: { currencyCodes: CurrencySearchCanonical[] }): Promise<boolean> {
	// XXX:TODO: Avoid using exceptions for flow-control
	assertValidCurrencyCodes(input);

	const currencyCodes = await input.currencyCodes?.('array') ?? [];
	const inputCurrencyCodes = await Promise.all(currencyCodes.map(async function(item) {
		return(await item?.('primitive'));
	}));

	for (const checkCurrencyCode of criteria.currencyCodes) {
		const checkCurrencyCodeCanonical = convertToCurrencySearchCanonical(checkCurrencyCode);
		if (!inputCurrencyCodes.includes(checkCurrencyCodeCanonical)) {
			return(false);
		}
	}

	return(true);
}

async function hasAnyCountryCodes(input: unknown, criteria: { countryCodes: CountrySearchCanonical[] }): Promise<boolean> {
	// XXX:TODO: Avoid using exceptions for flow-control
	assertValidCountryCodes(input);

	const countryCodes = await input.countryCodes?.('array') ?? [];

	for (const countryCode of countryCodes) {
		const countryCodeValue = await countryCode?.('primitive');
		if (countryCodeValue === undefined) {
			continue;
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
		if (criteria.countryCodes.includes(countryCodeValue as any)) {
			return(true);
		}
	}

	return(false);
}

// #endregion

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

interface ValuizableMethodBase {
	(expect?: ValuizableKind): Promise<ValuizeInput>;
	(expect: 'any'): Promise<ValuizeInput>;
}

interface ToValuizableExpectPrimitive<Primitive extends JSONSerializablePrimitive = JSONSerializablePrimitive> extends ValuizableMethodBase {
	(expect: 'primitive'): Promise<Primitive>;
}

interface ValuizableMethod extends ValuizableMethodBase, ToValuizableExpectPrimitive {
	(expect: 'object'): Promise<ValuizableObject>;
	(expect: 'array'): Promise<ValuizableArray>;
	(expect: 'string'): Promise<string>;
	(expect: 'number'): Promise<number>;
	(expect: 'boolean'): Promise<boolean>;
};

interface ToValuizableExpectString extends ValuizableMethodBase, ToValuizableExpectPrimitive<string> {
	(expect: 'string'): Promise<string>;
};

interface ToValuizableExpectNumber extends ValuizableMethodBase, ToValuizableExpectPrimitive<number> {
	(expect: 'number'): Promise<number>;
};

interface ToValuizableExpectBoolean extends ValuizableMethodBase, ToValuizableExpectPrimitive<boolean> {
	(expect: 'boolean'): Promise<boolean>;
};

interface ToValuizableExpectObject<T> extends ValuizableMethodBase {
	(expect: 'object'): Promise<T>;
}

interface ToValuizableExpectArray<T extends unknown[]> extends ValuizableMethodBase {
	(expect: 'array'): Promise<T>;
}

/* eslint-disable @stylistic/indent */
type ToValuizable<T> =
	T extends string ? ToValuizableExpectString :
	T extends number ? ToValuizableExpectNumber :
	T extends boolean ? ToValuizableExpectBoolean :
	T extends JSONSerializablePrimitive ? ToValuizableExpectPrimitive<T> :
	T extends unknown[] ? ToValuizableExpectArray<{ [K in keyof T]: ToValuizable<T[K]> }> :
	T extends object ? ToValuizableExpectObject<ToValuizableObject<T>> :
	T extends undefined ? undefined :
	never;

type ToValuizableObject<T extends object> = {
	[K in keyof T]: ToValuizable<T[K]>;
};

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

type ValuizeResolvable = JSONSerializablePrimitive | ValuizableObject | ValuizableArray | ValuizableMethod;

/*
 * Access token to share with the Metadata object to allow it to
 * access the mutable stats object.
 */
const statsAccessToken = Symbol('statsAccessToken');

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


type ResolverConfig = {
	/**
	 * The "root" account(s) to use as the basis for all lookups.  It should
	 * contain the authoritative information for resolving in its
	 * Metadata.
	 *
	 * Can be either:
	 * - A single KeetaNetGenericAccount
	 * - An array of KeetaNetGenericAccount in priority order (highest priority first)
	 *
	 * When an array is provided, the resolver will merge results from all roots,
	 * with entries from higher priority roots taking precedence over lower priority ones.
	 */
	root: KeetaNetGenericAccount | KeetaNetGenericAccount[];
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
const assertKeetaSupportedAssets = createAssert<SupportedAssets[]>();

/**
 * Instance type ID for anonymous Valuizable methods created dynamically
 */
const ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID = 'Anonymous:6e69d6db-9263-466d-9c96-4b92ced498bd';

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
		const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf-8');
		const metadataCompressed = KeetaNetClient.lib.Utils.Buffer.ZlibDeflate(KeetaNetClient.lib.Utils.Helper.bufferToArrayBuffer(metadataBytes));
		const metadataEncoded = Buffer.from(metadataCompressed).toString('base64');

		return(metadataEncoded);
	}

	/**
	 * Assert that the supplied value is a valid Metadata Root Object
	 */
	static assertMetadata(value: unknown): asserts value is ToJSONValuizable<ServiceMetadata> {
		assertServiceMetadata(value);
	}

	/**
	 * Check if the supplied value is a Valuizable method which can
	 * be called to resolve a Valuizable value.
	 */
	static isValuizable(value: unknown): value is ValuizableMethod {
		if (typeof value === 'object' && value !== null) {
			return(false);
		}

		if (typeof value !== 'function') {
			return(false);
		}

		// @ts-ignore
		if (!('instanceTypeID' in value)) {
			return(false);
		}

		if (value.instanceTypeID === Metadata.instanceTypeID) {
			return(true);
		}

		if (value.instanceTypeID === ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID) {
			return(true);
		}

		return(false);
	}

	/**
	 * Recursively resolve a Valuizable value into a fully
	 * realized JSONSerializable value.  This will walk the
	 * entire structure, calling each Valuizable method
	 * and replacing it with the returned value.
	 *
	 * This should only be used in cases where the entire
	 * structure needs to be fully realized, as it
	 * can be quite expensive.
	 */
	static async fullyResolveValuizable(value: ValuizeResolvable, invalidReplacement?: JSONSerializable): Promise<JSONSerializable>;
	// eslint-disable-next-line @typescript-eslint/unified-signatures,@typescript-eslint/no-explicit-any
	static async fullyResolveValuizable(value: any, invalidReplacement?: JSONSerializable): Promise<JSONSerializable>;
	static async fullyResolveValuizable(value: ValuizeResolvable, invalidReplacement: JSONSerializable = null): Promise<JSONSerializable> {
		if (typeof value === 'object' && value !== null) {
			if (Array.isArray(value)) {
				const newArray: JSONSerializable[] = [];
				for (let i = 0; i < value.length; i++) {
					const entry = value[i];
					if (Metadata.isValuizable(entry)) {
						const newEntry = await Metadata.fullyResolveValuizable(entry);
						newArray.push(newEntry);
					} else if (entry === undefined) {
						throw(new Error(`Array entry ${i} is undefined, which is not valid in JSON`));
					} else {
						assertNever(entry);
					}
				}

				return(newArray);
			} else {
				const newObject: { [key: string]: JSONSerializable; } = {};
				for (const key in value) {
					/*
					 * Since `key` is the index of the array or
					 * object, it is safe to use it to index
					 * into the array or object.
					 */
					// @ts-ignore
					const entry = value[key];
					if (Metadata.isValuizable(entry)) {
						const newEntry = await Metadata.fullyResolveValuizable(entry);
						newObject[key] = newEntry;
					} else if (entry === undefined) {
						throw(new Error(`Object key "${key}" is undefined, which is not valid in JSON`));
					} else {
						assertNever(entry);
					}
				}

				return(newObject);
			}
		}

		if (Metadata.isValuizable(value)) {
			try {
				const retval = await value('any');
				return(await Metadata.fullyResolveValuizable(retval));
			} catch {
				return(invalidReplacement);
			}
		}

		switch (typeof value) {
			case 'string':
			case 'number':
			case 'boolean':
				return(value);
			case 'object':
				if (value === null) {
					return(value);
				}
				assertNever(value);
				break;
			default:
				assertNever(value);
		}

		throw(new Error('invalid input'));
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

	/**
	 * @param metadata Metadata to parse -- base64 encoded string or ArrayBuffer
	 */
	private async parseMetadata(metadata: string | ArrayBuffer): Promise<JSONSerializable> {
		if (typeof metadata === 'string') {
			metadata = KeetaNetClient.lib.Utils.Helper.bufferToArrayBuffer(Buffer.from(metadata, 'base64'));
		}

		/*
		 * Attempt to decompress the metadata.  If it fails, then
		 * assume it is not compressed.
		 */
		let metadataUncompressed: ArrayBuffer;
		try {
			metadataUncompressed = KeetaNetClient.lib.Utils.Buffer.ZlibInflate(metadata);
		} catch {
			metadataUncompressed = metadata;
		}

		const metadataBytes = Buffer.from(metadataUncompressed);
		const metadataDecoded = metadataBytes.toString('utf-8');

		/*
		 * JSON.parse() will always return a JSONSerializable,
		 * and not `unknown`, so we can safely cast it.
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const retval = await this.resolveValue(JSON.parse(metadataDecoded) as JSONSerializable);

		return(retval);
	}

	private async readKeetaNetURL(url: URL): Promise<JSONSerializable> {
		const accountString = url.hostname;
		const path = url.pathname;

		this.#stats.keetanet.reads++;

		if (path !== '/metadata') {
			throw(new Error(`Unsupported path: ${path}`));
		}

		let account: KeetaNetGenericAccount | string;
		try {
			account = KeetaNetClient.lib.Account.fromPublicKeyString(accountString);
		} catch {
			return('');
		}

		const accountInfo = await this.#client.getAccountInfo(account);
		const metadata = accountInfo.info.metadata;
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

		const metadata = await (await results.blob()).arrayBuffer();

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
			return(null);
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
					if (Array.isArray(newValue)) {
						throw(new Error('internal error: newValue is an array, but it should be an object since it is an external field, which can only be an object'));
					}

					const newMetadataObject = new Metadata(keyValue.url, {
						trustedCAs: this.#trustedCAs,
						client: this.#client,
						logger: this.#logger,
						resolver: this.#resolver,
						cache: this.#cache,
						parent: this
					});

					const newValuizableObject: ValuizableMethod = newMetadataObject.value.bind(newMetadataObject);

					Object.defineProperty(newValuizableObject, 'instanceTypeID', {
						value: ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID,
						enumerable: false
					});

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

					Object.defineProperty(newValueEntry, 'instanceTypeID', {
						value: ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID,
						enumerable: false
					});

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

type SharedLookupCriteria = { providerIDs?: string[]; };

class Resolver {
	readonly #roots: KeetaNetGenericAccount[];
	readonly #trustedCAs: ResolverConfig['trustedCAs'];
	readonly #client: KeetaNetClient.Client;
	readonly #logger: Logger | undefined;
	readonly #stats: ResolverStats;
	readonly #metadataCache: NonNullable<MetadataConfig['cache']>;

	readonly id: string;

	static readonly Metadata: typeof Metadata = Metadata;

	private readonly lookupMap: {
		[Service in Services]: {
			search: (input: ValuizableObject | undefined, criteria: ServiceSearchCriteria<Service>) => Promise<ResolverLookupServiceResults<Service> | undefined>;
		};
	} = {
		'banking': {
			search: this.lookupBankingServices.bind(this)
		},
		'kyc': {
			search: this.lookupKYCServices.bind(this)
		},
		'fx': {
			search: this.lookupFXServices.bind(this)
		},
		'assetMovement': {
			search: this.lookupAssetMovementServices.bind(this)
		},
		'cards': {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			search: async (_input: ValuizableObject | undefined, _criteria: ServiceSearchCriteria<'cards'>) => {
				throw(new Error('not implemented'));
			}
		}
	};


	constructor(config: ResolverConfig) {
		this.#roots = Array.isArray(config.root) ? config.root : [config.root];
		this.#trustedCAs = config.trustedCAs;
		this.#logger = config.logger;
		this.#metadataCache = {
			...config.cache,
			instance: new Map()
		};

		this.id = config.id ?? crypto.randomUUID();

		const rootAccountStrings = this.#roots.map(root => root.publicKeyString.get()).join(', ');
		this.#logger?.debug(`Resolver:${this.id}`, 'Creating resolver with root account(s)', rootAccountStrings);

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

		let canonicalCurrencyCriteria;
		if ('currencyCodes' in criteria) {
			canonicalCurrencyCriteria = {
				currencyCodes: criteria.currencyCodes.map(convertToCurrencySearchCanonical)
			}
		}

		let canonicalCountryCriteria;
		if ('countryCodes' in criteria) {
			canonicalCountryCriteria = {
				countryCodes: criteria.countryCodes.map(convertToCountrySearchCanonical)
			}
		}

		const retval: ResolverLookupServiceResults<'banking'> = {};
		for (const checkBankingServiceID in bankingServices) {
			try {
				const checkBankingService = await isValidOperations(await bankingServices[checkBankingServiceID]?.('object'));
				if (!checkBankingService) {
					continue;
				}

				if (canonicalCurrencyCriteria !== undefined && 'currencyCodes' in checkBankingService) {
					if (!(await hasAllCurrencyCodes(checkBankingService, canonicalCurrencyCriteria))) {
						continue;
					}
				}

				if (canonicalCountryCriteria !== undefined && 'countryCodes' in checkBankingService) {
					if (!(await hasAnyCountryCodes(checkBankingService, canonicalCountryCriteria))) {
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

		const retval: ResolverLookupServiceResults<'kyc'> = {};
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

	private async lookupFXServices(fxServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'fx'>): Promise<ResolverLookupServiceResults<'fx'> | undefined> {
		if (fxServices === undefined) {
			return(undefined);
		}

		const isCurrencySearchInput = createIs<CurrencySearchInput>();
		// if currency code is provided then convert to canonical format otherwise token public key string was provided
		const canonicalInputCurrencyCriteria = isCurrencySearchInput(criteria.inputCurrencyCode) ? convertToCurrencySearchCanonical(criteria.inputCurrencyCode) : criteria.inputCurrencyCode;
		const canonicalOutputCurrencyCriteria = isCurrencySearchInput(criteria.outputCurrencyCode) ? convertToCurrencySearchCanonical(criteria.outputCurrencyCode) : criteria.outputCurrencyCode;
		// if search criteria is not provided then set token to undefined
		const inputToken = canonicalInputCurrencyCriteria !== undefined ? await this.lookupToken(canonicalInputCurrencyCriteria) : undefined;
		const outputToken = canonicalOutputCurrencyCriteria !== undefined ? await this.lookupToken(canonicalOutputCurrencyCriteria) : undefined;
		if (criteria.inputCurrencyCode !== undefined && inputToken === null) {
			this.#logger?.debug(`Resolver:${this.id}`, 'Input currency code', canonicalInputCurrencyCriteria, 'could not be resolved to a token');
			return(undefined);
		}

		if (criteria.outputCurrencyCode !== undefined && outputToken === null) {
			this.#logger?.debug(`Resolver:${this.id}`, 'Output currency code', canonicalOutputCurrencyCriteria, 'could not be resolved to a token');
			return(undefined);
		}

		const retval: ResolverLookupServiceResults<'fx'> = {};
		for (const checkFXServiceID in fxServices) {
			try {
				const checkFXService = await assertResolverLookupFXResult(await fxServices[checkFXServiceID]?.('object'));
				if (!checkFXService) {
					continue;
				}

				const fromUnrealized: ToValuizable<NonNullable<ServiceMetadata['services']['fx']>[string]['from']> = checkFXService.from;
				const from = await fromUnrealized?.('array');
				if (from === undefined) {
					continue;
				}

				let acceptable = false;
				for (const fromEntryUnrealized of from) {
					const fromEntry = await fromEntryUnrealized?.('object');

					if (inputToken) {
						const fromCurrencyCodes = await fromEntry.currencyCodes?.('array') ?? [];
						const fromCurrencyCodesValues = await Promise.all(fromCurrencyCodes.map(async function(item) {
							try {
								return(await item?.('string'));
							} catch {
								return(undefined);
							}
						}));

						// If inputToken was provided, check if it matches providers supported input currencies
						if (!fromCurrencyCodesValues.includes(inputToken.token)) {
							continue;
						}
					}

					if (outputToken) {
						const toCurrencyCodes = await fromEntry.to?.('array') ?? [];
						const toCurrencyCodesValues = await Promise.all(toCurrencyCodes.map(async function(item) {
							try {
								return(await item?.('string'));
							} catch {
								return(undefined);
							}
						}));

						// If outputToken was provided, check if it matches providers supported output currencies
						if (!toCurrencyCodesValues.includes(outputToken.token)) {
							continue;
						}
					}

					/* XXX:TODO: Check kycProviders */
					acceptable = true;
					break;
				}

				if (!acceptable) {
					continue;
				}

				retval[checkFXServiceID] = await assertResolverLookupFXResult(checkFXService);
			} catch (checkFXServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking FX service', checkFXServiceID, ':', checkFXServiceError, ' -- ignoring');
			}
		}

		return(retval);
	}

	async filterSupportedAssets(assetService: ValuizableObject, criteria: ServiceSearchCriteria<'assetMovement'> = {}): Promise<SupportedAssets[]> {
		const assetCanonical = criteria.asset ? convertAssetOrPairSearchInputToCanonical(criteria.asset) : undefined;
		const fromCanonical = criteria.from ? convertAssetLocationInputToCanonical(criteria.from) : undefined;
		const toCanonical = criteria.to ? convertAssetLocationInputToCanonical(criteria.to) : undefined;

		const resolvedService = await Metadata.fullyResolveValuizable(assetService.supportedAssets);
		const supportedAssets = assertKeetaSupportedAssets(resolvedService);

		const filteredAssetMovement: SupportedAssets[] = [];
		for (const supportedAsset of supportedAssets) {
			let matchFound = false;

			for (const path of supportedAsset.paths) {
				const pairSorted: typeof path.pair = [ ...path.pair ];

				if (fromCanonical) {
					if (pairSorted[0]?.location !== fromCanonical) {
						pairSorted.reverse();
					}
				} else if (toCanonical) {
					if (pairSorted[1]?.location !== toCanonical) {
						pairSorted.reverse();
					}
				}

				if (fromCanonical && pairSorted[0].location !== fromCanonical) {
					continue;
				}

				if (toCanonical && pairSorted[1].location !== toCanonical) {
					continue;
				}

				if (assetCanonical) {
					if (typeof assetCanonical === 'string') {
						if (!([ pairSorted[0].id, pairSorted[1].id ].includes(assetCanonical))) {
							continue;
						}
					} else {
						if (fromCanonical || toCanonical) {
							if (pairSorted[0].id !== assetCanonical.from || pairSorted[1].id !== assetCanonical.to) {
								continue;
							}
						} else {
							const eitherId = [ pairSorted[0].id, pairSorted[1].id ];
							if (!(eitherId.includes(assetCanonical.from)) || !(eitherId.includes(assetCanonical.to))) {
								continue;
							}
						}
					}
				}

				const [ from /* , to */ ] = pairSorted;

				// XXX:TODO what rails do we want to check here? This is just inbound
				const supportedRails = [ ...(from.rails.inbound ?? []), ...(from.rails.common ?? []) ];

				if (supportedRails.length === 0) {
					continue;
				}

				if (criteria.rail !== undefined) {
					if (typeof criteria.rail === 'string') {
						if (!supportedRails.includes(criteria.rail)) {
							continue;
						}
					} else {
						let railMatchFound = false;
						for (const checkRail of criteria.rail) {
							if (supportedRails.includes(checkRail)) {
								railMatchFound = true;
								break;
							}
						}

						if (!railMatchFound) {
							continue;
						}
					}
				}

				matchFound = true;
				break;
			}

			if (matchFound) {
				filteredAssetMovement.push(supportedAsset);
			}
		}

		return(filteredAssetMovement);
	}

	private async lookupAssetMovementServices(assetServices: ValuizableObject | undefined, criteria: ServiceSearchCriteria<'assetMovement'>) {
		if (assetServices === undefined) {
			return(undefined);
		}

		const retval: ResolverLookupServiceResults<'assetMovement'> = {};
		for (const checkAssetMovementServiceID in assetServices) {
			const checkAssetMovementService = await assetServices[checkAssetMovementServiceID]?.('object');

			if (checkAssetMovementService === undefined) {
				return(undefined);
			}

			if (!('operations' in checkAssetMovementService)) {
				return(undefined);
			}

			try {
				const supportedAssets = await this.filterSupportedAssets(checkAssetMovementService, criteria);
				if (supportedAssets.length === 0) {
					continue;
				}
				retval[checkAssetMovementServiceID] = await assertResolverLookupAssetMovementResults(checkAssetMovementService);
			} catch (parseError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error checking AssetMovement service', checkAssetMovementServiceID, ':', parseError, ' -- ignoring');
			}
		}

		if (Object.keys(retval).length === 0) {
			/*
			 * If we didn't find any asset movement services, then we return
			 * undefined to indicate that no services were found.
			 */
			return(undefined);
		}

		return(retval);
	}

	async #getRootMetadata(): Promise<ValuizableObject> {
		// Fetch metadata from all roots
		const allRootMetadata: ValuizableObject[] = [];

		for (const root of this.#roots) {
			const rootURL = new URL(`keetanet://${root.publicKeyString.get()}/metadata`);
			const metadata = new Metadata(rootURL, {
				trustedCAs: this.#trustedCAs,
				client: this.#client,
				logger: this.#logger,
				resolver: this,
				cache: this.#metadataCache
			});

			try {
				const rootMetadata = await metadata.value('object');
				this.#logger?.debug(`Resolver:${this.id}`, 'Root Metadata for', root.publicKeyString.get(), ':', rootMetadata);

				if (!('version' in rootMetadata)) {
					this.#logger?.debug(`Resolver:${this.id}`, 'Root metadata for', root.publicKeyString.get(), 'is missing "version" property, skipping');
					continue;
				}

				const rootMetadataVersion = await rootMetadata.version?.('primitive');
				if (rootMetadataVersion !== 1) {
					this.#logger?.debug(`Resolver:${this.id}`, 'Unsupported metadata version', rootMetadataVersion, 'for', root.publicKeyString.get(), ', skipping');
					continue;
				}

				allRootMetadata.push(rootMetadata);
			} catch (error) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error fetching metadata for', root.publicKeyString.get(), ':', error, ' -- skipping');
			}
		}

		if (allRootMetadata.length === 0) {
			throw(new Error('No valid root metadata found'));
		}

		this.#logger?.debug(`Resolver:${this.id}`, 'Total valid root metadata count:', allRootMetadata.length);

		// If there's only one root, return it directly
		if (allRootMetadata.length === 1) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			return(allRootMetadata[0]!);
		}

		// Merge metadata from multiple roots (highest priority first)
		return(await this.#mergeRootMetadata(allRootMetadata));
	}

	/**
	 * Merge metadata from multiple roots with priority ordering.
	 * The first entry in the array has the highest priority.
	 *
	 * This method creates lazy Valuizable wrappers that defer the actual
	 * merging work until the values are accessed.
	 */
	async #mergeRootMetadata(metadataArray: ValuizableObject[]): Promise<ValuizableObject> {
		// Start with the first (highest priority) metadata as the base
		const mergedMetadata: ValuizableObject = { ...metadataArray[0] };

		// Create lazy Valuizable wrapper for currencyMap that merges on demand
		// @ts-ignore - Complex ValuizableMethod type compatibility
		const mergedCurrencyMapValuizable: ValuizableMethod = async (expect: ValuizableKind = 'any') => {
			if (expect !== 'object' && expect !== 'any') {
				throw(new Error(`Expected object type for merged currency map, got ${expect}`));
			}

			// Merge currencyMap: higher priority currencies override lower priority ones
			const mergedCurrencyMap: ValuizableObject = {};
			// Iterate in reverse order so higher priority ones overwrite
			for (let i = metadataArray.length - 1; i >= 0; i--) {
				const metadata = metadataArray[i];
				if (metadata === undefined) {
					continue;
				}
				if ('currencyMap' in metadata && metadata.currencyMap !== undefined) {
					const currencyMap = await metadata.currencyMap('object');
					for (const [currencyCode, tokenValue] of Object.entries(currencyMap)) {
						mergedCurrencyMap[currencyCode] = tokenValue;
					}
				}
			}

			return(mergedCurrencyMap);
		};
		Object.defineProperty(mergedCurrencyMapValuizable, 'instanceTypeID', {
			value: ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID,
			enumerable: false
		});

		// Create lazy Valuizable wrapper for services that merges on demand
		// @ts-ignore - Complex ValuizableMethod type compatibility
		const mergedServicesValuizable: ValuizableMethod = async (expect: ValuizableKind = 'any') => {
			if (expect !== 'object' && expect !== 'any') {
				throw(new Error(`Expected object type for merged services, got ${expect}`));
			}

			// Merge services: higher priority service entries override lower priority ones
			const mergedServices: ValuizableObject = {};
			// Iterate in reverse order so higher priority ones overwrite
			for (let i = metadataArray.length - 1; i >= 0; i--) {
				const metadata = metadataArray[i];
				if (metadata === undefined) {
					continue;
				}
				if ('services' in metadata && metadata.services !== undefined) {
					const services = await metadata.services('object');
					for (const [serviceType, serviceValue] of Object.entries(services)) {
						if (serviceValue === undefined) {
							continue;
						}

						// Get the service type object
						const serviceTypeObj = await serviceValue('object');

						// If this service type doesn't exist in merged yet, create it
						if (!(serviceType in mergedServices)) {
							mergedServices[serviceType] = serviceValue;
						} else {
							// Merge individual service IDs within this service type
							const existingServiceType = await mergedServices[serviceType]?.('object');
							if (existingServiceType === undefined) {
								mergedServices[serviceType] = serviceValue;
								continue;
							}

							const mergedServiceType: ValuizableObject = { ...existingServiceType };
							for (const [serviceId, serviceConfig] of Object.entries(serviceTypeObj)) {
								// Overwrite with current entry. Since we iterate in reverse order
								// (low priority to high priority), higher priority entries (lower index)
								// will be written last and thus take precedence.
								mergedServiceType[serviceId] = serviceConfig;
							}

							// Create a new Valuizable for the merged service type
							// @ts-ignore - Complex ValuizableMethod type compatibility
							const mergedServiceTypeValuizable: ValuizableMethod = async (expect: ValuizableKind = 'any') => {
								if (expect === 'object' || expect === 'any') {
									return(mergedServiceType);
								}
								throw(new Error(`Expected object type for merged service type, got ${expect}`));
							};
							Object.defineProperty(mergedServiceTypeValuizable, 'instanceTypeID', {
								value: ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID,
								enumerable: false
							});
							mergedServices[serviceType] = mergedServiceTypeValuizable;
						}
					}
				}
			}

			return(mergedServices);
		};
		Object.defineProperty(mergedServicesValuizable, 'instanceTypeID', {
			value: ANONYMOUS_VALUIZABLE_INSTANCE_TYPE_ID,
			enumerable: false
		});

		mergedMetadata.currencyMap = mergedCurrencyMapValuizable;
		mergedMetadata.services = mergedServicesValuizable;

		return(mergedMetadata);
	}

	async getRootMetadata(): Promise<ToValuizableObject<Pick<ServiceMetadata, 'version'> & DeepPartial<Omit<ServiceMetadata, 'version'>>>> {
		const rootMetadata = await this.#getRootMetadata();

		/*
		 * #getRootMetadata validates that the version type exists
		 * and the return type for this function is complicated
		 * but everything is a partial or a function (which is
		 * correct because we processed it through the Metadata
		 * class).
		 *
		 * To avoid repeating the complicated type, we just
		 * cast as `any` here since it does not affect runtime
		 * behavior or the types (because the type is already
		 * asserted in the function signature).
		 */
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions,@typescript-eslint/no-unsafe-return,@typescript-eslint/no-explicit-any
		return(rootMetadata as any);
	}

	async listTransferableAssets(): Promise<KeetaNetAccountTokenPublicKeyString[]> {
		const rootMetadata = await this.#getRootMetadata();
		const servicesFn = rootMetadata.services;
		if (servicesFn === undefined) {
			throw(new Error('Root metadata is missing "services" property'));
		}
		const services = await servicesFn('object');
		if (!('assetMovement' in services) || services.assetMovement === undefined) {
			throw(new Error('Root metadata is missing "assetMovement" property'));
		}
		const assetMovementServices = await services.assetMovement('object');
		const allAssets = new Set<KeetaNetAccountTokenPublicKeyString>();
		await Promise.all(Object.values(assetMovementServices).map(async (service) => {
			if (service === undefined) {
				throw(new Error('assetMovement has undefined service entry'));
			}
			const serviceEntry = await service('object');
			if (!('supportedAssets' in serviceEntry) || serviceEntry.supportedAssets === undefined) {
				throw(new Error('service entry is missing "supportedAssets"'));
			}

			const supportedAssets = await serviceEntry.supportedAssets('array');
			await Promise.all(supportedAssets.map(async (supportedAsset) => {
				if (supportedAsset === undefined) {
					throw(new Error('supportedAsset entry is undefined'));
				}
				const assetEntry = await supportedAsset('object');
				if (!('asset' in assetEntry) || assetEntry.asset === undefined) {
					throw(new Error('asset is missing from supportedAsset entry'));
				}
				const asset = await assetEntry.asset('any');

				let toAddAssets;
				if (typeof asset === 'string') {
					toAddAssets = [ asset ];
				} else if (Array.isArray(asset) && asset[0] && asset[1]) {
					toAddAssets = [ await asset[0]('string'), await asset[1]('string') ];
				} else {
					throw(new Error('unsupported asset type in supportedAsset entry'));
				}

				for (const asset of toAddAssets) {
					try {
						const checkTokenObject = KeetaNetAccount.fromPublicKeyString(asset);
						if (!checkTokenObject.isToken()) {
							throw(new Error('Not a token account'));
						}
						allAssets.add(checkTokenObject.publicKeyString.get());
					} catch (error) {
						this.#logger?.debug(`Resolver:${this.id}`, 'Invalid token public key in supportedAsset entry:', asset, ' -- ignoring:', error);
					}
				}
			}));
		}));

		return([...allAssets]);
	}

	async listTokens(): Promise<{ token: KeetaNetAccountTokenPublicKeyString; currency: CurrencySearchCanonical; }[]> {
		const rootMetadata = await this.#getRootMetadata();

		/*
		 * Get the services object
		 */
		const definedCurrenciesMapProperty = rootMetadata.currencyMap;
		if (definedCurrenciesMapProperty === undefined) {
			throw(new Error('Root metadata is missing "currencyMap" property'));
		}
		const definedCurrenciesMap = await definedCurrenciesMapProperty('object');

		this.#logger?.debug(`Resolver:${this.id}`, 'Defined Currencies Map:', definedCurrenciesMap);

		const retval: { token: KeetaNetAccountTokenPublicKeyString; currency: CurrencySearchCanonical; }[] = [];
		for (const [checkCurrencyCode, checkTokenProperty] of Object.entries(definedCurrenciesMap)) {
			const checkToken = await checkTokenProperty?.('string');
			if (checkToken === undefined) {
				continue;
			}

			if (!isCurrencySearchCanonical(checkCurrencyCode)) {
				continue;
			}

			try {
				const checkTokenObject = KeetaNetAccount.fromPublicKeyString(checkToken);
				if (!checkTokenObject.isToken()) {
					throw(new Error('Not a token account'));
				}

				retval.push({
					token: checkTokenObject.publicKeyString.get(),
					currency: checkCurrencyCode
				});
			} catch (validationError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Token public key for currency code', checkCurrencyCode, 'is invalid:', validationError);
			}
		}

		return(retval);
	}

	async listSupportedKYCCountries(): Promise<CurrencyInfo.Country[]> {
		const rootMetadata = await this.#getRootMetadata();

		/*
		 * Get the services object
		 */
		const definedServicesProperty = rootMetadata.services;
		if (definedServicesProperty === undefined) {
			throw(new Error('Root metadata is missing "services" property'));
		}
		const definedServices = await definedServicesProperty('object');

		const kycServicesProperty = definedServices.kyc;
		if (kycServicesProperty === undefined) {
			return([]);
		}

		const kycServices = await kycServicesProperty('object');

		this.#logger?.debug(`Resolver:${this.id}`, 'Listing supported KYC countries from', Object.keys(kycServices));

		const allCountryCodes = new Set<CurrencyInfo.ISOCountryCode>();
		for (const kycServiceID in kycServices) {
			try {
				const kycService = await kycServices[kycServiceID]?.('object');
				if (kycService === undefined) {
					continue;
				}

				/*
				 * If the KYC service does not have a countryCodes
				 * property, then it can validate accounts in any
				 * country, so we add all countries and stop processing
				 * other services since we already have all possible countries.
				 */
				if (!('countryCodes' in kycService)) {
					for (const countryCode of CurrencyInfo.Country.allCountryCodes) {
						allCountryCodes.add(countryCode);
					}
					break;
				}

				const countryCodes = await kycService.countryCodes?.('array') ?? [];
				const countryCodesValues = await Promise.all(countryCodes.map(async function(item) {
					return(await item?.('string'));
				}));

				for (const countryCode of countryCodesValues) {
					if (countryCode === undefined) {
						continue;
					}

					try {
						// Validate that it's a valid country code
						const validatedCountryCode = CurrencyInfo.Country.assertCountryCode(countryCode);
						allCountryCodes.add(validatedCountryCode);
					} catch (validationError) {
						this.#logger?.debug(`Resolver:${this.id}`, 'Invalid country code', countryCode, 'in service', kycServiceID, ':', validationError);
					}
				}
			} catch (kycServiceError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Error processing KYC service', kycServiceID, ':', kycServiceError, ' -- ignoring');
			}
		}

		const retval = Array.from(allCountryCodes).map(function(countryCode) {
			return(new CurrencyInfo.Country(countryCode));
		});

		return(retval);
	}

	async lookupToken(currencyCode: CurrencySearchInput | KeetaNetAccountTokenPublicKeyString): Promise<{ token: KeetaNetAccountTokenPublicKeyString; currency: CurrencySearchCanonical; } | null> {
		let tokenPublicKey: KeetaNetAccountTokenPublicKeyString | undefined;
		if (typeof currencyCode === 'string') {
			try {
				const token = KeetaNetAccount.fromPublicKeyString(currencyCode);
				if (token.isToken()) {
					tokenPublicKey = token.publicKeyString.get();
				}
			} catch {
				/* Ignored */
			}
		}

		const rootMetadata = await this.#getRootMetadata();

		/*
		 * Get the services object
		 */
		const definedCurrenciesMapProperty = rootMetadata.currencyMap;
		if (definedCurrenciesMapProperty === undefined) {
			throw(new Error('Root metadata is missing "currencyMap" property'));
		}
		const definedCurrenciesMap = await definedCurrenciesMapProperty('object');

		this.#logger?.debug(`Resolver:${this.id}`, 'Defined Currencies Map:', definedCurrenciesMap);

		let currencyCodeFound: CurrencySearchCanonical | undefined;
		if (tokenPublicKey === undefined) {
			this.#logger?.debug(`Resolver:${this.id}`, 'Performing forward lookup for currency code', currencyCode);

			/*
			 * Perform a forward lookup from the currency code
			 * to the token public key
			 */
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
			const currencyCodeCanonical = convertToCurrencySearchCanonical(currencyCode as unknown as any);
			if (currencyCodeCanonical === undefined) {
				return(null);
			}

			const checkToken = await definedCurrenciesMap[currencyCodeCanonical]?.('string');
			if (checkToken === undefined) {
				return(null);
			}

			this.#logger?.debug(`Resolver:${this.id}`, 'Validating token public key for currency code', currencyCodeCanonical, ':', checkToken, typeof checkToken);
			try {
				const checkTokenObject = KeetaNetAccount.fromPublicKeyString(checkToken);
				if (!checkTokenObject.isToken()) {
					throw(new Error('Not a token account'));
				}

				tokenPublicKey = checkTokenObject.publicKeyString.get();
				currencyCodeFound = currencyCodeCanonical;
			} catch (validationError) {
				this.#logger?.debug(`Resolver:${this.id}`, 'Token public key for currency code', currencyCodeCanonical, 'is invalid:', validationError);

				return(null);
			}
		} else {
			this.#logger?.debug(`Resolver:${this.id}`, 'Performing reverse lookup for token public key', tokenPublicKey);

			/*
			 * Perform a reverse lookup from the token public key
			 * to the currency code
			 */
			for (const [checkCurrencyCode, checkTokenProperty] of Object.entries(definedCurrenciesMap)) {
				const checkToken = await checkTokenProperty?.('string');
				if (checkToken === undefined) {
					continue;
				}

				if (checkToken === tokenPublicKey) {
					if (isCurrencySearchCanonical(checkCurrencyCode)) {
						currencyCodeFound = checkCurrencyCode;
						break;
					}
				}
			}

			if (currencyCodeFound === undefined) {
				return(null);
			}
		}

		return({
			token: tokenPublicKey,
			currency: currencyCodeFound
		});
	}

	async lookup<T extends keyof ServicesMetadataLookupMap>(service: T, criteria: ServicesMetadataLookupMap[T]['criteria'], sharedCriteria?: SharedLookupCriteria): Promise<ServicesMetadataLookupMap[T]['results'] | undefined> {
		const rootMetadata = await this.#getRootMetadata();

		/*
		 * Get the services object
		 */
		const definedServicesProperty = rootMetadata.services;
		if (definedServicesProperty === undefined) {
			throw(new Error('Root metadata is missing "services" property'));
		}
		const definedServices = await definedServicesProperty('object');

		this.#logger?.debug(`Resolver:${this.id}`, 'Looking up', service, 'with criteria:', criteria, 'in', definedServices);


		const definedServicesObject = await definedServices[service]?.('object');

		let filteredDefinedServicesObject: ValuizableObject | undefined;
		if (sharedCriteria?.providerIDs !== undefined && definedServicesObject) {
			filteredDefinedServicesObject = {};
			for (const providerID of sharedCriteria.providerIDs) {
				if (providerID in definedServicesObject) {
					filteredDefinedServicesObject[providerID] = definedServicesObject[providerID];
				}
			}
		} else {
			filteredDefinedServicesObject = definedServicesObject;
		}

		const serviceLookup = this.lookupMap[service].search;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
		return(await serviceLookup(filteredDefinedServicesObject, criteria as any));
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
	ServiceMetadataExternalizable,
	ServiceSearchCriteria,
	ServiceMetadataEndpoint,
	ServiceMetadataAuthenticationType,
	Services,
	SharedLookupCriteria
};
