import { createIs } from 'typia';
import type {
	KeetaStorageAnchorPutResponse,
	KeetaStorageAnchorGetResponse,
	KeetaStorageAnchorDeleteResponse,
	KeetaStorageAnchorSearchResponse,
	KeetaStorageAnchorQuotaResponse
} from './common.ts';

export const isKeetaStorageAnchorPutResponse: (input: unknown) => input is KeetaStorageAnchorPutResponse = createIs<KeetaStorageAnchorPutResponse>();
export const isKeetaStorageAnchorGetResponse: (input: unknown) => input is KeetaStorageAnchorGetResponse = createIs<KeetaStorageAnchorGetResponse>();
export const isKeetaStorageAnchorDeleteResponse: (input: unknown) => input is KeetaStorageAnchorDeleteResponse = createIs<KeetaStorageAnchorDeleteResponse>();
export const isKeetaStorageAnchorSearchResponse: (input: unknown) => input is KeetaStorageAnchorSearchResponse = createIs<KeetaStorageAnchorSearchResponse>();
export const isKeetaStorageAnchorQuotaResponse: (input: unknown) => input is KeetaStorageAnchorQuotaResponse = createIs<KeetaStorageAnchorQuotaResponse>();

// Back-compat: server-only request/response validators were moved to
// common.server.generated.ts to keep them out of client bundles. Re-exported here
// (named, tree-shakeable) so existing './common.generated.js' imports keep resolving.
export {
	assertKeetaStorageAnchorPutRequest,
	assertKeetaStorageAnchorPutResponse,
	assertKeetaStorageAnchorGetRequest,
	assertKeetaStorageAnchorGetResponse,
	assertKeetaStorageAnchorDeleteRequest,
	assertKeetaStorageAnchorDeleteResponse,
	assertKeetaStorageAnchorSearchRequest,
	assertKeetaStorageAnchorSearchResponse,
	assertKeetaStorageAnchorQuotaRequest,
	assertKeetaStorageAnchorQuotaResponse,
	assertKeetaStorageAnchorUpdateMetadataRequest
} from './common.server.generated.js';
