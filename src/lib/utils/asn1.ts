import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type * as ASN1Types from '@keetanetwork/keetanet-client/lib/utils/asn1.ts';
import util from 'util';
/*
 * We import this file to make sure that the `asn1js` types are
 * defined, since they are required by the `ASN1toJS` and `JStoASN1`
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as _ignored_asn1js from 'asn1js';

import { assert } from "typia";

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

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isStructSchema = (candidate: unknown): candidate is StructSchema => {
	if (!hasIndexSignature(candidate)) {
		return(false);
	}
	if (candidate.type !== 'struct') {
		return(false);
	}
	const fieldNamesCandidate = candidate.fieldNames;
	if (!isArray(fieldNamesCandidate)) {
		return(false);
	}
	for (const fieldName of fieldNamesCandidate) {
		if (typeof fieldName !== 'string') {
			return(false);
		}
	}
	const containsCandidate = candidate.contains;
	return(hasIndexSignature(containsCandidate));
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
		const stack: { arr: unknown[], index: number, resolve: (result: unknown) => void }[] = [];
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
			const task = stack.pop();
			if (!task) {
				throw(new Error('Stack should not be empty'));
			}
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
		return(assert<ASN1AnyJS>(result));
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
	if (!isStructSchema(schema)) {
		return(schema);
	}
	const cached = structSchemaCache.get(schema);
	if (cached) {
		return(cached);
	}
	const structSchema = schema;
	const fieldNames = Array.from(structSchema.fieldNames);
	const structContainsSchema = structSchema.contains;
	const contains: { [key: string]: Schema | { optional: Schema }} = {};

	const wrapSchemaWithContext = (index: number, fieldSchema: Schema): Schema => {
		if (typeof fieldSchema === 'object' && fieldSchema !== null && 'type' in fieldSchema && fieldSchema.type === 'context') {
			return(fieldSchema);
		}
		return({ type: 'context', kind: 'explicit', value: index, contains: fieldSchema });
	};

	fieldNames.forEach(function(fieldName, index) {
		const fieldSchema = structContainsSchema[fieldName];
		if (!fieldSchema) {
			return;
		}
		if (isOptionalSchema(fieldSchema)) {
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
	structSchemaCache.set(structSchema, contextualized);
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

	const handleFunctionSchema = (schema: () => Schema, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[]) => {
		stack.push({ type: 'encode', schema: schema(), value, resolve });
	};

	const handleBigIntSchema = (schema: bigint, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void) => {
		resolve(encodeBigInt(schema, value));
	};

	const handleTuple = (schema: Schema[], value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[], throwWithContext: (message: string) => never) => {
		if (!isArray(value)) {
			throwWithContext('Expected tuple value');
		}
		const tupleValue = value;
		if (schema.length !== tupleValue.length) {
			throwWithContext('Tuple length mismatch');
		}
		const results: ASN1AnyJS[] = [];
		let completed = 0;
		for (let i = 0; i < schema.length; i++) {
			stack.push({
				type: 'encode',
				schema: assert<Schema>(schema[i]),
				value: tupleValue[i],
				resolve: (r) => {
					results[i] = r;
					if (++completed === schema.length) {
						resolve(results);
					}
				}
			});
		}
	};

	const handlePrimitive = (schema: symbol, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, throwWithContext: (message: string) => never) => {
		const primitiveHandlers: { [key: symbol]: (value: unknown) => ASN1AnyJS } = {
			[ValidateASN1.IsAny]: (value) => assert<ASN1AnyJS>(value),
			[ValidateASN1.IsUnknown]: (value) => assert<ASN1AnyJS>(value),
			[ValidateASN1.IsDate]: (value) => assert<Date>(ensureDate(value)),
			[ValidateASN1.IsAnyDate]: (value) => assert<ASN1Types.ASN1Date>(value),
			[ValidateASN1.IsString]: (value) => assert<string>(value),
			[ValidateASN1.IsAnyString]: (value) => assert<ASN1Types.ASN1String>(value),
			[ValidateASN1.IsOctetString]: (value) => assert<Buffer>(value),
			[ValidateASN1.IsBitString]: (value) => assert<ASN1Types.ASN1BitString>(value),
			[ValidateASN1.IsInteger]: (value) => {
				if (typeof value === 'number') {
					return(assert<bigint>(BigInt(value)));
				}
				if (typeof value === 'bigint') {
					return(assert<bigint>(value));
				}
				throwWithContext('Expected integer value');
			},
			[ValidateASN1.IsBoolean]: (value) => assert<boolean>(value),
			[ValidateASN1.IsOID]: (value) => assert<ASN1Types.ASN1OID>(value),
			[ValidateASN1.IsSet]: (value) => assert<ASN1Types.ASN1Set>(value),
			[ValidateASN1.IsNull]: (value) => assert<null>(value)
		};
		const handler = primitiveHandlers[schema];
		if (handler) {
			resolve(handler(value));
		} else {
			throwWithContext(`Unsupported primitive schema`);
		}
	};

	const handleOptional = (schema: { optional: Schema }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[]) => {
		if (value === undefined || value === null) {
			resolve(undefined);
		} else {
			stack.push({ type: 'encode', schema: schema.optional, value, resolve });
		}
	};

	const handleChoice = (schema: { choice: Schema[] | readonly Schema[] }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[]) => {
		stack.push({ type: 'choice', schema, value, resolve, choiceIndex: 0 });
	};

	const handleSequenceOf = (schema: { sequenceOf: Schema }, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[], throwWithContext: (message: string) => never) => {
		if (!isArray(value)) {
			throwWithContext('Expected array value');
		}
		const sequenceValue = value;
		const results: ASN1AnyJS[] = [];
		let completed = 0;
		for (let i = 0; i < sequenceValue.length; i++) {
			stack.push({
				type: 'encode',
				schema: schema.sequenceOf,
				value: sequenceValue[i],
				resolve: (r) => {
					results[i] = r;
					if (++completed === sequenceValue.length) {
						resolve(results);
					}
				}
			});
		}
	};

	const handleTyped = (schema: Extract<Schema, { type: string }>, value: unknown, resolve: (r: ASN1AnyJS | undefined) => void, stack: { type: 'encode' | 'choice'; schema: Schema; value: unknown; resolve: (result: ASN1AnyJS | undefined) => void; choiceIndex?: number }[], throwWithContext: (message: string) => never) => {
		const s = schema;
		switch (s.type) {
			case 'struct': {
				if (!hasIndexSignature(value) || Array.isArray(value)) {
					throwWithContext('Expected object value for struct');
				}
				if (!isStructSchema(s)) {
					throwWithContext('Invalid struct schema');
				}
				const structSchema = s;
				const structFieldOrder = Array.from(structSchema.fieldNames);
				const structContainsSchema = structSchema.contains;
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
					const fieldSchema = structContainsSchema[fieldName];
					if (!fieldSchema) {
						structCollect();
						continue;
					}
					const obj = assert<{ [key: string]: unknown }>(value);
					const fieldValue = obj[fieldName];
					if (fieldValue === undefined || fieldValue === null) {
						if (isOptionalSchema(fieldSchema)) {
							structCollect();
							continue;
						}
						throwWithContext(`Missing required field '${fieldName}'`);
					}
					stack.push({
						type: 'encode',
						schema: isOptionalSchema(fieldSchema) ? fieldSchema.optional : fieldSchema,
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
				const ss = assert<{ type: 'string'; kind: 'printable' | 'ia5' | 'utf8' }>(s);
				if (typeof value !== 'string') {
					throwWithContext('Expected string value');
				}
				resolve({ type: 'string', kind: ss.kind, value: assert<string>(value) });
				break;
			}
			case 'date': {
				const ds = assert<{ type: 'date'; kind: 'default' | 'utc' | 'general' }>(s);
				const dateValue = ensureDate(value);
				resolve({ type: 'date', kind: ds.kind, date: assert<Date>(dateValue) });
				break;
			}
			case 'context': {
				const cs = assert<{ type: 'context'; kind: 'implicit' | 'explicit'; contains: Schema; value: number }>(s);
				stack.push({
					type: 'encode',
					schema: cs.contains,
					value,
					resolve: (r) => {
						if (r === undefined) {
							throwWithContext('Context value missing');
						}
						resolve({ type: 'context', kind: cs.kind, value: cs.value, contains: assert<ASN1AnyJS>(r) });
					}
				});
				break;
			}
			case 'oid': {
				if (typeof value !== 'string') {
					throwWithContext('Expected OID string value');
				}
				resolve({ type: 'oid', oid: assert<string>(value) });
				break;
			}
			default:
				throwWithContext('Unsupported schema type');
		}
	};

	function encode(currentSchema: Schema, inputValue: unknown): ASN1AnyJS | undefined {
		const stack: {
			type: 'encode' | 'choice';
			schema: Schema;
			value: unknown;
			resolve: (result: ASN1AnyJS | undefined) => void;
			choiceIndex?: number;
		}[] = [];

		let finalResult: ASN1AnyJS | undefined;

		const initialResolve = (r: ASN1AnyJS | undefined) => {
			finalResult = r;
		};

		stack.push({ type: 'encode', schema: currentSchema, value: inputValue, resolve: initialResolve });

		while (stack.length > 0) {
			const task = stack.pop();
			if (!task) {
				throw(new Error('Unexpected empty stack'));
			}
			const { type, schema, value, resolve, choiceIndex } = task;

			if (type === 'choice') {
				const choiceSchema = assert<{ choice: Schema[] | readonly Schema[] }>(schema);
				const choiceIndexNum = assert<number>(choiceIndex);
				const option = assert<Schema>(choiceSchema.choice[choiceIndexNum]);
				stack.push({
					type: 'encode',
					schema: option,
					value,
					resolve: (r) => {
						if (r !== undefined) {
							resolve(r);
						} else {
							if (choiceIndexNum + 1 < choiceSchema.choice.length) {
								stack.push({ type: 'choice', schema, value, resolve, choiceIndex: choiceIndexNum + 1 });
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
					handleOptional(schema, value, resolve, stack);
					continue;
				}
				if ('choice' in schema) {
					handleChoice(schema, value, resolve, stack);
					continue;
				}
				if ('sequenceOf' in schema) {
					handleSequenceOf(schema, value, resolve, stack, throwWithContext);
					continue;
				}
				if ('type' in schema) {
					handleTyped(schema, value, resolve, stack, throwWithContext);
					continue;
				}
			}

			resolve(toASN1Primitive(value));
		}

		return(finalResult);
	};	const encoded = encode(schema, value);
	if (encoded === undefined) {
		throwWithContext(`Unable to encode value ${valuePrinter(value)}`);
	}
	return(encoded);
}

export function normalizeDecodedASN1(input: unknown): unknown {
	const normalizeStruct = (candidate: { [key: string]: unknown; type?: string; fieldNames?: readonly string[]; contains?: unknown }): unknown => {
		const containsRaw = hasIndexSignature(candidate.contains) ? assert<{ [key: string]: unknown }>(candidate.contains) : {};
		const orderedNames = Array.isArray(candidate.fieldNames) ? Array.from(candidate.fieldNames) : Object.keys(containsRaw);
		const structResult: { [key: string]: unknown } = {};
		for (const fieldName of orderedNames) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			const fieldValue = containsRaw[fieldName];
			if (fieldValue === undefined) {
				continue;
			}
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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
		const candidate = assert<{ [key: string]: unknown; type?: string; fieldNames?: readonly string[]; contains?: unknown }>(input);
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
