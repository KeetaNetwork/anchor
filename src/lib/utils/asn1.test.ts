import { test, expect } from 'vitest';
import { BufferStorageASN1, ValidateASN1, normalizeDecodedASN1, JStoASN1 } from './asn1.js';

test('Struct with optional fields - full encode/decode pipeline', function() {
	const schema = {
		type: 'struct',
		fieldNames: ['optionalBefore', 'required', 'optionalAfter'],
		contains: {
			optionalBefore: { optional: { type: 'context', kind: 'explicit', value: 0, contains: { type: 'string', kind: 'utf8' }}},
			required: { type: 'context', kind: 'explicit', value: 1, contains: ValidateASN1.IsInteger },
			optionalAfter: { optional: { type: 'context', kind: 'explicit', value: 2, contains: { type: 'string', kind: 'utf8' }}}
		}
	} as const;

	const validator = new ValidateASN1(schema);

	// Test 1: All fields present
	const allFields = {
		optionalBefore: 'before',
		required: 42n,
		optionalAfter: 'after'
	};

	// XXX:TODO Fix depth issue
	// @ts-ignore
	const encodedJS1 = validator.fromJavaScriptObject(allFields);
	const der1 = JStoASN1(encodedJS1).toBER(false);
	const decoded1 = new BufferStorageASN1(der1, schema).getASN1();
	const result1 = normalizeDecodedASN1(validator.toJavaScriptObject(decoded1), []);
	expect(result1).toEqual(allFields);

	// Test 2: Only required field (both optionals omitted)
	const onlyRequired = {
		required: 100n
	};

	// XXX:TODO Fix depth issue
	// @ts-ignore
	const encodedJS2 = validator.fromJavaScriptObject(onlyRequired);
	const der2 = JStoASN1(encodedJS2).toBER(false);
	const decoded2 = new BufferStorageASN1(der2, schema).getASN1();
	const result2 = normalizeDecodedASN1(validator.toJavaScriptObject(decoded2), []);
	expect(result2).toEqual(onlyRequired);
	expect(Object.keys(result2 ?? {})).toEqual(['required']);
});

