import { createAssertEquals } from 'typia';
import type {
	KeetaCardsCreateRequestJSON,
	KeetaCardsCardActionRequestJSON,
	KeetaCardsUpdateControlsRequestJSON,
	KeetaCardsRevealRequestJSON,
	KeetaCardsFreezeAgentCardsRequestJSON,
	KeetaCardsRegisterWalletRequestJSON,
	KeetaCardsReplaceCardRequestJSON
} from './common.js';

export const assertKeetaCardsCreateRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsCreateRequestJSON>> = createAssertEquals<KeetaCardsCreateRequestJSON>();
export const assertKeetaCardsCardActionRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsCardActionRequestJSON>> = createAssertEquals<KeetaCardsCardActionRequestJSON>();
export const assertKeetaCardsUpdateControlsRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsUpdateControlsRequestJSON>> = createAssertEquals<KeetaCardsUpdateControlsRequestJSON>();
export const assertKeetaCardsRevealRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsRevealRequestJSON>> = createAssertEquals<KeetaCardsRevealRequestJSON>();
export const assertKeetaCardsFreezeAgentCardsRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsFreezeAgentCardsRequestJSON>> = createAssertEquals<KeetaCardsFreezeAgentCardsRequestJSON>();
export const assertKeetaCardsRegisterWalletRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsRegisterWalletRequestJSON>> = createAssertEquals<KeetaCardsRegisterWalletRequestJSON>();
export const assertKeetaCardsReplaceCardRequestJSON: ReturnType<typeof createAssertEquals<KeetaCardsReplaceCardRequestJSON>> = createAssertEquals<KeetaCardsReplaceCardRequestJSON>();
