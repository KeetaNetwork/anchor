import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequestJSON,
	KeetaUsernameAnchorClaimResponseJSON,
	KeetaUsernameAnchorReleaseRequestJSON,
	KeetaUsernameAnchorReleaseResponseJSON,
	KeetaUsernameAnchorSearchResponseJSON,
	KeetaUsernameAnchorResolveResponseJSON
} from './common.ts';
import type { AccountPublicKeyString, IdentifierPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

export const assertKeetaUsernameAnchorClaimRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>> = createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>();
export const assertKeetaUsernameAnchorReleaseRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>> = createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>();
export const isKeetaUsernameAnchorResolveResponseJSON: (input: unknown) => input is KeetaUsernameAnchorResolveResponseJSON = createIs<KeetaUsernameAnchorResolveResponseJSON>();
export const isKeetaUsernameAnchorClaimResponseJSON: (input: unknown) => input is KeetaUsernameAnchorClaimResponseJSON = createIs<KeetaUsernameAnchorClaimResponseJSON>();
export const isKeetaUsernameAnchorReleaseResponseJSON: (input: unknown) => input is KeetaUsernameAnchorReleaseResponseJSON = createIs<KeetaUsernameAnchorReleaseResponseJSON>();
export const isKeetaUsernameAnchorSearchResponseJSON: (input: unknown) => input is KeetaUsernameAnchorSearchResponseJSON = createIs<KeetaUsernameAnchorSearchResponseJSON>();

type PublicKeyString = IdentifierPublicKeyString | AccountPublicKeyString;
export const isKeetaNetPublicKeyString: (input: unknown) => input is PublicKeyString = createIs<PublicKeyString>();
