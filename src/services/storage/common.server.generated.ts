import { createAssert } from 'typia';
import type {
	KeetaStorageAnchorPutRequest,
	KeetaStorageAnchorPutResponse,
	KeetaStorageAnchorGetRequest,
	KeetaStorageAnchorGetResponse,
	KeetaStorageAnchorDeleteRequest,
	KeetaStorageAnchorDeleteResponse,
	KeetaStorageAnchorSearchRequest,
	KeetaStorageAnchorSearchResponse,
	KeetaStorageAnchorQuotaRequest,
	KeetaStorageAnchorQuotaResponse,
	KeetaStorageAnchorUpdateMetadataRequest
} from './common.ts';

export const assertKeetaStorageAnchorPutRequest: (input: unknown) => KeetaStorageAnchorPutRequest = createAssert<KeetaStorageAnchorPutRequest>();
export const assertKeetaStorageAnchorPutResponse: (input: unknown) => KeetaStorageAnchorPutResponse = createAssert<KeetaStorageAnchorPutResponse>();
export const assertKeetaStorageAnchorGetRequest: (input: unknown) => KeetaStorageAnchorGetRequest = createAssert<KeetaStorageAnchorGetRequest>();
export const assertKeetaStorageAnchorGetResponse: (input: unknown) => KeetaStorageAnchorGetResponse = createAssert<KeetaStorageAnchorGetResponse>();
export const assertKeetaStorageAnchorDeleteRequest: (input: unknown) => KeetaStorageAnchorDeleteRequest = createAssert<KeetaStorageAnchorDeleteRequest>();
export const assertKeetaStorageAnchorDeleteResponse: (input: unknown) => KeetaStorageAnchorDeleteResponse = createAssert<KeetaStorageAnchorDeleteResponse>();
export const assertKeetaStorageAnchorSearchRequest: (input: unknown) => KeetaStorageAnchorSearchRequest = createAssert<KeetaStorageAnchorSearchRequest>();
export const assertKeetaStorageAnchorSearchResponse: (input: unknown) => KeetaStorageAnchorSearchResponse = createAssert<KeetaStorageAnchorSearchResponse>();
export const assertKeetaStorageAnchorQuotaRequest: (input: unknown) => KeetaStorageAnchorQuotaRequest = createAssert<KeetaStorageAnchorQuotaRequest>();
export const assertKeetaStorageAnchorQuotaResponse: (input: unknown) => KeetaStorageAnchorQuotaResponse = createAssert<KeetaStorageAnchorQuotaResponse>();
export const assertKeetaStorageAnchorUpdateMetadataRequest: (input: unknown) => KeetaStorageAnchorUpdateMetadataRequest = createAssert<KeetaStorageAnchorUpdateMetadataRequest>();
