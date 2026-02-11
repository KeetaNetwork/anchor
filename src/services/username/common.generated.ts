import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequest,
	KeetaUsernameAnchorClaimResponse,
	KeetaUsernameAnchorResolveRequest,
	KeetaUsernameAnchorResolveResponse
} from './common.ts';

export const assertKeetaUsernameAnchorResolveRequest: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorResolveRequest>> = createAssertEquals<KeetaUsernameAnchorResolveRequest>();
export const assertKeetaUsernameAnchorClaimRequest: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequest>> = createAssertEquals<KeetaUsernameAnchorClaimRequest>();
export const isKeetaUsernameAnchorResolveResponse: (input: unknown) => input is KeetaUsernameAnchorResolveResponse = createIs<KeetaUsernameAnchorResolveResponse>();
export const isKeetaUsernameAnchorClaimResponse: (input: unknown) => input is KeetaUsernameAnchorClaimResponse = createIs<KeetaUsernameAnchorClaimResponse>();
