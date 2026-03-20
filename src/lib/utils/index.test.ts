import { test, expect, describe } from 'vitest';
import { Array as ArrayUtils } from './index.js';

describe('Array: Utils', function() {
	test('Array: Utils', function() {
		const checks: { input: unknown, len?: number; result: boolean; }[] = [{
			input: [],
			result: true
		}, {
			input: [],
			len: 0,
			result: true
		}, {
			input: [],
			len: 1,
			result: false
		}, {
			input: [1],
			len: 1,
			result: true
		}, {
			input: null,
			result: false
		}];

		for (const check of checks) {
			expect(ArrayUtils.isArray(check.input, check.len)).toEqual(check.result);
		}
	});
});
