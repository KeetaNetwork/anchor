import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.ts';
import Resolver from '../../lib/resolver.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType, ServiceMetadataEndpoint, ServiceSearchCriteria, SharedLookupCriteria } from '../../lib/resolver.ts';
import { createAssertEquals } from 'typia';
import type { BrandedString } from '../../lib/utils/brand.ts';
import { KeetaAnchorError, KeetaAnchorUserValidationError } from '../../lib/error.js';
import { SignData } from '../../lib/utils/signing.js';
import type {
	TransferUsernameOwnershipSignablePayload,
	KeetaUsernameAnchorClaimRequestPayload,
	KeetaUsernameAnchorUsernameWithAccount,
	KeetaUsernameAnchorSearchRequestParameters,
	KeetaUsernameAnchorResolveResponseJSON
} from './common.js';
import {
	isKeetaUsernameAnchorResolveResponseJSON,
	isKeetaUsernameAnchorClaimResponseJSON,
	parseGloballyIdentifiableUsername,
	getUsernameClaimSignable,
	validateUsernameDefault,
	type KeetaNetAccount,
	type GloballyIdentifiableUsername,
	isGloballyIdentifiableUsername,
	isKeetaNetPublicKeyString,
	Errors,
	getUsernameTransferSignable,
	getUsernameReleaseSignable,
	isKeetaUsernameAnchorReleaseResponseJSON,
	formatGloballyIdentifiableUsername,
	isKeetaUsernameAnchorSearchResponseJSON
} from './common.js';
import type { ExtractOk, HTTPSignedField } from '../../lib/http-server/common.js';
import { assertNever } from '../../lib/utils/never.js';

export type KeetaUsernameAnchorClientConfig = {
	id?: string;
	logger?: Logger | undefined;
	resolver?: Resolver;
	signer?: InstanceType<typeof KeetaNetLib.Account>;
	account?: InstanceType<typeof KeetaNetLib.Account>;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

type ProviderID = BrandedString<'UsernameProviderID'>;

const KeetaUsernameAnchorClientAccessToken = Symbol('KeetaUsernameAnchorClientAccessToken');

const assertServiceMetadataEndpoint = createAssertEquals<ServiceMetadataEndpoint>();

function typedUsernameServiceEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.entries(obj) as [keyof T, T[keyof T]][]);
}

type KeetaUsernameAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['username']>[string]['operations']]?: {
		url: (params?: { [key: string]: string; }) => URL;
		options: {
			authentication: ServiceMetadataAuthenticationType;
		};
	};
};

type KeetaUsernameServiceInfo = {
	operations: {
		[operation in keyof KeetaUsernameAnchorOperations]: Promise<KeetaUsernameAnchorOperations[operation]>;
	};
	usernamePattern?: string;
};

type GetEndpointsResult = {
	[id in ProviderID]: KeetaUsernameServiceInfo;
};


type ClaimUsernameOptions = {
	account?: KeetaNetAccount | undefined;
	transfer?: {
		from: KeetaNetAccount | string;
		signed?: HTTPSignedField;
	};
};

function validateURL(url: string | undefined): URL {
	if (!url) {
		throw(new Error('Invalid URL: empty value'));
	}

	return(new URL(url));
}

async function getEndpoints(resolver: Resolver, criteria: ServiceSearchCriteria<'username'>, shared?: SharedLookupCriteria, logger?: Logger): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('username', criteria, shared);
	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaUsernameServiceInfo]> {
		const operations = await serviceInfo.operations('object');
		const operationsFunctions: Partial<KeetaUsernameServiceInfo['operations']> = {};
		for (const [key, operation] of Object.entries(operations)) {
			if (operation === undefined) {
				continue;
			}

			Object.defineProperty(operationsFunctions, key, {
				get: async function() {
					const endpoint = assertServiceMetadataEndpoint(await Resolver.Metadata.fullyResolveValuizable(operation));

					let url: string;
					let authentication: ServiceMetadataAuthenticationType = {
						method: 'keeta-account',
						type: 'none'
					};

					if (typeof endpoint === 'string') {
						url = endpoint;
					} else {
						url = endpoint.url;
						if (endpoint.options?.authentication) {
							authentication = endpoint.options.authentication;
						}
					}

					return({
						url: function(params?: { [key: string]: string; }): URL {
							let substitutedURL: string;
							try {
								substitutedURL = decodeURI(url);
							} catch (error) {
								logger?.debug('UsernameAnchor:getEndpoints', 'Failed to decode URI, using original URL for substitution', error, url);
								substitutedURL = url;
							}

							for (const [paramKey, paramValue] of Object.entries(params ?? {})) {
								substitutedURL = substitutedURL.replace(`{${paramKey}}`, encodeURIComponent(paramValue));
							}

							return(validateURL(substitutedURL));
						},
						options: { authentication }
					});
				},
				enumerable: true,
				configurable: true
			});
		}

		if (!Object.prototype.hasOwnProperty.call(operationsFunctions, 'resolve')) {
			throw(new Error('Username service is missing resolve operation'));
		}

		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as unknown as ProviderID,
			{
				operations: operationsFunctions,
				...(await (async () => {
					const pattern = await serviceInfo.usernamePattern?.('string');
					if (pattern !== undefined) {
						return({ usernamePattern: pattern });
					}

					return({});
				})())
			}
		]);
	});

	if (serviceInfoPromises.length === 0) {
		return(null);
	}

	const entries = await Promise.all(serviceInfoPromises);

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.fromEntries(entries) as GetEndpointsResult);
}

interface KeetaUsernameAnchorBaseConfig {
	client: KeetaNetUserClient;
	logger?: Logger | undefined;
	account?: InstanceType<typeof KeetaNetLib.Account> | undefined;
	signer?: InstanceType<typeof KeetaNetLib.Account> | undefined;
}

class KeetaUsernameAnchorBase {
	protected readonly client: KeetaNetUserClient;
	protected readonly logger?: Logger | undefined;
	protected readonly account?: InstanceType<typeof KeetaNetLib.Account> | undefined;
	protected readonly signer?: InstanceType<typeof KeetaNetLib.Account> | undefined;

	constructor(config: KeetaUsernameAnchorBaseConfig) {
		this.client = config.client;
		this.logger = config.logger;
		this.account = config.account;
		this.signer = config.signer;
	}
}

export interface KeetaUsernameAnchorUsernameWithAccountAndProvider extends KeetaUsernameAnchorUsernameWithAccount {
	providerID: ProviderID;
	globallyIdentifiableUsername: GloballyIdentifiableUsername;
}

class KeetaUsernameAnchorProvider extends KeetaUsernameAnchorBase {
	readonly serviceInfo: KeetaUsernameServiceInfo;
	readonly providerID: ProviderID;
	readonly #usernamePattern?: RegExp;
	private readonly parent: KeetaUsernameAnchorClient;

	constructor(serviceInfo: KeetaUsernameServiceInfo, providerID: ProviderID, parent: KeetaUsernameAnchorClient) {
		const parentInternals = parent._internals(KeetaUsernameAnchorClientAccessToken);
		super(parentInternals);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
		this.parent = parent;
		if (serviceInfo.usernamePattern !== undefined) {
			try {
				this.#usernamePattern = new RegExp(serviceInfo.usernamePattern);
			} catch (error) {
				throw(new Error(`Invalid usernamePattern metadata for provider ${String(providerID)}: ${error instanceof Error ? error.message : String(error)}`));
			}
		}
	}

	get usernamePattern(): string | undefined {
		return(this.#usernamePattern?.source);
	}

	/**
	 * Check if a username is valid according to the provider's username pattern if set and default validation.
	 * @param username The username to check
	 * @returns True if the username is valid, false otherwise
	 */
	isUsernameValid(username: string): boolean {
		try {
			validateUsernameDefault(username, {
				pattern: this.#usernamePattern,
				fieldPath: 'username'
			});
			return(true);
		} catch (error) {
			if (error instanceof KeetaAnchorUserValidationError) {
				return(false);
			}

			throw(error);
		}
	}

	#assertProviderIssuedNameValid(username: string): void {
		validateUsernameDefault(username, {
			pattern: this.#usernamePattern,
			fieldPath: 'username'
		});
	}

	async #getOperation<Name extends keyof KeetaUsernameAnchorOperations>(operationName: Name): Promise<NonNullable<KeetaUsernameAnchorOperations[Name]>> {
		const operationGetter = this.serviceInfo.operations[operationName];
		if (operationGetter === undefined) {
			throw(new Error(`Username provider does not support ${operationName} operation`));
		}

		const endpoint = await operationGetter;
		if (endpoint === undefined) {
			throw(new Error(`Username provider does not support ${operationName} operation`));
		}

		if (endpoint.options.authentication.method !== 'keeta-account') {
			throw(new Error(`Unsupported authentication method: ${endpoint.options.authentication.method}`));
		}

		return(endpoint);
	}

	async #parseResponseError(data: unknown): Promise<Error> {
		try {
			return(await KeetaAnchorError.fromJSON(data));
		} catch (error) {
			this.logger?.debug('UsernameAnchor', 'Failed to parse error response', error, data);

			if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
				return(new Error(data.error));
			}

			return(new Error('Username provider request failed'));
		}
	}

	#toKeetaUsernameAnchorUsernameWithAccountAndProvider(response: Pick<ExtractOk<KeetaUsernameAnchorResolveResponseJSON>, 'username' | 'account'>): KeetaUsernameAnchorUsernameWithAccountAndProvider {
		return({
			account: KeetaNetLib.Account.toAccount(response.account),
			username: response.username,
			providerID: this.providerID,
			globallyIdentifiableUsername: formatGloballyIdentifiableUsername(response.username, String(this.providerID))
		});
	}

	/**
	 * Resolve a username for a specific provider
	 * @param input The value to lookup, can be a username, PublicKeyString, or an account
	 * @returns The resolved account and username, or null if not found
	 */
	async resolve(input: string | KeetaNetAccount): Promise<KeetaUsernameAnchorUsernameWithAccountAndProvider | null> {
		let toResolveString;
		if (typeof input === 'string') {
			toResolveString = input;
		} else {
			toResolveString = input.publicKeyString.get();
		}
		if (!(isKeetaNetPublicKeyString(toResolveString))) {
			this.#assertProviderIssuedNameValid(toResolveString);
		}

		const endpoint = await this.#getOperation('resolve');
		if (endpoint.options.authentication.type === 'required') {
			throw(new Error('Username provider requires authentication which is not supported by the client'));
		}

		const serviceURL = endpoint.url({ toResolve: toResolveString });
		const response = await fetch(serviceURL);

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse username provider response as JSON: ${error}`));
		}

		if (!isKeetaUsernameAnchorResolveResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from username provider'));
		}

		if (!responseJSON.ok) {
			const responseError = await this.#parseResponseError(responseJSON);

			if (Errors.UserNotFound.isInstance(responseError)) {
				return(null);
			}

			throw(responseError);
		}

		const retval = this.#toKeetaUsernameAnchorUsernameWithAccountAndProvider(responseJSON);

		if (isKeetaNetPublicKeyString(toResolveString)) {
			if (!(retval.account.comparePublicKey(toResolveString))) {
				throw(new Error('Resolved account does not match the requested account'));
			}
		} else {
			if (retval.username !== toResolveString) {
				throw(new Error('Resolved username does not match the requested username'));
			}
		}

		return(retval);
	}

	/**
	 * Claim a username for a specific provider
	 * @param usernameInput The username to claim
	 * @param options The account to claim for, and options related to transfer if applicable
	 * @returns True if the claim was successful, false otherwise
	 */
	async claimUsername(usernameInput: string, options?: ClaimUsernameOptions): Promise<boolean> {
		let username: string;
		if (isGloballyIdentifiableUsername(usernameInput)) {
			const parsed = parseGloballyIdentifiableUsername(usernameInput);
			if (parsed.providerID !== String(this.providerID)) {
				throw(new Error(`Provider ID in username input does not match this provider's ID`));
			}

			username = parsed.username;
		} else {
			username = usernameInput;
		}

		this.#assertProviderIssuedNameValid(username);

		const endpoint = await this.#getOperation('claim');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Username claim operation must require account authentication'));
		}

		const accountToUse = options?.account ?? this.account ?? this.signer;
		if (!accountToUse) {
			throw(new Error('Account is required to claim a username'));
		}

		const request: KeetaUsernameAnchorClaimRequestPayload = {
			username,
			account: accountToUse
		}

		if (options?.transfer) {
			const from = KeetaNetLib.Account.toAccount(options.transfer.from);

			let signed = options.transfer.signed;

			if (!signed) {
				if (!from.hasPrivateKey) {
					throw(new Error('Transfer "from" account must have a private key when signature is not provided'));
				}

				const signable = getUsernameTransferSignable({
					username,
					from: from,
					to: accountToUse
				});

				signed = await SignData(from.assertAccount(), signable);
			}

			request.transfer = { from, signed };
		}

		const signed = await SignData(accountToUse.assertAccount(), getUsernameClaimSignable(request));

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				username: username,
				account: accountToUse.publicKeyString.get(),
				transfer: request.transfer ? {
					from: request.transfer.from.publicKeyString.get(),
					signed: request.transfer.signed
				} : undefined,
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse username claim response as JSON: ${error}`));
		}

		if (!isKeetaUsernameAnchorClaimResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from username provider claim endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return(responseJSON.ok);
	}

	/**
	 * Release a username for a specific provider
	 * @param options The account to claim for, and options related to transfer if applicable
	 * @returns True if the claim was successful, false otherwise
	 */
	async releaseUsername(input?: { account?: KeetaNetAccount; }): Promise<boolean> {
		const endpoint = await this.#getOperation('release');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Username claim operation must require account authentication'));
		}

		const accountToUse = input?.account ?? this.account ?? this.signer;
		if (!accountToUse) {
			throw(new Error('Account is required to claim a username'));
		}

		const signed = await SignData(accountToUse.assertAccount(), getUsernameReleaseSignable({ account: accountToUse }));

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				account: accountToUse.publicKeyString.get(),
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse username claim response as JSON: ${error}`));
		}

		if (!isKeetaUsernameAnchorReleaseResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from username provider claim endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return(responseJSON.ok);
	}

	/**
	 * Release a username for a specific provider
	 * @param options The account to claim for, and options related to transfer if applicable
	 * @returns True if the claim was successful, false otherwise
	 */
	async search(parameters: KeetaUsernameAnchorSearchRequestParameters): Promise<{ results: KeetaUsernameAnchorUsernameWithAccountAndProvider[]; }> {
		const endpoint = await this.#getOperation('search');

		if (endpoint.options.authentication.type !== 'none') {
			throw(new Error('Username search operation does not currently support authenticated endpoints'));
		}

		const urlWithParameters = (() => {
			const reconstructed = new URL(endpoint.url().toString());
			reconstructed.searchParams.set('search', parameters.search);
			return(reconstructed);
		})();

		const response = await fetch(urlWithParameters, {
			method: 'GET',
			headers: { 'Accept': 'application/json' }
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse username claim response as JSON: ${error}`));
		}

		if (!isKeetaUsernameAnchorSearchResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from username provider claim endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		const results = responseJSON.results.map((result) => {
			this.#assertProviderIssuedNameValid(result.username);

			return(this.#toKeetaUsernameAnchorUsernameWithAccountAndProvider(result));
		});

		return({ results });
	}
}

class KeetaUsernameAnchorClient extends KeetaUsernameAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;

	constructor(client: KeetaNetUserClient, config: KeetaUsernameAnchorClientConfig = {}) {
		super({ client, logger: config.logger, account: config.account, signer: config.signer });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
	}

	async #lookup(criteria: ServiceSearchCriteria<'username'> = {}, shared?: SharedLookupCriteria): Promise<KeetaUsernameAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, criteria, shared, this.logger);
		if (endpoints === null) {
			return(null);
		}

		const providers = typedUsernameServiceEntries(endpoints).map(([providerID, serviceInfo]) => {
			return(new KeetaUsernameAnchorProvider(serviceInfo, providerID, this));
		});

		if (providers.length === 0) {
			return(null);
		}

		return(providers);
	}

	async getProvider(providerID: string, shared?: SharedLookupCriteria): Promise<KeetaUsernameAnchorProvider | null> {
		const mergedSharedCriteria: SharedLookupCriteria = {
			...shared,
			providerIDs: shared?.providerIDs !== undefined ? Array.from(new Set([...shared.providerIDs, providerID])) : [providerID]
		};
		const providers = await this.#lookup({}, mergedSharedCriteria);
		return(providers?.[0] ?? null);
	}

	async #requireProvider(providerID: string, shared?: SharedLookupCriteria): Promise<KeetaUsernameAnchorProvider> {
		const provider = await this.getProvider(providerID, shared);
		if (!provider) {
			throw(new Error(`Username provider ${providerID} not found`));
		}

		return(provider);
	}

	/**
	 * Resolve a globally identifiable username via the appropriate provider.
	 * @param username The globally identifiable username to resolve
	 * @param shared Shared resolver lookup criteria
	 * @returns The resolution result, or null if not found
	 */
	async resolve(username: GloballyIdentifiableUsername, shared?: SharedLookupCriteria): ReturnType<KeetaUsernameAnchorProvider['resolve']> {
		const { username: normalizedUsername, providerID } = parseGloballyIdentifiableUsername(username);
		const provider = await this.#requireProvider(providerID, shared);

		return(await provider.resolve(normalizedUsername));
	}

	/**
	 * Resolve against all username providers for the given input.
	 * @param input The value to search for, either a globally identifiable username, a username, or an account
	 * @param shared Shared lookup criteria
	 * @returns A mapping of provider IDs to their resolution results, or null if no providers found a match
	 */
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	async resolveMulti(input: string | KeetaNetAccount | GloballyIdentifiableUsername, shared?: SharedLookupCriteria): Promise<({
		[providerId: ProviderID]: Awaited<ReturnType<KeetaUsernameAnchorProvider['resolve']>>;
	}) | null> {
		if (isGloballyIdentifiableUsername(input)) {
			const { providerID } = parseGloballyIdentifiableUsername(input);
			const resolved = await this.resolve(input, shared);
			if (!resolved) {
				return(null);
			}

			return({
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				[providerID as unknown as ProviderID]: resolved
			});
		}

		const providers = await this.#lookup({}, shared);

		if (!providers) {
			return(null);
		}

		let foundOne = false;
		const response: {
			[providerId: ProviderID]: NonNullable<Awaited<ReturnType<KeetaUsernameAnchorProvider['resolve']>>>;
		} = {};

		await Promise.all(providers.map(async (provider) => {
			try {
				const result = await provider.resolve(input);
				if (result !== null) {
					foundOne = true;
					response[provider.providerID] = result;
				}
			} catch (error) {
				this.logger?.debug('UsernameAnchor:resolveMulti', `Error resolving username with provider ${String(provider.providerID)}`, error);
			}
		}));

		if (!foundOne) {
			return(null);
		}

		return(response);
	}

	/**
	 * Resolve against all username providers for the given input.
	 * @param input The value to search for, either a globally identifiable username, a username, or an account
	 * @param shared Shared lookup criteria
	 * @returns A mapping of provider IDs to their resolution results, or null if no providers found a match
	 */

	async search(parameters: KeetaUsernameAnchorSearchRequestParameters, responseType: 'separate', shared?: SharedLookupCriteria): Promise<({ [providerId: ProviderID]: Awaited<ReturnType<KeetaUsernameAnchorProvider['search']>>; }) | null>;
	async search(parameters: KeetaUsernameAnchorSearchRequestParameters, responseType?: 'joined', shared?: SharedLookupCriteria): Promise<Awaited<ReturnType<KeetaUsernameAnchorProvider['search']>> | null>;
	async search(parameters: KeetaUsernameAnchorSearchRequestParameters, responseType: 'joined' | 'separate' = 'joined', shared?: SharedLookupCriteria) {
		const providers = await this.#lookup({}, shared);

		if (!providers) {
			return(null);
		}

		const response: {
			[providerId: ProviderID]: NonNullable<Awaited<ReturnType<KeetaUsernameAnchorProvider['search']>>>;
		} = {};

		await Promise.all(providers.map(async (provider) => {
			try {
				response[provider.providerID] = await provider.search(parameters);
			} catch (error) {
				this.logger?.debug('UsernameAnchor:search', `Error resolving username with provider ${String(provider.providerID)}`, error);
			}
		}));

		if (responseType === 'separate') {
			return(response);
		} else if (responseType === 'joined') {
			const joinedResults: KeetaUsernameAnchorUsernameWithAccountAndProvider[] = [];
			for (const providerResponse of Object.values(response)) {
				// For some reason TypeScript loses the type information here, even though it is correctly inferred in the loop above. We have to manually assert the type to get the correct typings for results.
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				const results = (providerResponse as typeof response[keyof typeof response]).results;
				joinedResults.push(...results);
			}

			return({ results: joinedResults });
		} else {
			assertNever(responseType);
		}
	}

	/**
	 * Claim a globally identifiable username from the appropriate provider.
	 * @param input The globally identifiable username to claim
	 * @param options Claim options
	 * @returns True if the claim was successful, false otherwise
	 */
	async claimUsername(input: GloballyIdentifiableUsername, options?: ClaimUsernameOptions, shared?: SharedLookupCriteria): ReturnType<KeetaUsernameAnchorProvider['claimUsername']> {
		const { username, providerID } = parseGloballyIdentifiableUsername(input);
		const provider = await this.#requireProvider(providerID, shared);
		return(await provider.claimUsername(username, options));
	}

	async signUsernameTransfer(request: Omit<TransferUsernameOwnershipSignablePayload, 'from'>, from?: KeetaNetAccount): Promise<HTTPSignedField> {
		const accountToUse = from ?? this.signer ?? this.account;
		if (!accountToUse) {
			throw(new Error('Signer or account is required to sign username transfer'));
		}

		const signable = getUsernameTransferSignable({
			...request,
			from: accountToUse
		});

		return(await SignData(accountToUse.assertAccount(), signable));
	}

	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaUsernameAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			client: this.client,
			logger: this.logger,
			resolver: this.resolver,
			account: this.account,
			signer: this.signer
		});
	}
}

export default KeetaUsernameAnchorClient;
export { KeetaUsernameAnchorProvider };
