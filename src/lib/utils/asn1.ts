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

const toASN1Primitive = (input: unknown): ASN1AnyJS => {
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
		const stack: Array<{ arr: unknown[], index: number, resolve: (result: unknown) => void }> = [];
		const result: unknown[] = new Array(input.length);
		let completed = 0;
		const collect = () => {
			if (++completed === input.length) {
				// done
			}
		};
		for (let i = 0; i < input.length; i++) {
			stack.push({
				arr: input,
				index: i,
				resolve: (r) => {
					result[i] = r;
					collect();
				}
			});
		}
		while (stack.length > 0) {
			const task = stack.pop()!;
			const item = task.arr[task.index];
			if (util.types.isDate(item)) {
				task.resolve(item);
			} else if (Buffer.isBuffer(item)) {
				task.resolve(item);
			} else if (item instanceof ArrayBuffer) {
				task.resolve(arrayBufferToBuffer(item));
			} else if (typeof item === 'string') {
				task.resolve({ type: 'string', kind: 'utf8', value: item });
			} else if (typeof item === 'number' || typeof item === 'bigint' || typeof item === 'boolean') {
				task.resolve(item);
			} else if (Array.isArray(item)) {
				const subResult: unknown[] = new Array(item.length);
				let subCompleted = 0;
				const subCollect = () => {
					if (++subCompleted === item.length) {
						task.resolve(subResult);
					}
				};
				for (let j = 0; j < item.length; j++) {
					stack.push({
						arr: item,
						index: j,
						resolve: (r) => {
							subResult[j] = r;
							subCollect();
						}
					});
				}
			} else {
				throw(new Error(`Unsupported ASN.1 value type: ${typeof item}`));
			}
		}
		return(result as ASN1AnyJS);
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
		return(currentSchema);
	};

	const handleFunctionSchema = (schema: () => Schema, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>) => {
		stack.push({ type: 'encode', schema: schema(), value, resolve });
	};

	const handleBigIntSchema = (schema: bigint, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void) => {
		resolve(encodeBigInt(schema, value));
	};

	const handleTuple = (schema: Schema[], value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>, throwWithContext: (message: string) => never) => {
		if (!Array.isArray(value)) {
			throwWithContext('Expected tuple value');
		}
		const tupleValue = value as unknown[];
		if (schema.length !== tupleValue.length) {
			throwWithContext('Tuple length mismatch');
		}
		const results: ASN1AnyJS[] = [];
		let completed = 0;
		for (let i = 0; i < schema.length; i++) {
			stack.push({
				type: 'encode',
				schema: schema[i]!,
				value: tupleValue[i],
				resolve: (r) => {
					results[i] = r as ASN1AnyJS;
					if (++completed === schema.length) {
						resolve(results as ASN1AnyJS);
					}
				}
			});
		}
	};

	const handlePrimitive = (schema: symbol, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, throwWithContext: (message: string) => never) => {
		const primitiveHandlers: { [key: symbol]: (value: unknown) => ASN1AnyJS } = {
			[ValidateASN1.IsAny]: (value) => value as ASN1AnyJS,
			[ValidateASN1.IsUnknown]: (value) => value as ASN1AnyJS,
			[ValidateASN1.IsDate]: (value) => ensureDate(value),
			[ValidateASN1.IsAnyDate]: (value) => value as ASN1Types.ASN1Date,
			[ValidateASN1.IsString]: (value) => {
				if (typeof value !== 'string') {
					throwWithContext('Expected string value');
				}
				return(value as string);
			},
			[ValidateASN1.IsAnyString]: (value) => value as ASN1Types.ASN1String,
			[ValidateASN1.IsOctetString]: (value) => {
				if (Buffer.isBuffer(value)) {
					return(value);
				}
				if (value instanceof ArrayBuffer) {
					return(arrayBufferToBuffer(value));
				}
				throwWithContext('Expected binary value');
			},
			[ValidateASN1.IsBitString]: (value) => value as ASN1Types.ASN1BitString,
			[ValidateASN1.IsInteger]: (value) => {
				if (typeof value === 'number') {
					return(BigInt(value));
				}
				if (typeof value === 'bigint') {
					return(value);
				}
				throwWithContext('Expected integer value');
			},
			[ValidateASN1.IsBoolean]: (value) => {
				if (typeof value !== 'boolean') {
					throwWithContext('Expected boolean value');
				}
				return(value as boolean);
			},
			[ValidateASN1.IsOID]: (value) => value as ASN1Types.ASN1OID,
			[ValidateASN1.IsSet]: (value) => value as ASN1Types.ASN1Set,
			[ValidateASN1.IsNull]: (value) => value as null
		};
		const handler = primitiveHandlers[schema];
		if (handler) {
			resolve(handler(value));
		} else {
			throwWithContext(`Unsupported primitive schema`);
		}
	};

	const handleOptional = (schema: { optional: Schema }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>) => {
		if (value === undefined || value === null) {
			resolve(undefined);
		} else {
			stack.push({ type: 'encode', schema: schema.optional, value, resolve });
		}
	};

	const handleChoice = (schema: { choice: Schema[] | readonly Schema[] }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>) => {
		stack.push({ type: 'choice', schema, value, resolve, choiceIndex: 0 });
	};

	const handleSequenceOf = (schema: { sequenceOf: Schema }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>, throwWithContext: (message: string) => never) => {
		if (!Array.isArray(value)) {
			throwWithContext('Expected array value');
		}
		const sequenceValue = value as unknown[];
		const results: ASN1AnyJS[] = [];
		let completed = 0;
		for (let i = 0; i < sequenceValue.length; i++) {
			stack.push({
				type: 'encode',
				schema: schema.sequenceOf,
				value: sequenceValue[i],
				resolve: (r) => {
					results[i] = r as ASN1AnyJS;
					if (++completed === sequenceValue.length) {
						resolve(results as ASN1AnyJS);
					}
				}
			});
		}
	};

	const handleTyped = (schema: Extract<Schema, { type: string }>, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: Array<{type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number}>, throwWithContext: (message: string) => never) => {
		const s = schema;
		switch (s.type) {
			case 'struct': {
				if (!hasIndexSignature(value) || Array.isArray(value)) {
					throwWithContext('Expected object value for struct');
				}
				const structFieldOrder = Array.from(s.fieldNames);
				const structContains: { [field: string]: ASN1AnyJS } = {};
				let structCompleted = 0;
				const structCollect = () => {
					if (++structCompleted === structFieldOrder.length) {
						resolve({
							type: 'struct',
							fieldNames: structFieldOrder,
							contains: structContains
						});
					}
				};
				for (const fieldName of structFieldOrder) {
					const fieldSchema = s.contains[fieldName];
					if (!fieldSchema) {
						structCollect();
						continue;
					}
					const fieldValue = (value as { [key: string]: unknown })[fieldName];
					if (fieldValue === undefined || fieldValue === null) {
						if (isOptionalSchema(fieldSchema)) {
							structCollect();
							continue;
						}
						throwWithContext(`Missing required field '${fieldName}'`);
					}
					stack.push({
						type: 'encode',
						schema: fieldSchema,
						value: fieldValue,
						resolve: (r) => {
							if (r !== undefined) {
								structContains[fieldName] = r;
							}
							structCollect();
						}
					});
				}
				break;
			}
			case 'string': {
				const ss = s as { type: 'string'; kind: 'printable' | 'ia5' | 'utf8' };
				if (typeof value !== 'string') {
					throwWithContext('Expected string value');
				}
				resolve({ type: 'string', kind: ss.kind, value: value as string });
				break;
			}
			case 'date': {
				const ds = s as { type: 'date'; kind: 'default' | 'utc' | 'general' };
				const dateValue = ensureDate(value);
				resolve({ type: 'date', kind: ds.kind, date: dateValue });
				break;
			}
			case 'context': {
				const cs = s as { type: 'context'; kind: 'implicit' | 'explicit'; contains: Schema; value: number };
				stack.push({
					type: 'encode',
					schema: cs.contains,
					value,
					resolve: (r) => {
						if (r === undefined) {
							throwWithContext('Context value missing');
						}
						resolve({ type: 'context', kind: cs.kind, value: cs.value, contains: r });
					}
				});
				break;
			}
			case 'oid': {
				if (typeof value !== 'string') {
					throwWithContext('Expected OID string value');
				}
				resolve({ type: 'oid', oid: value as string });
				break;
			}
			default:
				throwWithContext('Unsupported schema type');
		}
	};

	function encode(currentSchema: Schema, inputValue: unknown): ASN1AnyJS | undefined {
		const stack: Array<{
			type: 'encode' | 'choice';
			schema: Schema;
			value: unknown;
			resolve: (result: ASN1AnyJS | undefined) => void;
			choiceIndex?: number;
		}> = [];

		let finalResult: ASN1AnyJS | undefined;

		const initialResolve = (r: ASN1AnyJS | undefined) => {
			finalResult = r;
		};

		stack.push({ type: 'encode', schema: currentSchema, value: inputValue, resolve: initialResolve });

		while (stack.length > 0) {
			const task = stack.pop()!;
			const { type, schema, value, resolve, choiceIndex } = task;

			if (type === 'choice') {
				const choiceSchema = schema as { choice: Schema[] | readonly Schema[] };
				const option = choiceSchema.choice[choiceIndex!]!;
				stack.push({
					type: 'encode',
					schema: option,
					value,
					resolve: (r) => {
						if (r !== undefined) {
							resolve(r);
						} else {
							if (choiceIndex! + 1 < choiceSchema.choice.length) {
								stack.push({ type: 'choice', schema, value, resolve, choiceIndex: choiceIndex! + 1 });
							} else {
								throwWithContext(`Value ${valuePrinter(value)} does not match any schema choice`);
							}
						}
					}
				});
				continue;
			}

			if (typeof schema === 'function') {
				handleFunctionSchema(schema, value, resolve, stack);
				continue;
			}

			if (typeof schema === 'bigint') {
				handleBigIntSchema(schema, value, resolve);
				continue;
			}

			if (Array.isArray(schema)) {
				handleTuple(schema, value, resolve, stack, throwWithContext);
				continue;
			}

			if (typeof schema === 'symbol') {
				handlePrimitive(schema, value, resolve, throwWithContext);
				continue;
			}

			if (typeof schema === 'object' && schema !== null) {
				if ('optional' in schema) {
					handleOptional(schema as { optional: Schema }, value, resolve, stack);
					continue;
				}
				if ('choice' in schema) {
					handleChoice(schema as { choice: Schema[] | readonly Schema[] }, value, resolve, stack);
					continue;
				}
				if ('sequenceOf' in schema) {
					handleSequenceOf(schema as { sequenceOf: Schema }, value, resolve, stack, throwWithContext);
					continue;
				}
				if ('type' in schema) {
					handleTyped(schema as Extract<Schema, { type: string }>, value, resolve, stack, throwWithContext);
					continue;
				}
			}

			resolve(toASN1Primitive(value));
		}

		return finalResult;
	};	const encoded = encode(schema, value);
	if (encoded === undefined) {
		throwWithContext(`Unable to encode value ${valuePrinter(value)}`);
	}
	return(encoded);
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
		return(structResult);
	};

	const normalizeString = (candidate: { [key: string]: unknown; value?: unknown }): unknown => {
		return(typeof candidate.value === 'string' ? candidate.value : normalizeDecodedASN1(candidate.value));
	};

	const normalizeDate = (candidate: { [key: string]: unknown; date?: unknown }): unknown => {
		if (util.types.isDate(candidate.date)) {
			return(candidate.date);
		}
		return(candidate);
	};

	const normalizeOid = (candidate: { [key: string]: unknown; oid?: unknown }): unknown => {
		return(candidate.oid);
	};

	const normalizeBitstring = (candidate: { [key: string]: unknown; value?: unknown }): unknown => {
		return(candidate.value);
	};

	const normalizeFallback = (candidate: { [key: string]: unknown }): unknown => {
		const fallbackResult: { [key: string]: unknown } = {};
		for (const [key, val] of Object.entries(candidate)) {
			if (key === 'type' || key === 'fieldNames' || key === 'contains') {
				continue;
			}
			fallbackResult[key] = normalizeDecodedASN1(val);
		}
		return(Object.keys(fallbackResult).length > 0 ? fallbackResult : undefined);
	};

	if (input === undefined || input === null) {
		return(input);
	}
	if (util.types.isDate(input)) {
		return(input);
	}
	if (Buffer.isBuffer(input)) {
		return(input);
	}
	if (Array.isArray(input)) {
		return(input.map(item => normalizeDecodedASN1(item)));
	}
	if (isContextTagged(input)) {
		return(normalizeDecodedASN1(input.contains));
	}
	if (hasValueProp(input)) {
		return(normalizeDecodedASN1(input.value));
	}
	if (hasIndexSignature(input)) {
		const candidate = input as { [key: string]: unknown; type?: string; fieldNames?: readonly string[]; contains?: unknown };
		const normalizers: { [key: string]: (candidate: { [key: string]: unknown }) => unknown } = {
			struct: normalizeStruct,
			string: normalizeString,
			date: normalizeDate,
			oid: normalizeOid,
			bitstring: normalizeBitstring
		};
		const normalizer = normalizers[candidate.type ?? ''];
		if (normalizer) {
			return(normalizer(candidate));
		}
		const fallback = normalizeFallback(candidate);
		if (fallback !== undefined) {
			return(fallback);
		}
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
