import * as typia from 'typia';
import type { SharableCertificateAttributesTypes, KeetaAnchorCertificateRequiredErrorJSONProperties } from './certificates.js';

export const assertSharableCertificateAttributesContentsSchema: (input: unknown) => SharableCertificateAttributesTypes.ContentsSchema = typia.createAssert<SharableCertificateAttributesTypes.ContentsSchema>();

export const assertKeetaAnchorCertificateRequiredErrorJSONProperties: (input: unknown) => KeetaAnchorCertificateRequiredErrorJSONProperties = typia.createAssertEquals<KeetaAnchorCertificateRequiredErrorJSONProperties>();
