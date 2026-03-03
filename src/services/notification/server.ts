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
	SubscriptionDetailsWithID,
	NotificationSubscriptionArguments,
	NotificationSubscriptionType,
	SupportedChannelConfigurationMetadata } from './common.js';
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
import * as Signing from '../../lib/utils/signing.js';
import { parseSignatureFromURL } from '../../lib/http-server/common.js';

export interface KeetaAnchorNotificationServerConfig extends KeetaAnchorHTTPServer.KeetaAnchorHTTPServerConfig {
	homepage?: string | (() => Promise<string> | string);
	notification: {
		registerTarget?: (args: Required<KeetaNotificationAnchorRegisterTargetClientRequest>) => Promise<{ id: string; }>;
		listTargets?: (args: Required<KeetaNotificationAnchorListTargetsClientRequest>) => Promise<{ targets: NotificationTargetWithIDResponse[]; }>;
		deleteTarget?: (args: Required<KeetaNotificationAnchorDeleteTargetClientRequest>) => Promise<{ ok: boolean; }>;

		createSubscription?: (args: Required<KeetaNotificationAnchorCreateSubscriptionClientRequest>) => Promise<{ id: string; }>;
		listSubscriptions?: (args: Required<KeetaNotificationAnchorListSubscriptionsClientRequest>) => Promise<{ subscriptions: SubscriptionDetailsWithID[]; }>;
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
				const request: Required<KeetaNotificationAnchorRegisterTargetRequest> = (() => {
					const raw = assertKeetaNotificationAnchorRegisterTargetRequestJSON(body);

					return({
						...raw,
						account: KeetaNet.lib.Account.toAccount(raw.account)
					});
				})();

				const signatureVerified = await Signing.VerifySignedData(
					request.account,
					getNotificationRegisterTargetRequestSignable(request),
					request.signed
				);

				if (!signatureVerified) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

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
				const signatureDetails = parseSignatureFromURL(url);

				if (!signatureDetails.account || !signatureDetails.signedField) {
					throw(new KeetaAnchorUserError('Missing signature parameters in URL'));
				}

				const verifiedSignature = await Signing.VerifySignedData(
					signatureDetails.account,
					getNotificationListTargetsRequestSignable(),
					signatureDetails.signedField
				);

				if (!verifiedSignature) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

				const listResponse = await listTargetsHandler({ account: signatureDetails.account });

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
				const request: Required<KeetaNotificationAnchorDeleteTargetRequest> = (() => {
					const raw = assertKeetaNotificationAnchorDeleteTargetRequestJSON(body);

					return({
						...raw,
						account: KeetaNet.lib.Account.toAccount(raw.account)
					});
				})();

				const verifiedSignature = await Signing.VerifySignedData(
					request.account,
					getNotificationDeleteTargetRequestSignable(request),
					request.signed
				);

				if (!verifiedSignature) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

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
				const account = KeetaNet.lib.Account.fromPublicKeyString(raw.account);

				let subscription: NotificationSubscriptionArguments;
				if (raw.subscription.type === 'RECEIVE_FUNDS') {
					subscription = {
						type: 'RECEIVE_FUNDS',
						target: raw.subscription.target,
						...(raw.subscription.toAddress
							? { toAddress: KeetaNet.lib.Account.fromPublicKeyString(raw.subscription.toAddress) }
							: {})
					};
				} else {
					throw(new KeetaAnchorUserError(`Unsupported subscription type`));
				}

				const request = { account, subscription, signed: raw.signed };

				const signatureVerified = await Signing.VerifySignedData(
					account,
					getNotificationCreateSubscriptionRequestSignable({ subscription }),
					raw.signed
				);

				if (!signatureVerified) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

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
				const signatureDetails = parseSignatureFromURL(url);

				if (!signatureDetails.account || !signatureDetails.signedField) {
					throw(new KeetaAnchorUserError('Missing signature parameters in URL'));
				}

				const verifiedSignature = await Signing.VerifySignedData(
					signatureDetails.account,
					getNotificationListSubscriptionsRequestSignable(),
					signatureDetails.signedField
				);

				if (!verifiedSignature) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

				const listResponse = await listSubscriptionsHandler({ account: signatureDetails.account });

				return({
					output: JSON.stringify({ ok: true, subscriptions: listResponse.subscriptions }),
					contentType: 'application/json'
				});
			};
		}

		const deleteSubscriptionHandler = this.notification.deleteSubscription;
		if (deleteSubscriptionHandler) {
			routes['POST /api/delete-subscription'] = async (_params, body) => {
				const request: Required<KeetaNotificationAnchorDeleteSubscriptionRequest> = (() => {
					const raw = assertKeetaNotificationAnchorDeleteSubscriptionRequestJSON(body);

					return({
						...raw,
						account: KeetaNet.lib.Account.toAccount(raw.account)
					});
				})();

				const verifiedSignature = await Signing.VerifySignedData(
					request.account,
					getNotificationDeleteSubscriptionRequestSignable(request),
					request.signed
				);

				if (!verifiedSignature) {
					throw(new KeetaAnchorUserError('Invalid signature'));
				}

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

		return(retval);
	}
}
