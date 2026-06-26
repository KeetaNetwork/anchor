import { createIs } from 'typia';
import type {
	KeetaUsernameAnchorClaimResponseJSON,
	KeetaUsernameAnchorReleaseResponseJSON,
	KeetaUsernameAnchorSearchResponseJSON,
	KeetaUsernameAnchorResolveResponseJSON
} from './common.ts';
import type { AccountPublicKeyString, IdentifierPublicKeyString } from '@keetanetwork/keetanet-client/lib/account.js';

export const isKeetaUsernameAnchorResolveResponseJSON: (input: unknown) => input is KeetaUsernameAnchorResolveResponseJSON = createIs<KeetaUsernameAnchorResolveResponseJSON>();
export const isKeetaUsernameAnchorClaimResponseJSON: (input: unknown) => input is KeetaUsernameAnchorClaimResponseJSON = createIs<KeetaUsernameAnchorClaimResponseJSON>();
export const isKeetaUsernameAnchorReleaseResponseJSON: (input: unknown) => input is KeetaUsernameAnchorReleaseResponseJSON = createIs<KeetaUsernameAnchorReleaseResponseJSON>();
export const isKeetaUsernameAnchorSearchResponseJSON: (input: unknown) => input is KeetaUsernameAnchorSearchResponseJSON = createIs<KeetaUsernameAnchorSearchResponseJSON>();

type PublicKeyString = IdentifierPublicKeyString | AccountPublicKeyString;
export const isKeetaNetPublicKeyString: (input: unknown) => input is PublicKeyString = createIs<PublicKeyString>();

// Back-compat: server-only request validators were moved to common.server.generated.ts
// to keep them out of client bundles. Re-exported here (named, tree-shakeable) so
// existing './common.generated.js' imports keep resolving.
export {
	assertKeetaUsernameAnchorClaimRequestJSON,
	assertKeetaUsernameAnchorReleaseRequestJSON
} from './common.server.generated.js';
