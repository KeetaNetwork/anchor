import { createAssertEquals } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequestJSON,
	KeetaUsernameAnchorReleaseRequestJSON
} from './common.ts';

export const assertKeetaUsernameAnchorClaimRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>> = createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>();
export const assertKeetaUsernameAnchorReleaseRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>> = createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>();
