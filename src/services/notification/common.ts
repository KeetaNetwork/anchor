import type { ToJSONSerializable } from '../../lib/utils/json.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import { assertNever } from '../../lib/utils/never.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { assertNotificationChannelType, assertNotificationSubscriptionType } from './common.generated.js';
import { KeetaNet } from '../../client/index.js';
export * from './common.generated.js';

interface BaseNotificationChannelArguments<T extends string> {
	type: T;
}

interface FCMNotificationChannelArguments extends BaseNotificationChannelArguments<'FCM'> {
	appId: string;
	fcmToken: string;
}

export type NotificationChannelArguments = FCMNotificationChannelArguments;

export type NotificationChannelType = NotificationChannelArguments['type'];

interface NotificationChannelServiceMetadata {
	FCM: {
		projectId: string;
		messagingSenderId: string;
		appId: string;
		apiKey: string;
		vapidKey?: string;
		bundleId?: string;
	}
}

interface BaseNotificationSubscriptionArguments<T extends string> {
	type: T;

	// The preferred locale to receive notifications in, if supported by the channel and provider
	locale?: Intl.Locale;

	target: {
		provider?: string | undefined;

		ids: string[];
	}
}

interface ReceiveFundsNotificationSubscriptionArguments extends BaseNotificationSubscriptionArguments<'RECEIVE_FUNDS'> {
	// Address to listen to incoming transactions for, if omitted will use the requestors address
	toAddress?: GenericAccount;
}

export type NotificationSubscriptionArguments = ReceiveFundsNotificationSubscriptionArguments;
export type NotificationSubscriptionArgumentsJSON = ToJSONSerializable<Omit<NotificationSubscriptionArguments, 'locale'>> & {
	locale?: string | undefined;
};
export type NotificationSubscriptionType = NotificationSubscriptionArguments['type'];

export type SupportedChannelConfigurationMetadata = {
	FCM: NotificationChannelServiceMetadata['FCM'][];
}

// API types

export interface NotificationTargetWithIDResponse {
	id: string;
	channel: NotificationChannelArguments;
}

const notificationNamespace = '75ed4792-333f-4a50-832f-b9fcc5663d1f';

export interface KeetaNotificationAnchorRegisterTargetClientRequest {
	account?: Account;
	channel: NotificationChannelArguments;
}
export interface KeetaNotificationAnchorRegisterTargetRequest extends KeetaNotificationAnchorRegisterTargetClientRequest {
	account: Account;
	signed: HTTPSignedField;
}
export type KeetaNotificationAnchorRegisterTargetRequestJSON = ToJSONSerializable<KeetaNotificationAnchorRegisterTargetRequest>;

export type KeetaNotificationAnchorRegisterTargetResponseJSON = ({
	ok: true;
	id: string;
}) | ({
	ok: false;
	error: string;
});

export function getNotificationRegisterTargetRequestSignable(request: Pick<KeetaNotificationAnchorRegisterTargetClientRequest, 'channel'>): Signable {
	const parts: Signable = [
		notificationNamespace,
		'REGISTER_TARGET',
		request.channel.type
	];

	if (request.channel.type === 'FCM') {
		parts.push(request.channel.fcmToken, request.channel.appId);
	} else {
		assertNever(request.channel.type);
	}

	return(parts);
}

export interface KeetaNotificationAnchorListTargetsClientRequest { account?: Account; }
interface KeetaNotificationAnchorListTargetsRequest extends KeetaNotificationAnchorListTargetsClientRequest {
	account: Account;
	signed: HTTPSignedField;
}
export type KeetaNotificationAnchorListTargetsRequestJSON = ToJSONSerializable<KeetaNotificationAnchorListTargetsRequest>;

export type KeetaNotificationAnchorListTargetsResponse = ({
	ok: true;
	targets: NotificationTargetWithIDResponse[];
}) | ({
	ok: false;
	error: string;
});
export type KeetaNotificationAnchorListTargetsResponseJSON = ToJSONSerializable<KeetaNotificationAnchorListTargetsResponse>;

export function getNotificationListTargetsRequestSignable(_ignore_request?: KeetaNotificationAnchorListTargetsClientRequest): Signable {
	return([
		notificationNamespace,
		'LIST_TARGETS'
	]);
}


export interface KeetaNotificationAnchorDeleteTargetClientRequest {
	account?: Account;
	id: string;
}
export interface KeetaNotificationAnchorDeleteTargetRequest extends KeetaNotificationAnchorDeleteTargetClientRequest {
	account: Account;
	signed: HTTPSignedField;
}
export type KeetaNotificationAnchorDeleteTargetRequestJSON = ToJSONSerializable<KeetaNotificationAnchorDeleteTargetRequest>;

export type KeetaNotificationAnchorDeleteTargetResponse = ({
	ok: true;
}) | ({
	ok: false;
	error: string;
});

export type KeetaNotificationAnchorDeleteTargetResponseJSON = ToJSONSerializable<KeetaNotificationAnchorDeleteTargetResponse>;

export function getNotificationDeleteTargetRequestSignable(request: Pick<KeetaNotificationAnchorDeleteTargetClientRequest, 'id'>): Signable {
	return([
		notificationNamespace,
		'DELETE_TARGET',
		request.id
	]);
}

export interface KeetaNotificationAnchorCreateSubscriptionClientRequest {
	account?: Account;
	subscription: NotificationSubscriptionArguments;
}

export type KeetaNotificationAnchorCreateSubscriptionRequestJSON = {
	subscription: NotificationSubscriptionArgumentsJSON;
	account: string;
	signed: HTTPSignedField;
}

export type KeetaNotificationAnchorCreateSubscriptionResponse = ({
	ok: true;
	id: string;
}) | ({
	ok: false;
	error: string;
});

export type KeetaNotificationAnchorCreateSubscriptionResponseJSON = ToJSONSerializable<KeetaNotificationAnchorCreateSubscriptionResponse>;

export function getNotificationCreateSubscriptionRequestSignable(request: Pick<KeetaNotificationAnchorCreateSubscriptionClientRequest, 'subscription'>): Signable {
	const parts: Signable = [
		notificationNamespace,
		'CREATE_SUBSCRIPTION',
		request.subscription.type
	];

	parts.push(request.subscription.locale?.toString() ?? 'NO_LOCALE');

	if (request.subscription.type === 'RECEIVE_FUNDS') {
		parts.push(request.subscription.toAddress ?? 'NO_ADDRESS');
	} else {
		assertNever(request.subscription.type);
	}

	parts.push(request.subscription.target.provider ?? 'NO_PROVIDER');

	parts.push('BEGIN_TARGETS');
	for (const target of request.subscription.target.ids) {
		parts.push(target);
	}
	parts.push('END_TARGETS');

	return(parts);
}

export interface KeetaNotificationAnchorDeleteSubscriptionClientRequest {
	account?: Account;
	id: string;
}
export interface KeetaNotificationAnchorDeleteSubscriptionRequest extends KeetaNotificationAnchorDeleteSubscriptionClientRequest {
	account: Account;
	signed: HTTPSignedField;
}
export type KeetaNotificationAnchorDeleteSubscriptionRequestJSON = ToJSONSerializable<KeetaNotificationAnchorDeleteSubscriptionRequest>;

export type KeetaNotificationAnchorDeleteSubscriptionResponse = ({
	ok: true;
}) | ({
	ok: false;
	error: string;
});

export type KeetaNotificationAnchorDeleteSubscriptionResponseJSON = ToJSONSerializable<KeetaNotificationAnchorDeleteSubscriptionResponse>;

export function getNotificationDeleteSubscriptionRequestSignable(request: Pick<KeetaNotificationAnchorDeleteSubscriptionClientRequest, 'id'>): Signable {
	return([
		notificationNamespace,
		'DELETE_SUBSCRIPTION',
		request.id
	]);
}

export interface SubscriptionDetails {
	id: string;
	subscription: NotificationSubscriptionArguments;
}

export type SubscriptionDetailsJSON = ToJSONSerializable<Omit<SubscriptionDetails, 'subscription'>> & {
	subscription: NotificationSubscriptionArgumentsJSON;
}

export function parseSubscriptionDetailsWithID(input: SubscriptionDetailsJSON | SubscriptionDetails): SubscriptionDetails {
	let subscription: NotificationSubscriptionArguments;
	if (input.subscription.type === 'RECEIVE_FUNDS') {
		let locale;
		if (input.subscription.locale) {
			if (typeof input.subscription.locale === 'string') {
				locale = new Intl.Locale(input.subscription.locale);
			} else {
				locale = input.subscription.locale;
			}
		}

		subscription = {
			type: 'RECEIVE_FUNDS',
			target: input.subscription.target,
			...(locale ? { locale } : {}),
			...(input.subscription.toAddress
				? { toAddress: KeetaNet.lib.Account.toAccount(input.subscription.toAddress) }
				: {})
		};
	} else {
		assertNever(input.subscription.type);
	}

	return({ id: input.id, subscription });
}

export interface KeetaNotificationAnchorListSubscriptionsClientRequest { account?: Account; }
interface KeetaNotificationAnchorListSubscriptionsRequest extends KeetaNotificationAnchorListSubscriptionsClientRequest {
	account: Account;
	signed: HTTPSignedField;
}
export type KeetaNotificationAnchorListSubscriptionsRequestJSON = ToJSONSerializable<KeetaNotificationAnchorListSubscriptionsRequest>;

export type KeetaNotificationAnchorListSubscriptionsResponse = ({
	ok: true;
	subscriptions: SubscriptionDetailsJSON[];
}) | ({
	ok: false;
	error: string;
});

export type KeetaNotificationAnchorListSubscriptionsResponseJSON = ToJSONSerializable<KeetaNotificationAnchorListSubscriptionsResponse>;

export function getNotificationListSubscriptionsRequestSignable(_ignore_request?: KeetaNotificationAnchorListSubscriptionsClientRequest): Signable {
	return([
		notificationNamespace,
		'LIST_SUBSCRIPTIONS'
	]);
}

interface KeetaNotificationAnchorMethodNotSupportedErrorProperties {
	channelType?: NotificationChannelType | undefined;
	subscriptionType?: NotificationSubscriptionType | undefined;
}

type KeetaNotificationAnchorMethodNotSupportedErrorJSON = ReturnType<KeetaAnchorUserError['toJSON']> & KeetaNotificationAnchorMethodNotSupportedErrorProperties;

class KeetaNotificationAnchorMethodNotSupportedError extends KeetaAnchorUserError implements KeetaNotificationAnchorMethodNotSupportedErrorProperties {
	static override readonly name: string = 'KeetaNotificationAnchorMethodNotSupportedError';
	private readonly KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID!: string;
	private static readonly KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID = '95268e45-2305-4a75-92af-417feb57fdd6';
	override readonly logLevel = 'INFO';
	readonly channelType?: NotificationChannelType | undefined;
	readonly subscriptionType?: NotificationSubscriptionType | undefined;

	constructor(properties: KeetaNotificationAnchorMethodNotSupportedErrorProperties, message?: string) {
		super(message ?? `Request failed: ${properties.channelType ? `channel type ${properties.channelType}` : `subscription type ${properties.subscriptionType}`} not supported`);
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID', {
			value: KeetaNotificationAnchorMethodNotSupportedError.KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID,
			enumerable: false
		});

		this.channelType = properties.channelType;
		this.subscriptionType = properties.subscriptionType;
	}

	static isInstance(input: unknown): input is KeetaNotificationAnchorMethodNotSupportedError {
		return(this.hasPropWithValue(input, 'KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID', KeetaNotificationAnchorMethodNotSupportedError.KeetaNotificationAnchorMethodNotSupportedErrorObjectTypeID));
	}

	toJSON(): KeetaNotificationAnchorMethodNotSupportedErrorJSON {
		return({
			...super.toJSON(),
			channelType: this.channelType,
			subscriptionType: this.subscriptionType
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaNotificationAnchorMethodNotSupportedError> {
		const { message, other } = this.extractErrorProperties(input, this);

		let subscriptionType: NotificationSubscriptionType | undefined;
		if ('intent' in other && other.intent !== undefined) {
			subscriptionType = assertNotificationSubscriptionType(other.subscriptionType);
		}

		let channelType: NotificationChannelType | undefined;
		if ('channelType' in other && other.channelType !== undefined) {
			channelType = assertNotificationChannelType(other.channelType);
		}

		const error = new this({ subscriptionType, channelType }, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	MethodNotSupported: typeof KeetaNotificationAnchorMethodNotSupportedError;
} = {
	MethodNotSupported: KeetaNotificationAnchorMethodNotSupportedError
};
