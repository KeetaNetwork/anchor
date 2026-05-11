import * as typia from 'typia';
import type { SharableCertificateAttributesTypes } from './certificates.js';

export const assertSharableCertificateAttributesContentsSchema: (input: unknown) => SharableCertificateAttributesTypes.ContentsSchema = typia.createAssert<SharableCertificateAttributesTypes.ContentsSchema>();
