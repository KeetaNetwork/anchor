import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequestJSON,
	KeetaUsernameAnchorClaimResponse,
	KeetaUsernameAnchorResolveResponse,
	KeetaUsernameAnchorReleaseRequestJSON,
	KeetaUsernameAnchorReleaseResponse
} from './common.ts';
import type { AccountPublicKeyString, IdentifierPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

export const assertKeetaUsernameAnchorClaimRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>> = createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>();
export const assertKeetaUsernameAnchorReleaseRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>> = createAssertEquals<KeetaUsernameAnchorReleaseRequestJSON>();
export const isKeetaUsernameAnchorResolveResponse: (input: unknown) => input is KeetaUsernameAnchorResolveResponse = createIs<KeetaUsernameAnchorResolveResponse>();
export const isKeetaUsernameAnchorClaimResponse: (input: unknown) => input is KeetaUsernameAnchorClaimResponse = createIs<KeetaUsernameAnchorClaimResponse>();
export const isKeetaUsernameAnchorReleaseResponse: (input: unknown) => input is KeetaUsernameAnchorReleaseResponse = createIs<KeetaUsernameAnchorReleaseResponse>();

type PublicKeyString = IdentifierPublicKeyString | AccountPublicKeyString;
export const isKeetaNetPublicKeyString: (input: unknown) => input is PublicKeyString = createIs<PublicKeyString>();
