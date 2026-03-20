import { test, expect, describe } from 'vitest';
import { Errors } from './common.js';
import { assertVisibility } from './utils.js';

describe('assertVisibility', function() {
	const cases = [
		{ input: 'public', valid: true },
		{ input: 'private', valid: true },
		{ input: 'unlisted', valid: false },
		{ input: '', valid: false },
		{ input: null, valid: false },
		{ input: undefined, valid: false },
		{ input: 42, valid: false }
	];

	test.each(cases)('$input -> valid=$valid', function({ input, valid }) {
		if (valid) {
			expect(assertVisibility(input)).toBe(input);
		} else {
			expect(function() { assertVisibility(input); }).toThrow(Errors.InvalidMetadata);
		}
	});
});
