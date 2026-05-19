import { createAssertEquals } from 'typia';
import type { EncodedAnchorExternalEnvelopeV1 } from './anchor-external.js';

export const assertEncodedAnchorExternalEnvelopeV1: (input: unknown) => EncodedAnchorExternalEnvelopeV1 = createAssertEquals<EncodedAnchorExternalEnvelopeV1>();
