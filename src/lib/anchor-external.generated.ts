import { createAssertEquals } from 'typia';
import type { EncodedAnchorExternalEnvelopeV1, EncodedAnchorExternalEnvelopeV2, EncodedAnchorExternalSliceV1 } from './anchor-external.js';

export const assertEncodedAnchorExternalEnvelopeV2: (input: unknown) => EncodedAnchorExternalEnvelopeV2 = createAssertEquals<EncodedAnchorExternalEnvelopeV2>();
export const assertEncodedAnchorExternalEnvelopeV1: (input: unknown) => EncodedAnchorExternalEnvelopeV1 = createAssertEquals<EncodedAnchorExternalEnvelopeV1>();
export const assertEncodedAnchorExternalSliceV1: (input: unknown) => EncodedAnchorExternalSliceV1 = createAssertEquals<EncodedAnchorExternalSliceV1>();
