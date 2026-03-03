import type { ToJSONSerializable } from '../../lib/utils/json.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type { Signable } from '../../lib/utils/signing.js';
import type { Account, GenericAccount } from '@keetanetwork/keetanet-client/lib/account.js';
import { assertNever } from '../../lib/utils/never.js';
import { KeetaAnchorUserError } from '../../lib/error.js';
import { assertNotificationChannelType, assertNotificationIntentType } from './common.generated.js';
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
	}
}

interface BaseNotificationSubscriptionArguments<T extends string> {
	type: T;
	target: {
		provider?: string | undefined;

		ids: string[];
	}
}

interface ReceiveFundsNotificationSubscriptionArguments extends BaseNotificationSubscriptionArguments<'RECEIVE_FUNDS'> {
	toAddress?: GenericAccount;
}

export type NotificationSubscriptionArguments = ReceiveFundsNotificationSubscriptionArguments;
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
		parts.push(request.channel.fcmToken);
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


// // Namespace for the Username Anchor signable claims

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
		super(message ?? `Request failed: ${properties.channelType ? `channel type ${properties.channelType}` : `intent type ${properties.subscriptionType}`} not supported`);
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

		let intent: NotificationSubscriptionType | undefined;
		if ('intent' in other && other.intent !== undefined) {
			intent = assertNotificationIntentType(other.channel);
		}

		let channel: NotificationChannelType | undefined;
		if ('channel' in other && other.channel !== undefined) {
			channel = assertNotificationChannelType(other.channel);
		}

		const error = new this({ subscriptionType: intent, channelType: channel }, message);
		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	MethodNotSupported: typeof KeetaNotificationAnchorMethodNotSupportedError;
} = {
	MethodNotSupported: KeetaNotificationAnchorMethodNotSupportedError
};
