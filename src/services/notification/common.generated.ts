import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaNotificationAnchorListTargetsRequestJSON,
	KeetaNotificationAnchorDeleteTargetResponseJSON,
	KeetaNotificationAnchorDeleteTargetRequestJSON,
	KeetaNotificationAnchorListTargetsResponseJSON,
	KeetaNotificationAnchorRegisterTargetRequestJSON,
	KeetaNotificationAnchorRegisterTargetResponseJSON,
	NotificationChannelType,
	NotificationSubscriptionType
} from './common.js';

export const assertKeetaNotificationAnchorListTargetsRequestJSON: ReturnType<typeof createAssertEquals<KeetaNotificationAnchorListTargetsRequestJSON>> = createAssertEquals<KeetaNotificationAnchorListTargetsRequestJSON>();
export const assertKeetaNotificationAnchorRegisterTargetRequestJSON: ReturnType<typeof createAssertEquals<KeetaNotificationAnchorRegisterTargetRequestJSON>> = createAssertEquals<KeetaNotificationAnchorRegisterTargetRequestJSON>();
export const assertKeetaNotificationAnchorDeleteTargetRequestJSON: ReturnType<typeof createAssertEquals<KeetaNotificationAnchorDeleteTargetRequestJSON>> = createAssertEquals<KeetaNotificationAnchorDeleteTargetRequestJSON>();
export const isKeetaNotificationAnchorListTargetsResponseJSON: (input: unknown) => input is KeetaNotificationAnchorListTargetsResponseJSON = createIs<KeetaNotificationAnchorListTargetsResponseJSON>();
export const isKeetaNotificationAnchorRegisterTargetResponseJSON: (input: unknown) => input is KeetaNotificationAnchorRegisterTargetResponseJSON = createIs<KeetaNotificationAnchorRegisterTargetResponseJSON>();
export const isKeetaNotificationAnchorDeleteTargetResponseJSON: (input: unknown) => input is KeetaNotificationAnchorDeleteTargetResponseJSON = createIs<KeetaNotificationAnchorDeleteTargetResponseJSON>();

export const assertNotificationChannelType: (input: unknown) => NotificationChannelType = createAssertEquals<NotificationChannelType>();
export const assertNotificationIntentType: (input: unknown) => NotificationSubscriptionType = createAssertEquals<NotificationSubscriptionType>();
