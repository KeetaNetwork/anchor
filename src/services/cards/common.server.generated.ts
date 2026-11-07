import { createAssertEquals } from 'typia';
import type {
	KeetaCardsCreateRequestJSON,
	KeetaCardsCardActionRequestJSON,
	KeetaCardsUpdateControlsRequestJSON,
	KeetaCardsRevealRequestJSON,
	KeetaCardsFreezeAgentCardsRequestJSON
} from './common.js';

export const assertKeetaCardsCreateRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsCreateRequestJSON>> = createAssertEquals<KeetaCardsCreateRequestJSON>();
export const assertKeetaCardsCardActionRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsCardActionRequestJSON>> = createAssertEquals<KeetaCardsCardActionRequestJSON>();
export const assertKeetaCardsUpdateControlsRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsUpdateControlsRequestJSON>> = createAssertEquals<KeetaCardsUpdateControlsRequestJSON>();
export const assertKeetaCardsRevealRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsRevealRequestJSON>> = createAssertEquals<KeetaCardsRevealRequestJSON>();
export const assertKeetaCardsFreezeAgentCardsRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsFreezeAgentCardsRequestJSON>> = createAssertEquals<KeetaCardsFreezeAgentCardsRequestJSON>();
