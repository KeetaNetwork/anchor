import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaNotificationAnchorListTargetsResponseJSON,
	KeetaNotificationAnchorRegisterTargetResponseJSON,
	KeetaNotificationAnchorDeleteTargetResponseJSON,
	KeetaNotificationAnchorCreateSubscriptionResponseJSON,
	KeetaNotificationAnchorDeleteSubscriptionResponseJSON,
	KeetaNotificationAnchorListSubscriptionsResponseJSON,
	NotificationChannelType,
	NotificationSubscriptionType
} from './common.js';

export const isKeetaNotificationAnchorListTargetsResponseJSON: (input: unknown) => input is KeetaNotificationAnchorListTargetsResponseJSON = createIs<KeetaNotificationAnchorListTargetsResponseJSON>();
export const isKeetaNotificationAnchorRegisterTargetResponseJSON: (input: unknown) => input is KeetaNotificationAnchorRegisterTargetResponseJSON = createIs<KeetaNotificationAnchorRegisterTargetResponseJSON>();
export const isKeetaNotificationAnchorDeleteTargetResponseJSON: (input: unknown) => input is KeetaNotificationAnchorDeleteTargetResponseJSON = createIs<KeetaNotificationAnchorDeleteTargetResponseJSON>();
export const isKeetaNotificationAnchorCreateSubscriptionResponseJSON: (input: unknown) => input is KeetaNotificationAnchorCreateSubscriptionResponseJSON = createIs<KeetaNotificationAnchorCreateSubscriptionResponseJSON>();
export const isKeetaNotificationAnchorDeleteSubscriptionResponseJSON: (input: unknown) => input is KeetaNotificationAnchorDeleteSubscriptionResponseJSON = createIs<KeetaNotificationAnchorDeleteSubscriptionResponseJSON>();
export const isKeetaNotificationAnchorListSubscriptionsResponseJSON: (input: unknown) => input is KeetaNotificationAnchorListSubscriptionsResponseJSON = createIs<KeetaNotificationAnchorListSubscriptionsResponseJSON>();

export const assertNotificationChannelType: (input: unknown) => NotificationChannelType = createAssertEquals<NotificationChannelType>();
export const assertNotificationSubscriptionType: (input: unknown) => NotificationSubscriptionType = createAssertEquals<NotificationSubscriptionType>();

// Back-compat: server-only request validators were moved to common.server.generated.ts
// to keep them out of client bundles. Re-exported here (named, tree-shakeable) so
// existing './common.generated.js' imports keep resolving.
export {
	assertKeetaNotificationAnchorListTargetsRequestJSON,
	assertKeetaNotificationAnchorRegisterTargetRequestJSON,
	assertKeetaNotificationAnchorDeleteTargetRequestJSON,
	assertKeetaNotificationAnchorCreateSubscriptionRequestJSON,
	assertKeetaNotificationAnchorDeleteSubscriptionRequestJSON,
	assertKeetaNotificationAnchorListSubscriptionsRequestJSON
} from './common.server.generated.js';
