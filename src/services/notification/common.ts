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

/**
 * Subscription arguments for notifications produced by an external publisher.
 */
interface ExternalNotificationSubscriptionArguments extends BaseNotificationSubscriptionArguments<'EXTERNAL'> {
	publisher: GenericAccount;
	kind?: string;
}

export type NotificationSubscriptionArguments = ReceiveFundsNotificationSubscriptionArguments | ExternalNotificationSubscriptionArguments;

type ReceiveFundsNotificationSubscriptionArgumentsJSON = ToJSONSerializable<Omit<ReceiveFundsNotificationSubscriptionArguments, 'locale'>> & {
	locale?: string | undefined;
};

type ExternalNotificationSubscriptionArgumentsJSON = ToJSONSerializable<Omit<ExternalNotificationSubscriptionArguments, 'locale'>> & {
	locale?: string | undefined;
};

export type NotificationSubscriptionArgumentsJSON =
	| ReceiveFundsNotificationSubscriptionArgumentsJSON
	| ExternalNotificationSubscriptionArgumentsJSON;
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
	} else if (request.subscription.type === 'EXTERNAL') {
		parts.push(request.subscription.publisher);
		parts.push(request.subscription.kind ?? 'NO_KIND');
	} else {
		assertNever(request.subscription);
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
	let locale: Intl.Locale | undefined;
	if (input.subscription.locale) {
		if (typeof input.subscription.locale === 'string') {
			locale = new Intl.Locale(input.subscription.locale);
		} else {
			locale = input.subscription.locale;
		}
	}

	let subscription: NotificationSubscriptionArguments;
	if (input.subscription.type === 'RECEIVE_FUNDS') {
		subscription = {
			type: 'RECEIVE_FUNDS',
			target: input.subscription.target,
			...(locale ? { locale } : {}),
			...(input.subscription.toAddress
				? { toAddress: KeetaNet.lib.Account.toAccount(input.subscription.toAddress) }
				: {})
		};
	} else if (input.subscription.type === 'EXTERNAL') {
		subscription = {
			type: 'EXTERNAL',
			target: input.subscription.target,
			publisher: KeetaNet.lib.Account.toAccount(input.subscription.publisher),
			...(locale ? { locale } : {}),
			...(input.subscription.kind !== undefined ? { kind: input.subscription.kind } : {})
		};
	} else {
		assertNever(input.subscription);
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

/**
 * Maximum payload field sizes for the SEND operation.
 */
export const NOTIFICATION_SEND_LIMITS = {
	/**
	 * Max characters in `payload.title`.
	 */
	titleMaxLength: 64,
	/**
	 * Max characters in `payload.body`.
	 */
	bodyMaxLength: 240,
	/**
	 * Max number of entries in `payload.data`.
	 */
	dataMaxEntries: 32,
	/**
	 * Max byte size of `payload.data` once serialized as JSON.
	 */
	dataMaxBytes: 4096,
	/**
	 * Min characters in `nonce`.
	 */
	nonceMinLength: 8,
	/**
	 * Max characters in `nonce`.
	 */
	nonceMaxLength: 128,
	/**
	 * Max characters in `kind`.
	 */
	kindMaxLength: 64
} as const;

/**
 * Regex `nonce` MUST satisfy. Restricting to URL-safe ASCII keeps nonces
 * usable as path/query components and as deterministic queue idempotency
 * tokens without further encoding.
 */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const NOTIFICATION_SEND_NONCE_REGEX: RegExp = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Payload of a SEND request. Publisher-supplied content delivered to the
 * recipient's subscribed channels.
 */
export interface KeetaNotificationAnchorSendPayload {
	title: string;
	body: string;
	data?: { [key: string]: string };
}

/**
 * Client-side request shape for the SEND operation. The publisher (signer)
 * is identified by `account` once populated; on the wire it is the public
 * key string of the publisher.
 *
 * `version` is pinned to `1`. Future breaking changes to the SEND protocol
 * MUST bump this and reject older versions on the server.
 */
export interface KeetaNotificationAnchorSendClientRequest {
	version: 1;
	/**
	 * Publisher account. Optional when relying on a default account on the client.
	 */
	account?: Account;
	/**
	 * Recipient account whose subscriptions will be matched.
	 */
	recipient: Account;
	/**
	 * Publisher-defined event class (e.g. `'inbox'`, `'order_shipped'`).
	 */
	kind: string;
	/**
	 * Publisher-supplied notification payload. Validated against {@link NOTIFICATION_SEND_LIMITS}.
	 */
	payload: KeetaNotificationAnchorSendPayload;
	/**
	 * Publisher-controlled idempotency token. MUST satisfy
	 * {@link NOTIFICATION_SEND_NONCE_REGEX}. Two SEND calls with the same
	 * `(publisher, recipient, kind, payload, nonce)` MUST produce at most
	 * one delivery.
	 */
	nonce: string;
}

export interface KeetaNotificationAnchorSendRequest extends KeetaNotificationAnchorSendClientRequest {
	account: Account;
	signed: HTTPSignedField;
}

export type KeetaNotificationAnchorSendRequestJSON = ToJSONSerializable<KeetaNotificationAnchorSendRequest>;

export type KeetaNotificationAnchorSendResponse = ({
	ok: true;
	/** True if at least one channel target was enqueued for delivery. */
	dispatched: boolean;
}) | ({
	ok: false;
	error: string;
});

export type KeetaNotificationAnchorSendResponseJSON = ToJSONSerializable<KeetaNotificationAnchorSendResponse>;

/**
 * Build the canonical bytes a publisher signs for a SEND request. Binds
 * `version`, `recipient`, `kind`, `nonce`, and the full `payload` so that
 * neither party can mutate any of those fields without invalidating the
 * signature.
 *
 * Data entries are sorted by key for determinism.
 */
export function getNotificationSendRequestSignable(request: Pick<KeetaNotificationAnchorSendClientRequest, 'version' | 'recipient' | 'kind' | 'payload' | 'nonce'>): Signable {
	const parts: Signable = [
		notificationNamespace,
		'SEND',
		String(request.version),
		request.recipient,
		request.kind,
		request.nonce,
		request.payload.title,
		request.payload.body
	];

	const data = request.payload.data;
	if (data === undefined) {
		parts.push('NO_DATA');
	} else {
		parts.push('BEGIN_DATA');
		const keys = Object.keys(data).sort();
		for (const key of keys) {
			const value = data[key];
			if (value === undefined) {
				continue;
			}
			parts.push(key, value);
		}
		parts.push('END_DATA');
	}

	return(parts);
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
