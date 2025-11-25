import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as ASN1Types from '@keetanetwork/keetanet-client/lib/utils/asn1.ts';
import { EncryptedContainer } from '../encrypted-container.js';
import { Buffer, bufferToArrayBuffer } from './buffer.js';
import { checkHashWithOID } from './external.js';

/* ENUM */
type AccountKeyAlgorithm = InstanceType<typeof KeetaNetLib.Account>['keyType'];

/**
 * An alias for the KeetaNetAccount type
 */
type KeetaNetAccount = ReturnType<typeof KeetaNetLib.Account.fromSeed<AccountKeyAlgorithm>>;
const KeetaNetAccount: typeof KeetaNetLib.Account = KeetaNetLib.Account;

/*
 * We import this file to make sure that the `asn1js` types are
 * defined, since they are required by the `ASN1toJS` and `JStoASN1`
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as _ignored_asn1js from 'asn1js';

const ASN1: typeof KeetaNetLib.Utils.ASN1 = KeetaNetLib.Utils.ASN1;

const ASN1toJS: typeof ASN1.ASN1toJS = ASN1.ASN1toJS;
const JStoASN1: typeof ASN1.JStoASN1 = ASN1.JStoASN1;
const BufferStorageASN1: typeof ASN1.BufferStorageASN1 = ASN1.BufferStorageASN1;
const ValidateASN1: typeof ASN1.ValidateASN1 = ASN1.ValidateASN1;

type ASN1AnyJS = ASN1Types.ASN1AnyJS;
type ASN1OID = ASN1Types.ASN1OID;
type ASN1ContextTag = ASN1Types.ASN1ContextTag;
type Schema = ASN1Types.ValidateASN1.Schema;
type SchemaMap<T extends Schema> = ASN1Types.ValidateASN1.SchemaMap<T>;

type EncodeOptions = {
	attributeName?: string;
	valuePrinter?: (value: unknown) => string;
};

function defaultPrintValue(value: unknown): string {
	try {
		return(JSON.stringify(value));
	} catch {
		return(String(value));
	}
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

export function encodeValueBySchema(schema: Schema, value: unknown, options?: EncodeOptions): ASN1AnyJS {
	try {
		// XXX:TODO Fix depth issue
		// @ts-ignore

		return(new ValidateASN1(schema).fromJavaScriptObject(value));
	} catch (err) {
		const printer = options?.valuePrinter ?? defaultPrintValue;
		const prefix = options?.attributeName ? `Attribute ${options.attributeName}: ` : '';
		const message = err instanceof Error ? err.message : String(err);

		throw(new Error(`${prefix}${message} (value: ${printer(value)})`));
	}
}

// Helper to recursively normalize object properties
function normalizeDecodedASN1Object(obj: object, principals: KeetaNetAccount[]): { [key: string]: unknown } {
	const result: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(obj)) {
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		result[key] = normalizeDecodedASN1(value, principals);
	}
	return(result);
}

/**
 * Post-process the output from toJavaScriptObject() to:
 * 1. Unwrap any remaining ASN.1-like objects (from IsAnyString/IsAnyDate)
 * 2. Add domain-specific $blob function to Reference objects
 */
export function normalizeDecodedASN1(input: unknown, principals: KeetaNetAccount[]): unknown {
	// Handle primitives
	if (input === undefined || input === null || typeof input !== 'object') {
		return(input);
	}
	if (input instanceof Date || Buffer.isBuffer(input) || input instanceof ArrayBuffer) {
		return(input);
	}

	// Handle arrays
	if (Array.isArray(input)) {
		return(input.map(item => normalizeDecodedASN1(item, principals)));
	}

	// Unwrap ASN.1-like objects from ambiguous schemas (IsAnyString, IsAnyDate, IsBitString)
	// These are plain objects like { type: 'string', kind: 'utf8', value: 'text' }
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	const obj = input as { type?: string; kind?: string; value?: unknown; unusedBits?: number };
	if (obj.type === 'string' && 'value' in obj && typeof obj.value === 'string') {
		return(obj.value);
	}
	if (obj.type === 'date' && 'value' in obj && obj.value instanceof Date) {
		return(obj.value);
	}
	if (obj.type === 'bitstring' && 'value' in obj && Buffer.isBuffer(obj.value)) {
		return(obj.value);
	}

	// Check if this is a Reference object (has external.url and digest fields)
	if ('external' in obj && 'digest' in obj && isPlainObject(obj.external) && isPlainObject(obj.digest)) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const ref = obj as { external: { url?: string; contentType?: string }; digest?: { digestAlgorithm?: string | { oid?: string }; digest?: unknown }; encryptionAlgorithm?: string | { oid?: string }};
		const url = ref.external.url;
		const mimeType = ref.external.contentType;

		// After toJavaScriptObject(), OIDs are strings, not {oid: string}
		const encryptionAlgoOID = typeof ref.encryptionAlgorithm === 'string'
			? ref.encryptionAlgorithm
			: ref.encryptionAlgorithm?.oid;
		const digestInfo = ref.digest;

		if (typeof url === 'string' && typeof mimeType === 'string' && digestInfo) {
			let cachedValue: Blob | null = null;

			return({
				...normalizeDecodedASN1Object(obj, principals),
				$blob: async function(additionalPrincipals?: ConstructorParameters<typeof EncryptedContainer>[0]): Promise<Blob> {
					if (cachedValue) {
						return(cachedValue);
					}

					const fetchResult = await fetch(url);
					if (!fetchResult.ok) {
						throw(new Error(`Failed to fetch remote data from ${url}: ${fetchResult.status} ${fetchResult.statusText}`));
					}

					const dataBlob = await fetchResult.blob();
					let data = await dataBlob.arrayBuffer();

					// Handle JSON base64 encoding
					if (dataBlob.type === 'application/json') {
						try {
							const asJSON: unknown = JSON.parse(Buffer.from(data).toString('utf-8'));
							if (isPlainObject(asJSON) && Object.keys(asJSON).length === 2) {
								if ('data' in asJSON && typeof asJSON.data === 'string' && 'mimeType' in asJSON && typeof asJSON.mimeType === 'string') {
									data = bufferToArrayBuffer(Buffer.from(asJSON.data, 'base64'));
								}
							}
						} catch {
							/* Ignored */
						}
					}

					// Decrypt if needed
					if (encryptionAlgoOID) {
						switch (encryptionAlgoOID) {
							case '1.3.6.1.4.1.62675.2':
							case 'KeetaEncryptedContainerV1': {
								const container = EncryptedContainer.fromEncryptedBuffer(data, [
									...principals,
									...(additionalPrincipals ?? [])
								]);
								data = await container.getPlaintext();
								break;
							}
							default:
								throw(new Error(`Unsupported encryption algorithm OID: ${encryptionAlgoOID}`));
						}
					}

					// Verify hash (checkHashWithOID now accepts string OIDs directly)
					if (!Buffer.isBuffer(digestInfo.digest)) {
						throw(new TypeError('Digest value is not a buffer'));
					}

					const validHash = await checkHashWithOID(data, digestInfo);
					if (validHash !== true) {
						throw(validHash);
					}

					const blob = new Blob([data], { type: mimeType });
					cachedValue = blob;
					return(blob);
				}
			});
		}
	}

	// Recursively process plain objects
	return(normalizeDecodedASN1Object(obj, principals));
}

export type {
	ASN1AnyJS,
	ASN1OID,
	ASN1ContextTag,
	Schema,
	SchemaMap
};

export {
	ASN1toJS,
	JStoASN1,
	BufferStorageASN1,
	ValidateASN1
};
