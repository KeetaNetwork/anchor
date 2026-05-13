import { KeetaNet } from '../../client/index.js';
import * as KeetaAnchorHTTPServer from '../../lib/http-server/index.js';
import type {
	KeetaNotificationAnchorRegisterTargetClientRequest,
	KeetaNotificationAnchorListTargetsClientRequest,
	NotificationTargetWithIDResponse,
	KeetaNotificationAnchorDeleteTargetClientRequest,
	KeetaNotificationAnchorRegisterTargetRequest,
	KeetaNotificationAnchorDeleteTargetRequest,
	KeetaNotificationAnchorCreateSubscriptionClientRequest,
	KeetaNotificationAnchorDeleteSubscriptionClientRequest,
	KeetaNotificationAnchorDeleteSubscriptionRequest,
	KeetaNotificationAnchorListSubscriptionsClientRequest,
	SubscriptionDetails,
	NotificationSubscriptionArguments,
	NotificationSubscriptionType,
	SupportedChannelConfigurationMetadata,
	SubscriptionDetailsJSON
} from './common.js';
import {
	getNotificationRegisterTargetRequestSignable,
	assertKeetaNotificationAnchorRegisterTargetRequestJSON,
	getNotificationListTargetsRequestSignable,
	assertKeetaNotificationAnchorDeleteTargetRequestJSON,
	getNotificationDeleteTargetRequestSignable,
	assertKeetaNotificationAnchorCreateSubscriptionRequestJSON,
	getNotificationCreateSubscriptionRequestSignable,
	assertKeetaNotificationAnchorDeleteSubscriptionRequestJSON,
	getNotificationDeleteSubscriptionRequestSignable,
	getNotificationListSubscriptionsRequestSignable
} from './common.js';
import type { ServiceMetadata, ServiceMetadataAuthenticationType } from '../../lib/resolver.js';
import type { Routes } from '../../lib/http-server/index.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { verifyBodyAuth, verifyURLAuth } from '../../lib/http-server/common.js';

export interface KeetaAnchorNotificationServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	homepage?: string | (() => Promise<string> | string);
	notification: {
		registerTarget?: (args: Required<KeetaNotificationAnchorRegisterTargetClientRequest>) => Promise<{ id: string; }>;
		listTargets?: (args: Required<KeetaNotificationAnchorListTargetsClientRequest>) => Promise<{ targets: NotificationTargetWithIDResponse[]; }>;
		deleteTarget?: (args: Required<KeetaNotificationAnchorDeleteTargetClientRequest>) => Promise<{ ok: boolean; }>;

		createSubscription?: (args: Required<KeetaNotificationAnchorCreateSubscriptionClientRequest>) => Promise<{ id: string; }>;
		listSubscriptions?: (args: Required<KeetaNotificationAnchorListSubscriptionsClientRequest>) => Promise<{ subscriptions: SubscriptionDetails[]; }>;
		deleteSubscription?: (args: Required<KeetaNotificationAnchorDeleteSubscriptionClientRequest>) => Promise<{ ok: boolean; }>;

		supportedChannels?: SupportedChannelConfigurationMetadata;
		supportedSubscriptions?: NotificationSubscriptionType[];
	};
	routes?: Routes;
}

export class KeetaNetNotificationAnchorHTTPServer extends KeetaAnchorHTTPServer.KeetaNetAnchorHTTPServer<KeetaAnchorNotificationServerConfig> {
	readonly homepage: NonNullable<KeetaAnchorNotificationServerConfig['homepage']>;
	readonly notification: KeetaAnchorNotificationServerConfig['notification'];
	readonly routes: NonNullable<KeetaAnchorNotificationServerConfig['routes']>;

	constructor(config: KeetaAnchorNotificationServerConfig) {
		super(config);

		this.homepage = config.homepage ?? '';
		this.notification = config.notification;
		this.routes = config.routes ?? {};
	}

	protected async initRoutes(config: KeetaAnchorNotificationServerConfig): Promise<KeetaAnchorHTTPServer.Routes> {
		const routes: KeetaAnchorHTTPServer.Routes = { ...this.routes };

		if ('homepage' in config) {
			routes['GET /'] = async function() {
				let homepageData: string;
				if (typeof config.homepage === 'string') {
					homepageData = config.homepage;
				} else {
					if (!config.homepage) {
						throw(new Error('internal error: No homepage function provided'));
					}

					homepageData = await config.homepage();
				}

				return({
					output: homepageData,
					contentType: 'text/html; charset=utf-8'
				});
			};
		}

		const registerTargetHandler = this.notification.registerTarget;
		if (registerTargetHandler) {
			routes['POST /api/target'] = async (_params, body) => {
				const raw = assertKeetaNotificationAnchorRegisterTargetRequestJSON(body);
				const account = await verifyBodyAuth(raw, getNotificationRegisterTargetRequestSignable, this.resolvedCertificateChainRequirement);
				const request: Required<KeetaNotificationAnchorRegisterTargetRequest> = { ...raw, account };
				const registerResponse = await registerTargetHandler(request);

				return({
					output: JSON.stringify({
						ok: true,
						id: registerResponse.id
					}),
					contentType: 'application/json'
				});
			};
		}

		const listTargetsHandler = this.notification.listTargets;
		if (listTargetsHandler) {
			routes['GET /api/targets'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
				const account = await verifyURLAuth(
					url,
					function() { return(getNotificationListTargetsRequestSignable()); },
					this.resolvedCertificateChainRequirement
				);
				const listResponse = await listTargetsHandler({ account });

				return({
					output: JSON.stringify({
						ok: true,
						targets: listResponse.targets
					}),
					contentType: 'application/json'
				});
			};
		}

		const deleteTargetHandler = this.notification.deleteTarget;
		if (deleteTargetHandler) {
			// XXX:TODO should this be post with body or delete with URL param? Delete with URL param is more RESTful but can be more difficult to call from some clients and doesn't allow for a request body (so all data must be in the URL or signature)
			routes['POST /api/delete-target'] = async (_params, body) => {
				const raw = assertKeetaNotificationAnchorDeleteTargetRequestJSON(body);
				const account = await verifyBodyAuth(raw, getNotificationDeleteTargetRequestSignable, this.resolvedCertificateChainRequirement);
				const request: Required<KeetaNotificationAnchorDeleteTargetRequest> = { ...raw, account };
				const deleteResponse = await deleteTargetHandler(request);

				return({
					output: JSON.stringify(deleteResponse),
					contentType: 'application/json'
				});
			};
		}

		const createSubscriptionHandler = this.notification.createSubscription;
		if (createSubscriptionHandler) {
			routes['POST /api/subscription'] = async (_params, body) => {
				const raw = assertKeetaNotificationAnchorCreateSubscriptionRequestJSON(body);

				let subscription: NotificationSubscriptionArguments;
				if (raw.subscription.type === 'RECEIVE_FUNDS') {
					subscription = {
						type: 'RECEIVE_FUNDS',
						target: raw.subscription.target,
						...(raw.subscription.toAddress
							? { toAddress: KeetaNet.lib.Account.fromPublicKeyString(raw.subscription.toAddress) }
							: {}),
						...(raw.subscription.locale ? { locale: new Intl.Locale(raw.subscription.locale) } : {})
					};
				} else {
					throw(new KeetaAnchorUserError(`Unsupported subscription type`));
				}

				const account = await verifyBodyAuth(raw, function() {
					return(getNotificationCreateSubscriptionRequestSignable({ subscription }));
				}, this.resolvedCertificateChainRequirement);

				const request = { account, subscription, signed: raw.signed };
				const createResponse = await createSubscriptionHandler(request);

				return({
					output: JSON.stringify({ ok: true, id: createResponse.id }),
					contentType: 'application/json'
				});
			};
		}

		const listSubscriptionsHandler = this.notification.listSubscriptions;
		if (listSubscriptionsHandler) {
			routes['GET /api/subscriptions'] = async (_ignore_params, _ignore_body, _ignore_headers, url) => {
				const account = await verifyURLAuth(
					url,
					function() { return(getNotificationListSubscriptionsRequestSignable()); },
					this.resolvedCertificateChainRequirement
				);

				const listResponse = await listSubscriptionsHandler({ account });
				const subscriptionsJSON: SubscriptionDetailsJSON[] = listResponse.subscriptions.map(function(subscription): SubscriptionDetailsJSON {
					const { locale, ...restSubscription } = subscription.subscription;
					return({
						...subscription,
						subscription: {
							...KeetaNet.lib.Utils.Conversion.toJSONSerializable(restSubscription),
							...(locale ? { locale: locale.toString() } : {})
						}
					});
				});

				return({
					output: JSON.stringify(KeetaNet.lib.Utils.Conversion.toJSONSerializable({
						ok: true,
						subscriptions: subscriptionsJSON
					})),
					contentType: 'application/json'
				});
			};
		}

		const deleteSubscriptionHandler = this.notification.deleteSubscription;
		if (deleteSubscriptionHandler) {
			routes['POST /api/delete-subscription'] = async (_params, body) => {
				const raw = assertKeetaNotificationAnchorDeleteSubscriptionRequestJSON(body);
				const account = await verifyBodyAuth(raw, getNotificationDeleteSubscriptionRequestSignable, this.resolvedCertificateChainRequirement);
				const request: Required<KeetaNotificationAnchorDeleteSubscriptionRequest> = { ...raw, account };
				const deleteResponse = await deleteSubscriptionHandler(request);

				return({
					output: JSON.stringify(deleteResponse),
					contentType: 'application/json'
				});
			};
		}

		return(routes);
	}

	async serviceMetadata(): Promise<NonNullable<ServiceMetadata['services']['notification']>[string]> {
		const retval: NonNullable<ServiceMetadata['services']['notification']>[string] = { operations: {}};

		const authentication: ServiceMetadataAuthenticationType = {
			method: 'keeta-account',
			type: 'required'
		}

		if (this.notification.registerTarget) {
			retval.operations.registerTarget = { url: (new URL('/api/target', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.listTargets) {
			retval.operations.listTargets = { url: (new URL('/api/targets', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.deleteTarget) {
			retval.operations.deleteTarget = { url: (new URL('/api/delete-target', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.createSubscription) {
			retval.operations.createSubscription = { url: (new URL('/api/subscription', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.listSubscriptions) {
			retval.operations.listSubscriptions = { url: (new URL('/api/subscriptions', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.deleteSubscription) {
			retval.operations.deleteSubscription = { url: (new URL('/api/delete-subscription', this.url)).toString(), options: { authentication }};
		}

		if (this.notification.supportedChannels) {
			retval.supportedChannels = this.notification.supportedChannels;
		}

		if (this.notification.supportedSubscriptions) {
			retval.supportedSubscriptions = this.notification.supportedSubscriptions;
		}

		const acceptedIssuerDNs = this.acceptedIssuerDNs();
		if (acceptedIssuerDNs !== undefined) {
			retval.acceptedIssuerDNs = acceptedIssuerDNs;
		}

		return(retval);
	}
}
