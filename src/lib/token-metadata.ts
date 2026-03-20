import { parseTokenMetadataJSON, stringifyTokenMetadataJSON } from "./token-metadata.generated.js";

export interface TokenMetadata {
	decimalPlaces: number;
	logoURI?: string;
}


export interface TokenMetadataJSON extends Omit<TokenMetadata, "decimalPlaces"> {
	decimalPlaces: number | string;
}

/**
 * Encodes token metadata into a base64-encoded JSON string.
 *
 * @param metadata - The token metadata to encode {@link TokenMetadata}
 * @returns The base64-encoded JSON string containing the token metadata
 */
export function encodeTokenMetadata(metadata: TokenMetadata | TokenMetadataJSON): string {
	const payload = stringifyTokenMetadataJSON(metadata)
	return(btoa(payload));
}

/**
 * Parse token metadata from a base64-encoded JSON string or a TokenMetadataJSON object, returning a TokenMetadata object.
 * @param encoded the value to parse
 * @returns the parsed TokenMetadata object
 */
export function decodeTokenMetadata(encoded: string | TokenMetadataJSON | TokenMetadata): TokenMetadata {
	let decoded;
	if (typeof encoded === "string") {
		decoded = parseTokenMetadataJSON(atob(encoded));
	} else {
		decoded = encoded;
	}

	return({
		...decoded,
		decimalPlaces: Number(decoded.decimalPlaces)
	});
}
