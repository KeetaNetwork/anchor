import { createAssert, json } from "typia";
import type { TokenMetadataJSON } from "./token-metadata.js";

export const parseTokenMetadataJSON: (input: string) => TokenMetadataJSON = json.createAssertParse<TokenMetadataJSON>();
export const stringifyTokenMetadataJSON: (input: TokenMetadataJSON) => string = json.createStringify<TokenMetadataJSON>();
export const assertTokenMetadataJSON: (input: unknown) => TokenMetadataJSON = createAssert<TokenMetadataJSON>();
