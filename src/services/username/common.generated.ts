import { createAssertEquals, createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimRequestJSON,
	KeetaUsernameAnchorClaimResponse,
	KeetaUsernameAnchorResolveResponse,
	KeetaUsernameAnchorDisassociateRequestJSON,
	KeetaUsernameAnchorDisassociateResponse
} from './common.ts';
import type { AccountPublicKeyString, IdentifierPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

export const assertKeetaUsernameAnchorClaimRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>> = createAssertEquals<KeetaUsernameAnchorClaimRequestJSON>();
export const assertKeetaUsernameAnchorDisassociateRequestJSON: ReturnType<typeof createAssertEquals<KeetaUsernameAnchorDisassociateRequestJSON>> = createAssertEquals<KeetaUsernameAnchorDisassociateRequestJSON>();
export const isKeetaUsernameAnchorResolveResponse: (input: unknown) => input is KeetaUsernameAnchorResolveResponse = createIs<KeetaUsernameAnchorResolveResponse>();
export const isKeetaUsernameAnchorClaimResponse: (input: unknown) => input is KeetaUsernameAnchorClaimResponse = createIs<KeetaUsernameAnchorClaimResponse>();
export const isKeetaUsernameAnchorDisassociateResponse: (input: unknown) => input is KeetaUsernameAnchorDisassociateResponse = createIs<KeetaUsernameAnchorDisassociateResponse>();

type PublicKeyString = IdentifierPublicKeyString | AccountPublicKeyString;
export const isKeetaNetPublicKeyString: (input: unknown) => input is PublicKeyString = createIs<PublicKeyString>();
