import { createAssert } from 'typia';
import type {
	KeetaKYBAnchorCreateVerificationRequest,
	KeetaKYBAnchorCreateVerificationResponse
} from './common.ts';

export const assertCreateVerificationRequest: ReturnType<typeof createAssert<KeetaKYBAnchorCreateVerificationRequest>> = createAssert<KeetaKYBAnchorCreateVerificationRequest>();
export const assertCreateVerificationResponse: ReturnType<typeof createAssert<KeetaKYBAnchorCreateVerificationResponse>> = createAssert<KeetaKYBAnchorCreateVerificationResponse>();
