import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequest,
	KeetaUsernameAnchorClaimResponse,
	KeetaUsernameAnchorResolveResponse
} from './common.ts';
import type { AccountPublicKeyString, IdentifierPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

export const assertKeetaUsernameAnchorClaimRequest: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequest>> = createAssertEquals<KeetaUsernameAnchorClaimRequest>();
export const isKeetaUsernameAnchorResolveResponse: (input: unknown) => input is KeetaUsernameAnchorResolveResponse = createIs<KeetaUsernameAnchorResolveResponse>();
export const isKeetaUsernameAnchorClaimResponse: (input: unknown) => input is KeetaUsernameAnchorClaimResponse = createIs<KeetaUsernameAnchorClaimResponse>();

type PublicKeyString = IdentifierPublicKeyString | AccountPublicKeyString;
export const isKeetaNetPublicKeyString: (input: unknown) => input is PublicKeyString = createIs<PublicKeyString>();
