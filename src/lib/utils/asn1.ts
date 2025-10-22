import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as ASN1Types from '@keetanetwork/keetanet-client/lib/utils/asn1.ts';
import util from 'util';
/*
 * We import this file to make sure that the `asn1js` types are
 * defined, since they are required by the `ASN1toJS` and `JStoASN1`
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as _ignored_asn1js from 'asn1js';

import { arrayBufferToBuffer, Buffer } from './buffer.js';
import { hasIndexSignature, hasValueProp, isContextTagged } from './guards.js';

const ASN1: typeof KeetaNetLib.Utils.ASN1 = KeetaNetLib.Utils.ASN1;

const ASN1toJS: typeof ASN1.ASN1toJS = ASN1.ASN1toJS;
const JStoASN1: typeof ASN1.JStoASN1 = ASN1.JStoASN1;
const BufferStorageASN1: typeof ASN1.BufferStorageASN1 = ASN1.BufferStorageASN1;
const ValidateASN1: typeof ASN1.ValidateASN1 = ASN1.ValidateASN1;

type ASN1AnyJS = ASN1Types.ASN1AnyJS;
type ASN1ContextTag = ASN1Types.ASN1ContextTag;
type Schema = ASN1Types.ValidateASN1.Schema;
type SchemaMap<T extends Schema> = ASN1Types.ValidateASN1.SchemaMap<T>;

type EncodeOptions = {
	attributeName?: string;
	maxDepth?: number;
	valuePrinter?: (value: unknown) => string;
};

const DEFAULT_MAX_DEPTH = 8;
const structSchemaCache = new WeakMap<object, Schema>();

function defaultPrintValue(value: unknown): string {
	try {
		return(JSON.stringify(value));
	} catch {
		return(String(value));
	}
}

const isOptionalSchema = (candidate: unknown): candidate is { optional: Schema } => {
	return(typeof candidate === 'object' && candidate !== null && 'optional' in candidate);
};

const toASN1Primitive = (input: unknown, maxDepth: number, depth = 0): ASN1AnyJS => {
	if (depth >= maxDepth) {
		throw(new Error('Exceeded maximum ASN.1 value depth'));
	}
	if (util.types.isDate(input)) {
		return(input);
	}
	if (Buffer.isBuffer(input)) {
		return(input);
	}
	if (input instanceof ArrayBuffer) {
		return(arrayBufferToBuffer(input));
	}
	if (typeof input === 'string') {
		return({ type: 'string', kind: 'utf8', value: input });
	}
	if (typeof input === 'number' || typeof input === 'bigint' || typeof input === 'boolean') {
		return(input);
	}
	if (Array.isArray(input)) {
		return(input.map(item => toASN1Primitive(item, maxDepth, depth + 1)));
	}
	throw(new Error(`Unsupported ASN.1 value type: ${typeof input}`));
};

function ensureDate(input: unknown): Date {
	if (util.types.isDate(input)) {
		return(input);
	}
	if (typeof input === 'string' || typeof input === 'number') {
		const parsed = new Date(input);
		if (Number.isNaN(parsed.getTime())) {
			throw(new Error('Expected Date value'));
		}
		return(parsed);
	}
	throw(new Error('Expected Date value'));
}

export function contextualizeStructSchema(schema: Schema): Schema {
	if (typeof schema !== 'object' || schema === null) {
		return(schema);
	}
	if (!('type' in schema) || schema.type !== 'struct') {
		return(schema);
	}
	const cached = structSchemaCache.get(schema as object);
	if (cached) {
		return(cached);
	}
	const fieldNames = Array.isArray(schema.fieldNames) ? Array.from(schema.fieldNames) : [];
	const contains: { [key: string]: Schema } = {};

	const wrapSchemaWithContext = (index: number, fieldSchema: Schema): Schema => {
		if (typeof fieldSchema === 'object' && fieldSchema !== null && 'type' in fieldSchema && fieldSchema.type === 'context') {
			return(fieldSchema);
		}
		return({ type: 'context', kind: 'explicit', value: index, contains: fieldSchema });
	};

	fieldNames.forEach(function(fieldName, index) {
		const fieldSchema = schema.contains[fieldName];
		if (!fieldSchema) {
			return;
		}
		if (typeof fieldSchema === 'object' && fieldSchema !== null && 'optional' in fieldSchema) {
			contains[fieldName] = {
				optional: wrapSchemaWithContext(index, contextualizeStructSchema(fieldSchema.optional))
			};
		} else {
			contains[fieldName] = wrapSchemaWithContext(index, contextualizeStructSchema(fieldSchema));
		}
	});

	const contextualized: Schema = {
		type: 'struct',
		fieldNames: fieldNames,
		contains: contains
	};
	structSchemaCache.set(schema as object, contextualized);
	return(contextualized);
}

export function encodeValueBySchema(schema: Schema, value: unknown, options?: EncodeOptions): ASN1AnyJS {
	const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const valuePrinter = options?.valuePrinter ?? defaultPrintValue;
	const attributePrefix = options?.attributeName ? `Attribute ${options.attributeName}: ` : '';

	const throwWithContext = (message: string): never => {
		throw(new Error(`${attributePrefix}${message}`));
	};

	const encodeBigInt = (currentSchema: bigint, inputValue: unknown): bigint => {
		const numericValue = typeof inputValue === 'bigint' ? inputValue : (typeof inputValue === 'number' ? BigInt(inputValue) : undefined);
		if (numericValue !== currentSchema) {
			throwWithContext(`Expected fixed integer ${currentSchema.toString()}`);
		}
		return currentSchema;
	};

	const encodeTuple = (currentSchema: Schema[], inputValue: unknown, depth: number): ASN1AnyJS => {
		if (!Array.isArray(inputValue)) {
			throwWithContext('Expected tuple value');
		}
		const tupleValue = inputValue as unknown[];
		if (currentSchema.length !== tupleValue.length) {
			throwWithContext('Tuple length mismatch');
		}
		return currentSchema.map((schemaPart, index) => encode(schemaPart, tupleValue[index], depth + 1)) as ASN1AnyJS;
	};

	const encodePrimitive = (currentSchema: symbol, inputValue: unknown): ASN1AnyJS => {
		const primitiveHandlers: Record<symbol, (value: unknown) => ASN1AnyJS> = {
			[ValidateASN1.IsDate]: (value) => ensureDate(value),
			[ValidateASN1.IsString]: (value) => {
				if (typeof value !== 'string') {
					throwWithContext('Expected string value');
				}
				return value as string;
			},
			[ValidateASN1.IsAnyString]: (value) => {
				if (typeof value !== 'string') {
					throwWithContext('Expected string value');
				}
				return value as string;
			},
			[ValidateASN1.IsOctetString]: (value) => {
				if (Buffer.isBuffer(value)) {
					return value as Buffer;
				}
				if (value instanceof ArrayBuffer) {
					return arrayBufferToBuffer(value);
				}
				throwWithContext('Expected binary value');
			},
			[ValidateASN1.IsInteger]: (value) => {
				if (typeof value === 'number') {
					return BigInt(value);
				}
				if (typeof value === 'bigint') {
					return value;
				}
				throwWithContext('Expected integer value');
			},
			[ValidateASN1.IsBoolean]: (value) => {
				if (typeof value !== 'boolean') {
					throwWithContext('Expected boolean value');
				}
				return value as boolean;
			}
		};
		const handler = primitiveHandlers[currentSchema];
		if (handler) {
			return handler(inputValue);
		}
		throwWithContext(`Unsupported primitive schema`);
	};

	const encodeOptional = (currentSchema: { optional: Schema }, inputValue: unknown, depth: number): ASN1AnyJS | undefined => {
		if (inputValue === undefined || inputValue === null) {
			return undefined;
		}
		return encode(currentSchema.optional, inputValue, depth + 1);
	};

	const encodeChoice = (currentSchema: { choice: Schema[] | readonly Schema[] }, inputValue: unknown, depth: number): ASN1AnyJS => {
		for (const option of currentSchema.choice) {
			try {
				const encodedChoice = encode(option, inputValue, depth + 1);
				if (encodedChoice !== undefined) {
					return encodedChoice;
				}
			} catch {
				continue;
			}
		}
		throwWithContext(`Value ${valuePrinter(inputValue)} does not match any schema choice`);
	};

	const encodeSequenceOf = (currentSchema: { sequenceOf: Schema }, inputValue: unknown, depth: number): ASN1AnyJS => {
		if (!Array.isArray(inputValue)) {
			throwWithContext('Expected array value');
		}
		const sequenceValue = inputValue as unknown[];
		return sequenceValue.map((item) => encode(currentSchema.sequenceOf, item, depth + 1)) as ASN1AnyJS;
	};

	const encodeTyped = (currentSchema: Extract<Schema, { type: string }>, inputValue: unknown, depth: number): ASN1AnyJS => {
		const typeHandlers: Record<string, (schema: Extract<Schema, { type: string }>, inputValue: unknown, depth: number) => ASN1AnyJS> = {
			struct: (schema, inputValue, depth) => {
				const s = schema as { type: 'struct'; fieldNames: readonly string[]; contains: { [key: string]: Schema } };
				if (!hasIndexSignature(inputValue) || Array.isArray(inputValue)) {
					throwWithContext('Expected object value for struct');
				}
				const structFieldOrder = Array.from(s.fieldNames);
				const structContains: { [field: string]: ASN1AnyJS } = {};
				for (const fieldName of structFieldOrder) {
					const fieldSchema = s.contains[fieldName];
					if (!fieldSchema) {
						continue;
					}
					const fieldValue = (inputValue as { [key: string]: unknown })[fieldName];
					if (fieldValue === undefined || fieldValue === null) {
						if (isOptionalSchema(fieldSchema)) {
							continue;
						}
						throwWithContext(`Missing required field '${fieldName}'`);
					}
					const encodedField = encode(fieldSchema, fieldValue, depth + 1);
					if (encodedField !== undefined) {
						structContains[fieldName] = encodedField;
					}
				}
				return {
					type: 'struct',
					fieldNames: structFieldOrder,
					contains: structContains
				};
			},
			string: (schema, inputValue, depth) => {
				const s = schema as { type: 'string'; kind: string };
				if (typeof inputValue !== 'string') {
					throwWithContext('Expected string value');
				}
				return { type: 'string', kind: s.kind as any, value: inputValue as string };
			},
			date: (schema, inputValue, depth) => {
				const s = schema as { type: 'date'; kind: string };
				const dateValue = ensureDate(inputValue);
				return { type: 'date', kind: s.kind as any, date: dateValue };
			},
			context: (schema, inputValue, depth) => {
				const s = schema as { type: 'context'; kind: 'implicit' | 'explicit'; contains: Schema; value: number };
				const inner = encode(s.contains, inputValue, depth + 1);
				if (inner === undefined) {
					throwWithContext('Context value missing');
				}
				return { type: 'context', kind: s.kind, value: s.value, contains: inner };
			},
			oid: (schema, inputValue, depth) => {
				if (typeof inputValue !== 'string') {
					throwWithContext('Expected OID string value');
				}
				return { type: 'oid', oid: inputValue as string };
			}
		};

		const schemaType = currentSchema.type;
		const handler = typeHandlers[schemaType];
		if (handler) {
			return handler(currentSchema, inputValue, depth);
		}
		throwWithContext(`Unsupported schema type '${String(schemaType)}'`);
	};

	const encode = (currentSchema: Schema, inputValue: unknown, depth = 0): ASN1AnyJS | undefined => {
		if (depth >= maxDepth) {
			throwWithContext('Exceeded maximum ASN.1 value depth');
		}

		if (typeof currentSchema === 'function') {
			return encode(currentSchema(), inputValue, depth + 1);
		}

		if (typeof currentSchema === 'bigint') {
			return encodeBigInt(currentSchema, inputValue);
		}

		if (Array.isArray(currentSchema)) {
			return encodeTuple(currentSchema, inputValue, depth);
		}

		if (typeof currentSchema === 'symbol') {
			return encodePrimitive(currentSchema, inputValue);
		}

		if (typeof currentSchema === 'object' && currentSchema !== null) {
			if ('optional' in currentSchema) {
				return encodeOptional(currentSchema, inputValue, depth);
			}
			if ('choice' in currentSchema) {
				return encodeChoice(currentSchema, inputValue, depth);
			}
			if ('sequenceOf' in currentSchema) {
				return encodeSequenceOf(currentSchema, inputValue, depth);
			}
			if ('type' in currentSchema) {
				return encodeTyped(currentSchema as Extract<Schema, { type: string }>, inputValue, depth);
			}
		}

		return toASN1Primitive(inputValue, maxDepth, depth + 1);
	};

	const encoded = encode(schema, value);
	if (encoded === undefined) {
		throwWithContext(`Unable to encode value ${valuePrinter(value)}`);
	}
	return encoded;
}

export function normalizeDecodedASN1(input: unknown): unknown {
	const normalizeStruct = (candidate: { [key: string]: unknown; type?: string; fieldNames?: readonly string[]; contains?: unknown }): unknown => {
		const containsRaw = hasIndexSignature(candidate.contains) ? candidate.contains as { [key: string]: unknown } : {};
		const orderedNames = Array.isArray(candidate.fieldNames) ? candidate.fieldNames : Object.keys(containsRaw);
		const structResult: { [key: string]: unknown } = {};
		for (const fieldName of orderedNames) {
			const fieldValue = containsRaw[fieldName];
			if (fieldValue === undefined) {
				continue;
			}
			structResult[fieldName] = normalizeDecodedASN1(fieldValue);
		}
		return structResult;
	};

	const normalizeString = (candidate: { [key: string]: unknown; value?: unknown }): unknown => {
		return typeof candidate.value === 'string' ? candidate.value : normalizeDecodedASN1(candidate.value);
	};

	const normalizeDate = (candidate: { [key: string]: unknown; date?: unknown }): unknown => {
		if (util.types.isDate(candidate.date)) {
			return candidate.date;
		}
		return candidate;
	};

	const normalizeOid = (candidate: { [key: string]: unknown; oid?: unknown }): unknown => {
		return candidate.oid;
	};

	const normalizeBitstring = (candidate: { [key: string]: unknown; value?: unknown }): unknown => {
		return candidate.value;
	};

	const normalizeFallback = (candidate: { [key: string]: unknown }): unknown => {
		const fallbackResult: { [key: string]: unknown } = {};
		for (const [key, val] of Object.entries(candidate)) {
			if (key === 'type' || key === 'fieldNames' || key === 'contains') {
				continue;
			}
			fallbackResult[key] = normalizeDecodedASN1(val);
		}
		return Object.keys(fallbackResult).length > 0 ? fallbackResult : undefined;
	};

	if (input === undefined || input === null) {
		return input;
	}
	if (util.types.isDate(input)) {
		return input;
	}
	if (Buffer.isBuffer(input)) {
		return input;
	}
	if (Array.isArray(input)) {
		return input.map(item => normalizeDecodedASN1(item));
	}
	if (isContextTagged(input)) {
		return normalizeDecodedASN1(input.contains);
	}
	if (hasValueProp(input)) {
		return normalizeDecodedASN1(input.value);
	}
	if (hasIndexSignature(input)) {
		const candidate = input as { [key: string]: unknown; type?: string; fieldNames?: readonly string[]; contains?: unknown };
		const normalizers: Record<string, (candidate: { [key: string]: unknown }) => unknown> = {
			struct: normalizeStruct,
			string: normalizeString,
			date: normalizeDate,
			oid: normalizeOid,
			bitstring: normalizeBitstring
		};
		const normalizer = normalizers[candidate.type || ''];
		if (normalizer) {
			return normalizer(candidate);
		}
		const fallback = normalizeFallback(candidate);
		if (fallback !== undefined) {
			return fallback;
		}
	}
	return input;
}

export type {
	ASN1AnyJS,
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
