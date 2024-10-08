import * as KeetaNetClient from '@keetapay/keetanet-client';
import * as CurrencyInfo from '@keetapay/currency-info';

type KeetaNetAccount = InstanceType<typeof KeetaNetClient.lib.Account>;

type CurrencySearchInput = CurrencyInfo.ISOCurrencyCode | CurrencyInfo.ISOCurrencyNumber | CurrencyInfo.Currency;
type CurrencySearchCanonical = CurrencyInfo.ISOCurrencyCode; /* XXX:TODO */
type CountrySearchInput = CurrencyInfo.ISOCountryCode | CurrencyInfo.ISOCountryNumber | CurrencyInfo.Country;
type CountrySearchCanonical = CurrencyInfo.ISOCountryCode; /* XXX:TODO */

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

export class Resolver {
	#root: ResolverConfig['root'];
	#trustedCAs: ResolverConfig['trustedCAs'];
	#client: KeetaNetClient.Client;

	constructor(config: ResolverConfig) {
		this.#root = config.root;
		this.#trustedCAs = config.trustedCAs;

		if (KeetaNetClient.Client.isInstance(config.client)) {
			this.#client = config.client;
		} else {
			this.#client = config.client.client;
		}
	}

	async lookup<T extends Services>(service: T, criteria: ServiceSearchCriteria<T>): Promise<void> {
		throw(new Error('not implemented'));
	}
}

export default Resolver;
