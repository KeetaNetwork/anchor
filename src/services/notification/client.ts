import type { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { getDefaultResolver } from '../../config.js';
import type {
	UserClient as KeetaNetUserClient
} from '@keetanetwork/keetanet-client';
import type { Logger } from '../../lib/log/index.js';
import Resolver from '../../lib/resolver.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType, ServiceMetadataEndpoint, ServiceSearchCriteria, SharedLookupCriteria } from '../../lib/resolver.js';
import { createAssertEquals } from 'typia';
import type { BrandedString } from '../../lib/utils/brand.js';
import { KeetaAnchorError } from '../../lib/error.js';
import { SignData } from '../../lib/utils/signing.js';
import type {
	KeetaNotificationAnchorRegisterTargetClientRequest,
	KeetaNotificationAnchorListTargetsClientRequest,
	KeetaNotificationAnchorDeleteTargetClientRequest,
	KeetaNotificationAnchorCreateSubscriptionClientRequest,
	KeetaNotificationAnchorListSubscriptionsClientRequest,
	KeetaNotificationAnchorDeleteSubscriptionClientRequest,
	NotificationTargetWithIDResponse,
	SubscriptionDetailsWithID,
	NotificationChannelArguments
} from './common.js';
import {
	getNotificationRegisterTargetRequestSignable,
	getNotificationListTargetsRequestSignable,
	getNotificationDeleteTargetRequestSignable,
	getNotificationCreateSubscriptionRequestSignable,
	getNotificationListSubscriptionsRequestSignable,
	getNotificationDeleteSubscriptionRequestSignable,
	isKeetaNotificationAnchorRegisterTargetResponseJSON,
	isKeetaNotificationAnchorListTargetsResponseJSON,
	isKeetaNotificationAnchorDeleteTargetResponseJSON,
	isKeetaNotificationAnchorCreateSubscriptionResponseJSON,
	isKeetaNotificationAnchorListSubscriptionsResponseJSON,
	isKeetaNotificationAnchorDeleteSubscriptionResponseJSON,
	parseSubscriptionDetailsWithIDJSON
} from './common.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import { addSignatureToURL } from '../../lib/http-server/common.js';

export type KeetaNotificationAnchorClientConfig = {
	id?: string;
	logger?: Logger | undefined;
	resolver?: Resolver;
	account?: InstanceType<typeof KeetaNetLib.Account>;
} & Omit<NonNullable<Parameters<typeof getDefaultResolver>[1]>, 'client'>;

type ProviderID = BrandedString<'NotificationProviderID'>;

const KeetaNotificationAnchorClientAccessToken = Symbol('KeetaNotificationAnchorClientAccessToken');

const assertServiceMetadataEndpoint = createAssertEquals<ServiceMetadataEndpoint>();

type KeetaNotificationAnchorOperations = {
	[operation in keyof NonNullable<ServiceMetadata['services']['notification']>[string]['operations']]?: {
		url: (params?: { [key: string]: string; }) => URL;
		options: {
			authentication: ServiceMetadataAuthenticationType;
		};
	};
};

type KeetaNotificationServiceInfo = {
	operations: {
		[operation in keyof KeetaNotificationAnchorOperations]: Promise<KeetaNotificationAnchorOperations[operation]>;
	};
};

type GetEndpointsResult = {
	[id in ProviderID]: KeetaNotificationServiceInfo;
};

function validateURL(url: string | undefined): URL {
	if (!url) {
		throw(new Error('Invalid URL: empty value'));
	}

	return(new URL(url));
}

async function getEndpoints(resolver: Resolver, criteria: ServiceSearchCriteria<'notification'>, shared?: SharedLookupCriteria, logger?: Logger): Promise<GetEndpointsResult | null> {
	const response = await resolver.lookup('notification', criteria, shared);
	if (response === undefined) {
		return(null);
	}

	const serviceInfoPromises = Object.entries(response).map(async function([id, serviceInfo]): Promise<[ProviderID, KeetaNotificationServiceInfo]> {
		const operations = await serviceInfo.operations('object');
		const operationsFunctions: Partial<KeetaNotificationServiceInfo['operations']> = {};
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
								logger?.debug('NotificationAnchor:getEndpoints', 'Failed to decode URI, using original URL for substitution', error, url);
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

		return([
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			id as unknown as ProviderID,
			{ operations: operationsFunctions }
		]);
	});

	if (serviceInfoPromises.length === 0) {
		return(null);
	}

	const entries = await Promise.all(serviceInfoPromises);

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(Object.fromEntries(entries) as GetEndpointsResult);
}

interface KeetaNotificationAnchorBaseConfig {
	client: KeetaNetUserClient;
	logger?: Logger | undefined;
	account?: InstanceType<typeof KeetaNetLib.Account> | undefined;
}

class KeetaNotificationAnchorBase {
	protected readonly client: KeetaNetUserClient;
	protected readonly logger?: Logger | undefined;
	protected readonly account?: InstanceType<typeof KeetaNetLib.Account> | undefined;

	constructor(config: KeetaNotificationAnchorBaseConfig) {
		this.client = config.client;
		this.logger = config.logger;
		this.account = config.account;
	}
}

class KeetaNotificationAnchorProvider extends KeetaNotificationAnchorBase {
	readonly serviceInfo: KeetaNotificationServiceInfo;
	readonly providerID: ProviderID;

	constructor(serviceInfo: KeetaNotificationServiceInfo, providerID: ProviderID, parent: KeetaNotificationAnchorClient) {
		const parentInternals = parent._internals(KeetaNotificationAnchorClientAccessToken);
		super(parentInternals);

		this.serviceInfo = serviceInfo;
		this.providerID = providerID;
	}

	async #getOperation<Name extends keyof KeetaNotificationAnchorOperations>(operationName: Name): Promise<NonNullable<KeetaNotificationAnchorOperations[Name]>> {
		const operationGetter = this.serviceInfo.operations[operationName];
		if (operationGetter === undefined) {
			throw(new Error(`Notification provider does not support ${operationName} operation`));
		}

		const endpoint = await operationGetter;
		if (endpoint === undefined) {
			throw(new Error(`Notification provider does not support ${operationName} operation`));
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
			this.logger?.debug('NotificationAnchor', 'Failed to parse error response', error, data);

			if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
				return(new Error(data.error));
			}

			return(new Error('Notification provider request failed'));
		}
	}

	#resolveAccount(account?: InstanceType<typeof KeetaNetLib.Account>): InstanceType<typeof KeetaNetLib.Account> {
		const accountToUse = account ?? this.account;
		if (!accountToUse) {
			throw(new Error('Account is required for this operation'));
		}

		return(accountToUse);
	}

	async registerTarget(input: KeetaNotificationAnchorRegisterTargetClientRequest & { channel: NotificationChannelArguments }): Promise<{ id: string }> {
		const endpoint = await this.#getOperation('registerTarget');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification registerTarget operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationRegisterTargetRequestSignable(input));

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				account: accountToUse.publicKeyString.get(),
				channel: input.channel,
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification registerTarget response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorRegisterTargetResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider registerTarget endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ id: responseJSON.id });
	}

	async listTargets(input?: KeetaNotificationAnchorListTargetsClientRequest): Promise<{ targets: NotificationTargetWithIDResponse[] }> {
		const endpoint = await this.#getOperation('listTargets');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification listTargets operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input?.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationListTargetsRequestSignable());

		const serviceURL = addSignatureToURL(endpoint.url(), { signedField: signed, account: accountToUse.assertAccount() });

		const response = await fetch(serviceURL, {
			method: 'GET',
			headers: { 'Accept': 'application/json' }
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification listTargets response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorListTargetsResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider listTargets endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ targets: responseJSON.targets });
	}

	async deleteTarget(input: KeetaNotificationAnchorDeleteTargetClientRequest): Promise<{ ok: boolean }> {
		const endpoint = await this.#getOperation('deleteTarget');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification deleteTarget operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationDeleteTargetRequestSignable(input));

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				account: accountToUse.publicKeyString.get(),
				id: input.id,
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification deleteTarget response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorDeleteTargetResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider deleteTarget endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ ok: responseJSON.ok });
	}

	async createSubscription(input: KeetaNotificationAnchorCreateSubscriptionClientRequest): Promise<{ id: string }> {
		const endpoint = await this.#getOperation('createSubscription');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification createSubscription operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationCreateSubscriptionRequestSignable(input));

		const serializedSubscription = {
			...input.subscription,
			...(input.subscription.toAddress ? { toAddress: input.subscription.toAddress.publicKeyString.get() } : {})
		};

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				account: accountToUse.publicKeyString.get(),
				subscription: serializedSubscription,
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification createSubscription response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorCreateSubscriptionResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider createSubscription endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ id: responseJSON.id });
	}

	async listSubscriptions(input?: KeetaNotificationAnchorListSubscriptionsClientRequest): Promise<{ subscriptions: SubscriptionDetailsWithID[] }> {
		const endpoint = await this.#getOperation('listSubscriptions');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification listSubscriptions operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input?.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationListSubscriptionsRequestSignable());

		const serviceURL = addSignatureToURL(endpoint.url(), { signedField: signed, account: accountToUse.assertAccount() });

		const response = await fetch(serviceURL, {
			method: 'GET',
			headers: { 'Accept': 'application/json' }
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification listSubscriptions response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorListSubscriptionsResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider listSubscriptions endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ subscriptions: responseJSON.subscriptions.map(parseSubscriptionDetailsWithIDJSON) });
	}

	async deleteSubscription(input: KeetaNotificationAnchorDeleteSubscriptionClientRequest): Promise<{ ok: boolean }> {
		const endpoint = await this.#getOperation('deleteSubscription');

		if (endpoint.options.authentication.type === 'none') {
			throw(new Error('Notification deleteSubscription operation must require account authentication'));
		}

		const accountToUse = this.#resolveAccount(input.account);
		const signed: HTTPSignedField = await SignData(accountToUse.assertAccount(), getNotificationDeleteSubscriptionRequestSignable(input));

		const response = await fetch(endpoint.url(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify({
				account: accountToUse.publicKeyString.get(),
				id: input.id,
				signed
			})
		});

		let responseJSON: unknown;
		try {
			responseJSON = await response.json();
		} catch (error) {
			throw(new Error(`Failed to parse notification deleteSubscription response as JSON: ${error}`));
		}

		if (!isKeetaNotificationAnchorDeleteSubscriptionResponseJSON(responseJSON)) {
			throw(new Error('Invalid response from notification provider deleteSubscription endpoint'));
		}

		if (!responseJSON.ok) {
			throw(await this.#parseResponseError(responseJSON));
		}

		return({ ok: responseJSON.ok });
	}
}

class KeetaNotificationAnchorClient extends KeetaNotificationAnchorBase {
	readonly resolver: Resolver;
	readonly id: string;

	constructor(client: KeetaNetUserClient, config: KeetaNotificationAnchorClientConfig = {}) {
		super({ client, logger: config.logger, account: config.account });
		this.resolver = config.resolver ?? getDefaultResolver(client, config);
		this.id = config.id ?? crypto.randomUUID();
	}

	async #lookup(criteria: ServiceSearchCriteria<'notification'> = {}, shared?: SharedLookupCriteria): Promise<KeetaNotificationAnchorProvider[] | null> {
		const endpoints = await getEndpoints(this.resolver, criteria, shared, this.logger);
		if (endpoints === null) {
			return(null);
		}

		const providers = Object.entries(endpoints).map(([providerID, serviceInfo]) => {
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			return(new KeetaNotificationAnchorProvider(serviceInfo as KeetaNotificationServiceInfo, providerID as unknown as ProviderID, this));
		});

		if (providers.length === 0) {
			return(null);
		}

		return(providers);
	}

	async getProviders(criteria?: ServiceSearchCriteria<'notification'>, shared?: SharedLookupCriteria): Promise<KeetaNotificationAnchorProvider[] | null> {
		return(await this.#lookup(criteria, shared));
	}

	async getProvider(providerID: string, shared?: SharedLookupCriteria): Promise<KeetaNotificationAnchorProvider | null> {
		const mergedSharedCriteria: SharedLookupCriteria = {
			...shared,
			providerIDs: shared?.providerIDs !== undefined ? Array.from(new Set([...shared.providerIDs, providerID])) : [providerID]
		};
		const providers = await this.#lookup({}, mergedSharedCriteria);
		return(providers?.[0] ?? null);
	}

	/** @internal */
	_internals(accessToken: symbol) {
		if (accessToken !== KeetaNotificationAnchorClientAccessToken) {
			throw(new Error('invalid access token'));
		}

		return({
			client: this.client,
			logger: this.logger,
			account: this.account
		});
	}
}

export default KeetaNotificationAnchorClient;
export { KeetaNotificationAnchorProvider };
