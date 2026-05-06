import type { HTTPSignedField } from '../../lib/http-server/common.js';
import type {
	NotificationSubscriptionArguments,
	KeetaNotificationAnchorSendClientRequest
} from './common.js';
import { KeetaNet } from '../../client/index.js';
import { SignData } from '../../lib/utils/signing.js';
import { KeetaAnchorHTTPRequestError } from '../../lib/http-server/common.js';
import { getNotificationSendRequestSignable } from './common.js';

/**
 * Narrow a possibly-null/undefined value to NonNullable.
 */
export function asNonNull<T>(value: T): NonNullable<T> {
	if (value === null || value === undefined) {
		throw(new Error('Value is null or undefined'));
	}

	return(value);
}

/**
 * Narrow a {@link NotificationSubscriptionArguments} to its `EXTERNAL`.
 */
export function assertExternalSubscription(subscription: NotificationSubscriptionArguments): Extract<NotificationSubscriptionArguments, { type: 'EXTERNAL' }> {
	if (subscription.type !== 'EXTERNAL') {
		throw(new Error(`Expected EXTERNAL subscription, got ${subscription.type}`));
	}

	return(subscription);
}

/**
 * Narrow an `unknown` thrown value to {@link KeetaAnchorHTTPRequestError}.
 */
export function assertHTTPRequestError(value: unknown): KeetaAnchorHTTPRequestError {
	if (!KeetaAnchorHTTPRequestError.isInstance(value)) {
		throw(new Error(`Expected KeetaAnchorHTTPRequestError, got ${String(value)}`));
	}

	return(value);
}

type KeetaAccount = ReturnType<typeof KeetaNet.lib.Account.fromSeed>;

/**
 * Wire-form body of a SEND request used by the server tests. Exposed
 * mutably so tests can tamper with individual fields.
 */
export interface SendRequestBody {
	version: number;
	account: string;
	recipient: string;
	kind: string;
	payload: KeetaNotificationAnchorSendClientRequest['payload'];
	nonce: string;
	signed: HTTPSignedField;
}

/**
 * Construct a signed SEND request body for {@link KeetaNotificationAnchorSendClientRequest}.
 */
export async function buildSendBody(
	publisherAccount: KeetaAccount,
	recipientPubkey: string,
	overrides?: Partial<{
		kind: string;
		nonce: string;
		payload: KeetaNotificationAnchorSendClientRequest['payload'];
		version: number;
	}>
): Promise<{ body: SendRequestBody; signed: HTTPSignedField; recipient: ReturnType<typeof KeetaNet.lib.Account.fromPublicKeyString> }> {
	const recipient = KeetaNet.lib.Account.fromPublicKeyString(recipientPubkey).assertAccount();
	const kind = overrides?.kind ?? 'inbox';
	const nonce = overrides?.nonce ?? 'send-nonce-001';
	const payload: KeetaNotificationAnchorSendClientRequest['payload'] = overrides?.payload ?? {
		title: 'Hello',
		body: 'World',
		data: { foo: 'bar' }
	};
	const signable = getNotificationSendRequestSignable({ version: 1, recipient, kind, payload, nonce });
	const signed = await SignData(publisherAccount.assertAccount(), signable);
	return({
		body: {
			version: overrides?.version ?? 1,
			account: publisherAccount.publicKeyString.get(),
			recipient: recipientPubkey,
			kind,
			payload,
			nonce,
			signed
		},
		signed,
		recipient
	});
}
