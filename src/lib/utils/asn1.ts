import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as ASN1Types from '@keetanetwork/keetanet-client/lib/utils/asn1.ts';
import { isReferenceSchema } from './asn1.generated.js';
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

import { assert, createAssert, createIs } from 'typia';

const ASN1: typeof KeetaNetLib.Utils.ASN1 = KeetaNetLib.Utils.ASN1;

const ASN1toJS: typeof ASN1.ASN1toJS = ASN1.ASN1toJS;
const JStoASN1: typeof ASN1.JStoASN1 = ASN1.JStoASN1;
const BufferStorageASN1: typeof ASN1.BufferStorageASN1 = ASN1.BufferStorageASN1;
const ValidateASN1: typeof ASN1.ValidateASN1 = ASN1.ValidateASN1;
const ASN1CheckUtilities: typeof ASN1.ASN1CheckUtilities = ASN1.ASN1CheckUtilities;

const { isASN1ContextTag, isASN1Struct, isASN1String, isASN1Date, isASN1BitString, isASN1Set } = ASN1CheckUtilities;

type ASN1AnyJS = ASN1Types.ASN1AnyJS;
type ASN1OID = ASN1Types.ASN1OID;
type ASN1ContextTag = ASN1Types.ASN1ContextTag;
type Schema = ASN1Types.ValidateASN1.Schema;
type SchemaMap<T extends Schema> = ASN1Types.ValidateASN1.SchemaMap<T>;
type StructFieldSchema = Schema | { optional: Schema };
type StructSchema = Extract<Schema, { type: 'struct' }>;
type StructFieldSchemaMap = { [field: string]: StructFieldSchema };
type SchemaPreparer = (schema: Schema, value: unknown) => unknown;

type EncodeOptions = {
	attributeName?: string;
	valuePrinter?: (value: unknown) => string;
};

const assertStructFieldSchemaMap = createAssert<StructFieldSchemaMap>();
const structSchemaGuard = createIs<StructSchema>();

const structSchemaCache = new WeakMap<StructSchema, Schema>();

function defaultPrintValue(value: unknown): string {
	try {
		return(JSON.stringify(value));
	} catch {
		return(String(value));
	}
}

function isOptionalSchema(candidate: unknown): candidate is { optional: Schema } {
	return(typeof candidate === 'object' && candidate !== null && 'optional' in candidate);
}

function isStructSchema(candidate: Schema): candidate is StructSchema {
	return(structSchemaGuard(candidate));
}

function ensureStructContains(schema: StructSchema): StructFieldSchemaMap {
	if (!schema.contains) {
		return({});
	}
	return(assertStructFieldSchemaMap(schema.contains));
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function getFieldNames(schema: StructSchema): string[] {
	return(Array.isArray(schema.fieldNames) && schema.fieldNames.length > 0
		? [...schema.fieldNames]
		: Object.keys(ensureStructContains(schema)));
}

export function contextualizeStructSchema(schema: Schema): Schema {
	if (!isStructSchema(schema)) {
		return(schema);
	}

	const cached = structSchemaCache.get(schema);
	if (cached) {
		return(cached);
	}

	const fieldNames = getFieldNames(schema);
	const structContains = ensureStructContains(schema);
	const contextualizedContains: StructFieldSchemaMap = {};

	function wrapWithExplicitContext(index: number, innerSchema: Schema): Schema {
		if (typeof innerSchema === 'object' && innerSchema !== null && 'type' in innerSchema && innerSchema.type === 'context') {
			return(innerSchema);
		}
		return({
			type: 'context',
			kind: 'explicit',
			value: index,
			contains: contextualizeStructSchema(innerSchema)
		});
	}

	for (const [index, fieldName] of fieldNames.entries()) {
		const fieldSchema = structContains[fieldName];
		if (!fieldSchema) {
			continue;
		}
		if (isOptionalSchema(fieldSchema)) {
			contextualizedContains[fieldName] = {
				optional: wrapWithExplicitContext(index, fieldSchema.optional)
			};
			continue;
		}
		contextualizedContains[fieldName] = wrapWithExplicitContext(index, fieldSchema);
	}

	const contextualized: Schema = {
		type: 'struct',
		fieldNames,
		contains: contextualizedContains
	};

	structSchemaCache.set(schema, contextualized);
	return(contextualized);
}

function resolveSchema(schema: Schema): Schema {
	let current: Schema = schema;
	while (typeof current === 'function') {
		current = current();
	}
	return(current);
}

function prepareContextValue(schema: Extract<Schema, { type: 'context' }>, value: unknown, prepare: SchemaPreparer): unknown {
	if (value === undefined) {
		return(value);
	}
	if (isASN1ContextTag(value)) {
		const preparedContains = prepare(schema.contains, value.contains);
		if (preparedContains !== value.contains) {
			return({
				type: 'context',
				kind: value.kind,
				value: value.value,
				contains: preparedContains
			});
		}
		return(value);
	}
	const contains = prepare(schema.contains, value);
	return({
		type: 'context',
		kind: schema.kind,
		value: schema.value,
		contains
	});
}

function prepareStructValue(schema: StructSchema, value: unknown): unknown {
	const structContains = schema.contains ?? {};
	const fieldNames = getFieldNames(schema);

	if (isASN1Struct(value)) {
		const preparedContains: { [key: string]: unknown } = {};
		for (const [fieldName, fieldValue] of Object.entries(value.contains ?? {})) {
			const fieldSchema = structContains[fieldName];
			if (!fieldSchema) {
				preparedContains[fieldName] = fieldValue;
				continue;
			}
			const innerSchema = isOptionalSchema(fieldSchema) ? fieldSchema.optional : fieldSchema;
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			preparedContains[fieldName] = prepareValueForSchema(innerSchema, fieldValue);
		}
		return({
			type: 'struct',
			fieldNames: value.fieldNames ?? fieldNames,
			contains: preparedContains
		});
	}

	if (!isPlainObject(value)) {
		return(value);
	}

	const preparedContains: { [key: string]: unknown } = {};
	for (const fieldName of fieldNames) {
		const fieldSchema = structContains[fieldName];
		if (!fieldSchema) {
			continue;
		}
		const fieldValue = value[fieldName];
		if (fieldValue === undefined) {
			if (!isOptionalSchema(fieldSchema)) {
				preparedContains[fieldName] = fieldValue;
			}
			continue;
		}
		const innerSchema = isOptionalSchema(fieldSchema) ? fieldSchema.optional : fieldSchema;
		// eslint-disable-next-line @typescript-eslint/no-use-before-define
		preparedContains[fieldName] = prepareValueForSchema(innerSchema, fieldValue);
	}

	return({
		type: 'struct',
		fieldNames,
		contains: preparedContains
	});
}

function prepareValueForSchema(schema: Schema, value: unknown): unknown {
	const resolved = resolveSchema(schema);

	if (value === undefined || value === null) {
		return(value);
	}

	if (Array.isArray(resolved)) {
		if (!Array.isArray(value)) {
			return(value);
		}
		const result = [];
		for (let i = 0; i < resolved.length; i++) {
			result.push(prepareValueForSchema(assert<Schema>(resolved[i]), value[i]));
		}
		return(result);
	}	if (typeof resolved === 'object' && resolved !== null) {
		if ('optional' in resolved) {
			if (value === undefined) {
				return(undefined);
			}
			return(prepareValueForSchema(resolved.optional, value));
		}
		if ('sequenceOf' in resolved) {
			if (!Array.isArray(value)) {
				return(value);
			}
			return(value.map(item => prepareValueForSchema(resolved.sequenceOf, item)));
		}
		if ('choice' in resolved) {
			const choices = Array.isArray(resolved.choice)
				? resolved.choice
				: Array.from(resolved.choice);
			for (const choiceSchema of choices) {
				const preparedChoice = prepareValueForSchema(choiceSchema, value);
				if (preparedChoice !== value) {
					return(preparedChoice);
				}
			}
			return(value);
		}
		if ('type' in resolved) {
			switch (resolved.type) {
				case 'context':
					return(prepareContextValue(resolved, value, prepareValueForSchema));
				case 'struct':
					return(prepareStructValue(resolved, value));
				default:
					return(value);
			}
		}
	}

	return(value);
}

export function encodeValueBySchema(schema: Schema, value: unknown, options?: EncodeOptions): ASN1AnyJS {
	const contextualized = contextualizeStructSchema(schema);
	try {
		const preparedUnknown = prepareValueForSchema(contextualized, value);
		// XXX:TODO Fix depth issue
		// @ts-ignore
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/consistent-type-assertions
		return(ValidateASN1.againstSchema(preparedUnknown as ASN1AnyJS, contextualized));
	} catch (err) {
		const printer = options?.valuePrinter ?? defaultPrintValue;
		const prefix = options?.attributeName ? `Attribute ${options.attributeName}: ` : '';
		const message = err instanceof Error ? err.message : String(err);

		throw(new Error(`${prefix}${message} (value: ${printer(value)})`));
	}
}

export function normalizeDecodedASN1(input: unknown, principals: KeetaNetAccount[]): unknown {
	if (input === undefined || input === null) {
		return(input);
	}
	if (Array.isArray(input)) {
		return(input.map(function(childInput) {
			return(normalizeDecodedASN1(childInput, principals));
		}));
	}
	if (input instanceof Date) {
		return(input);
	}
	if (Buffer.isBuffer(input) || input instanceof ArrayBuffer) {
		return(input);
	}
	if (isASN1ContextTag(input)) {
		return(normalizeDecodedASN1(input.contains, principals));
	}
	if (isASN1String(input)) {
		return(normalizeDecodedASN1(input.value, principals));
	}
	if (isASN1Date(input)) {
		return(input.date);
	}
	if (isASN1BitString(input)) {
		return(input.value);
	}
	if (isASN1Struct(input)) {
		const contains = input.contains ?? {};
		const orderedNames = Array.isArray(input.fieldNames) && input.fieldNames.length > 0
			? input.fieldNames
			: Object.keys(contains);
		const result: { [key: string]: unknown } = {};
		for (const fieldName of orderedNames) {
			if (!Object.prototype.hasOwnProperty.call(contains, fieldName)) {
				continue;
			}
			const fieldValue = contains[fieldName];
			if (fieldValue !== undefined) {
				result[fieldName] = normalizeDecodedASN1(fieldValue, principals);
			}
		}

		if (isReferenceSchema(input)) {
			const url = input.contains.external.contains.url.value;
			const mimeType = input.contains.external.contains.contentType.value;
			const encryptionAlgoOID = input.contains.encryptionAlgorithm?.oid;
			const digestInfo = input.contains.digest.contains;
			let cachedValue: Blob | null = null;
			result['$blob'] = async function(additionalPrincipals?: ConstructorParameters<typeof EncryptedContainer>[0]): Promise<Blob> {
				/*
				 * If we already have the cached value, return it
				 */
				if (cachedValue) {
					return(cachedValue);
				}
				/*
				 * Fetch the remote data
				 */
				const result = await fetch(url);
				if (!result.ok) {
					throw(new Error(`Failed to fetch remote data from ${url}: ${result.status} ${result.statusText}`));
				}

				const dataBlob = await result.blob();
				let data = await dataBlob.arrayBuffer();

				/*
				 * Sometimes people like to encode the data
				 * in a JSON base64 string, check to see if
				 * that's the case -- hopefully this doesn't
				 * conflict with any legitimate use case
				 */
				if (dataBlob.type === 'application/json') {
					try {
						const asJSON: unknown = JSON.parse(Buffer.from(data).toString('utf-8'));
						if (isPlainObject(asJSON)) {
							if (Object.keys(asJSON).length === 2) {
								if ('data' in asJSON && typeof asJSON.data === 'string' && 'mimeType' in asJSON && typeof asJSON.mimeType === 'string') {
									data = bufferToArrayBuffer(Buffer.from(asJSON.data, 'base64'));
								}
							}
						}
					} catch {
						/* Ignored */
					}
				}

				/*
				 * Decrypt the data, if encrypted
				 */
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

				/*
				 * Compute and verify the hash (of the plain text)
				 */
				if (!Buffer.isBuffer(digestInfo.digest)) {
					throw(new TypeError('Digest value is not a buffer'));
				}
				const validHash = await checkHashWithOID(data, {
					digest: digestInfo.digest,
					digestAlgorithm: digestInfo.digestAlgorithm
				});
				if (validHash !== true) {
					throw(validHash);
				}

				const blob = new Blob([data], { type: mimeType });
				cachedValue = blob;
				return(blob);
			}
		}
		return(result);
	}
	if (isASN1Set(input)) {
		return({
			name: normalizeDecodedASN1(input.name, principals),
			value: normalizeDecodedASN1(input.value, principals)
		});
	}
	if (isPlainObject(input)) {
		const result: { [key: string]: unknown } = {};
		for (const [key, value] of Object.entries(input)) {
			result[key] = normalizeDecodedASN1(value, principals);
		}
		return(result);
	}

	return(input);
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
