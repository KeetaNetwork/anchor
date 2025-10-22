import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as ASN1Types from '@keetanetwork/keetanet-client/lib/utils/asn1.ts';
/*
 * We import this file to make sure that the `asn1js` types are
 * defined, since they are required by the `ASN1toJS` and `JStoASN1`
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as _ignored_asn1js from 'asn1js';

import { Buffer } from './buffer.js';

const ASN1: typeof KeetaNetLib.Utils.ASN1 = KeetaNetLib.Utils.ASN1;

const ASN1toJS: typeof ASN1.ASN1toJS = ASN1.ASN1toJS;
const JStoASN1: typeof ASN1.JStoASN1 = ASN1.JStoASN1;
const BufferStorageASN1: typeof ASN1.BufferStorageASN1 = ASN1.BufferStorageASN1;
const ValidateASN1: typeof ASN1.ValidateASN1 = ASN1.ValidateASN1;
const ASN1CheckUtilities: typeof ASN1.ASN1CheckUtilities = ASN1.ASN1CheckUtilities;

type ASN1AnyJS = ASN1Types.ASN1AnyJS;
type ASN1ContextTag = ASN1Types.ASN1ContextTag;
type Schema = ASN1Types.ValidateASN1.Schema;
type SchemaMap<T extends Schema> = ASN1Types.ValidateASN1.SchemaMap<T>;
type StructFieldSchema = Schema | { optional: Schema };
type StructContains = Record<string, StructFieldSchema>;
type StructSchema = Extract<Schema, { type: 'struct' }>;

type EncodeOptions = {
	attributeName?: string;
	valuePrinter?: (value: unknown) => string;
};

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

const isStructSchema = (candidate: Schema): candidate is StructSchema => {
	return(
		typeof candidate === 'object'
		&& candidate !== null
		&& 'type' in candidate
		&& (candidate as { type?: unknown }).type === 'struct'
	);
};

const getFieldNames = (schema: StructSchema): string[] => {
	const structContains = schema.contains as StructContains;
	return Array.isArray(schema.fieldNames) && schema.fieldNames.length > 0
		? [...schema.fieldNames]
		: Object.keys(structContains);
};

const wrapWithExplicitContext = (index: number, schema: Schema): Schema => {
	if (typeof schema === 'object' && schema !== null && 'type' in schema && schema.type === 'context') {
		return(schema);
	}
	return({
		type: 'context',
		kind: 'explicit',
		value: index,
		contains: contextualizeStructSchema(schema)
	});
};

export function contextualizeStructSchema(schema: Schema): Schema {
	if (!isStructSchema(schema)) {
		return(schema);
	}

	const cached = structSchemaCache.get(schema as unknown as object);
	if (cached) {
		return(cached);
	}

	const structContains = schema.contains as StructContains;
	const fieldNames = getFieldNames(schema);

	const contextualizedContains: StructContains = {};
	for (const [index, fieldName] of fieldNames.entries()) {
		const fieldSchema = structContains[fieldName];
		if (!fieldSchema) {
			continue;
		}
		if (isOptionalSchema(fieldSchema)) {
			contextualizedContains[fieldName] = {
				optional: wrapWithExplicitContext(index, fieldSchema.optional)
			};
		} else {
			contextualizedContains[fieldName] = wrapWithExplicitContext(index, fieldSchema);
		}
	}

	const contextualized: Schema = {
		type: 'struct',
		fieldNames,
		contains: contextualizedContains
	};

	structSchemaCache.set(schema as unknown as object, contextualized);
	return(contextualized);
}

const prepareContextValue = (
	schema: Extract<Schema, { type: 'context' }>,
	value: unknown
): ASN1AnyJS => {
	if (value === undefined) {
		return(value as ASN1AnyJS);
	}
	if (isASN1ContextTag(value)) {
		const preparedContains = prepareValueForSchema(schema.contains, value.contains);
		if (preparedContains !== value.contains) {
			return({
				type: 'context',
				kind: value.kind,
				value: value.value,
				contains: preparedContains
			});
		}
		return(value as ASN1AnyJS);
	}
	const contains = prepareValueForSchema(schema.contains, value);
	return({
		type: 'context',
		kind: schema.kind,
		value: schema.value,
		contains
	});
};

const prepareStructValue = (
	schema: StructSchema,
	value: unknown
): ASN1AnyJS => {
	const structContains = schema.contains as StructContains;
	const fieldNames = getFieldNames(schema);

	if (isASN1Struct(value)) {
		const preparedContains: Record<string, ASN1AnyJS> = {};
		for (const [fieldName, fieldValue] of Object.entries(value.contains ?? {})) {
			const fieldSchema = structContains[fieldName];
			if (!fieldSchema) {
				preparedContains[fieldName] = fieldValue;
				continue;
			}
			const innerSchema = isOptionalSchema(fieldSchema) ? fieldSchema.optional : fieldSchema;
			preparedContains[fieldName] = prepareValueForSchema(innerSchema, fieldValue);
		}
		return({
			type: 'struct',
			fieldNames: value.fieldNames ?? fieldNames,
			contains: preparedContains
		});
	}

	if (!isPlainObject(value)) {
		return(value as ASN1AnyJS);
	}

	const preparedContains: Record<string, ASN1AnyJS> = {};
	for (const fieldName of fieldNames) {
		const fieldSchema = structContains[fieldName];
		if (!fieldSchema) {
			continue;
		}
		const fieldValue = (value as Record<string, unknown>)[fieldName];
		if (fieldValue === undefined) {
			if (!isOptionalSchema(fieldSchema)) {
				preparedContains[fieldName] = fieldValue;
			}
			continue;
		}
		const innerSchema = isOptionalSchema(fieldSchema) ? fieldSchema.optional : fieldSchema;
		preparedContains[fieldName] = prepareValueForSchema(innerSchema, fieldValue);
	}

	return({
		type: 'struct',
		fieldNames,
		contains: preparedContains
	});
};

function prepareValueForSchema(schema: Schema, value: unknown): ASN1AnyJS {
	const resolved = (() => {
		let current = schema;
		while (typeof current === 'function') {
			current = current();
		}
		return(current);
	})();

	if (value === undefined || value === null) {
		return(value as ASN1AnyJS);
	}

	if (Array.isArray(resolved)) {
		if (!Array.isArray(value)) {
			return(value as ASN1AnyJS);
		}
		return(resolved.map((itemSchema, index) => prepareValueForSchema(itemSchema, value[index])) as unknown as ASN1AnyJS);
	}

	if (typeof resolved === 'object' && resolved !== null) {
		if ('optional' in resolved) {
			if (value === undefined) {
				return(undefined as ASN1AnyJS);
			}
			return(prepareValueForSchema(resolved.optional, value));
		}
		if ('sequenceOf' in resolved) {
			if (!Array.isArray(value)) {
				return(value as ASN1AnyJS);
			}
			return(value.map(item => prepareValueForSchema(resolved.sequenceOf, item)) as unknown as ASN1AnyJS);
		}
		if ('choice' in resolved) {
			const choices = Array.isArray(resolved.choice)
				? resolved.choice
				: Array.from(resolved.choice);
			for (const choiceSchema of choices) {
				const prepared = prepareValueForSchema(choiceSchema, value);
				if (prepared !== value) {
					return(prepared);
				}
			}
			return(value as ASN1AnyJS);
		}
		if ('type' in resolved) {
			switch (resolved.type) {
				case 'context':
					return(prepareContextValue(resolved, value));
				case 'struct':
					return(prepareStructValue(resolved, value));
				default:
					return(value as ASN1AnyJS);
			}
		}
	}

	return(value as ASN1AnyJS);
}

export function encodeValueBySchema(schema: Schema, value: unknown, options?: EncodeOptions): ASN1AnyJS {
	const contextualized = contextualizeStructSchema(schema);
	try {
		const prepared = prepareValueForSchema(contextualized, value) as ASN1AnyJS;
		// @ts-ignore
		return(ValidateASN1.againstSchema(prepared, contextualized));
	} catch (error) {
		const printer = options?.valuePrinter ?? defaultPrintValue;
		const prefix = options?.attributeName ? `Attribute ${options.attributeName}: ` : '';
		const message = error instanceof Error ? error.message : String(error);
		throw(new Error(`${prefix}${message} (value: ${printer(value)})`));
	}
}

const { isASN1ContextTag, isASN1Struct, isASN1String, isASN1Date, isASN1BitString, isASN1Set } = ASN1CheckUtilities;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

export function normalizeDecodedASN1(input: unknown): unknown {
	if (input === undefined || input === null) {
		return(input);
	}
	if (Array.isArray(input)) {
		return(input.map(normalizeDecodedASN1));
	}
	if (input instanceof Date) {
		return(input);
	}
	if (Buffer.isBuffer(input) || input instanceof ArrayBuffer) {
		return(input);
	}
	if (isASN1ContextTag(input)) {
		return(normalizeDecodedASN1(input.contains));
	}
	if (isASN1String(input)) {
		return(normalizeDecodedASN1(input.value));
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
		const result: Record<string, unknown> = {};
		for (const fieldName of orderedNames) {
			if (!Object.prototype.hasOwnProperty.call(contains, fieldName)) {
				continue;
			}
			const fieldValue = contains[fieldName as keyof typeof contains];
			if (fieldValue !== undefined) {
				result[fieldName] = normalizeDecodedASN1(fieldValue);
			}
		}
		return(result);
	}
	if (isASN1Set(input)) {
		return({
			name: normalizeDecodedASN1(input.name),
			value: normalizeDecodedASN1(input.value)
		});
	}
	if (isPlainObject(input)) {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			result[key] = normalizeDecodedASN1(value);
		}
		return(result);
	}
	return(input);
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