import { KeetaAnchorUserValidationError } from "./error.js";
import { parseTokenMetadataJSON, stringifyTokenMetadataJSON } from "./token-metadata.generated.js";

export interface TokenMetadata {
	decimalPlaces: number;
	logoURI?: string;
}


export interface TokenMetadataJSON extends Omit<TokenMetadata, "decimalPlaces"> {
	decimalPlaces: number | string;
}

function parseDecimalPlaces(input: number | string): number {
	let valid = true;

	let value = input;
	if (typeof value === 'string') {
		if (value.trim() === '') {
			valid = false;
		}

		value = Number(value);
	}

	if (isNaN(value) || value < 0 || !Number.isInteger(value)) {
		valid = false;
	}

	if (!valid) {
		throw(new KeetaAnchorUserValidationError({
			fields: [
				{
					path: 'decimalPlaces',
					message: `Invalid decimalPlaces value: ${input}`
				}
			]
		}));
	}

	return(value);
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
		decimalPlaces: parseDecimalPlaces(decoded.decimalPlaces)
	});
}

/**
 * Encodes token metadata into a base64-encoded JSON string.
 *
 * @param metadata - The token metadata to encode {@link TokenMetadata}
 * @returns The base64-encoded JSON string containing the token metadata
 */
export function encodeTokenMetadata(metadata: TokenMetadata | TokenMetadataJSON): string {
	// Normalize metadata so that decimalPlaces is always a number, ensuring canonical encoding
	const normalized = decodeTokenMetadata(metadata);
	const payload = stringifyTokenMetadataJSON(normalized);
	return(btoa(payload));
}
