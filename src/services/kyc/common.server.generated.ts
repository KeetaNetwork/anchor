import { createAssert } from 'typia';
import type {
	KeetaKYCAnchorCreateVerificationRequest,
	KeetaKYCAnchorCreateVerificationResponse
} from './common.ts';

export const assertCreateVerificationRequest: ReturnType<typeof createAssert<KeetaKYCAnchorCreateVerificationRequest>> = createAssert<KeetaKYCAnchorCreateVerificationRequest>();
export const assertCreateVerificationResponse: ReturnType<typeof createAssert<KeetaKYCAnchorCreateVerificationResponse>> = createAssert<KeetaKYCAnchorCreateVerificationResponse>();
