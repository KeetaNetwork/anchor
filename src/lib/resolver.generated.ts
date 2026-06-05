import { createAssert, createIs } from "typia";
import type { CurrencySearchCanonical, CurrencySearchInput, ExternalURL, ServiceMetadata, ToJSONValuizable } from "./resolver.js";
import type { SignableServiceMetadata } from "./anchor-metadata-server.js";

export const isCurrencySearchCanonical: (input: unknown) => input is CurrencySearchCanonical = createIs<CurrencySearchCanonical>();
export const isCurrencySearchInput: (input: unknown) => input is CurrencySearchInput = createIs<CurrencySearchInput>();

/**
 * Check if a value is an ExternalURL
 */
export const isExternalURL: (input: unknown) => input is ExternalURL = createIs<ExternalURL>();

export const assertServiceMetadata: (input: unknown) => ToJSONValuizable<ServiceMetadata> = createAssert<ToJSONValuizable<ServiceMetadata>>();
export const assertSignableServiceMetadataOperations: (input: unknown) => SignableServiceMetadata['operations'] = createAssert<SignableServiceMetadata['operations']>();
export const assertSignableServiceMetadataLegal: (input: unknown) => NonNullable<SignableServiceMetadata['legal']> = createAssert<NonNullable<SignableServiceMetadata['legal']>>();
