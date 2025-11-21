import { test, expect } from 'vitest';
import { KeetaAnchorUserError, KeetaAnchorError, KeetaAnchorUserValidationError } from './error.js';
import typia, { createAssertEquals } from 'typia';

test('Basic Error Test', async function() {
	const keetaAnchorError = new KeetaAnchorError('test error');
	const keetaAnchorUserError = new KeetaAnchorUserError('test error');

	expect(KeetaAnchorUserError.isInstance(keetaAnchorUserError)).toBe(true);
	expect(KeetaAnchorError.isInstance(keetaAnchorUserError)).toBe(true);
	expect(KeetaAnchorError.isInstance(keetaAnchorError)).toBe(true);
	expect(KeetaAnchorUserError.isInstance(keetaAnchorError)).toBe(false);

	expect(keetaAnchorUserError.message).toBe('test error');
	expect(keetaAnchorUserError.name).toBe('KeetaAnchorUserError');
	expect(keetaAnchorError.message).toBe('test error');
	expect(keetaAnchorError.name).toBe('KeetaAnchorError');

	expect(keetaAnchorUserError.asErrorResponse('text/plain')).toEqual({ error: 'test error', statusCode: 400, contentType: 'text/plain' });
	expect(keetaAnchorError.asErrorResponse('text/plain')).toEqual({ error: 'Internal error', statusCode: 400, contentType: 'text/plain' });

	expect(keetaAnchorUserError.asErrorResponse('application/json')).toEqual({ error: JSON.stringify({ ok: false, retryable: false, error: 'test error', name: 'KeetaAnchorUserError' }), statusCode: 400, contentType: 'application/json' });
	expect(keetaAnchorError.asErrorResponse('application/json')).toEqual({ error: JSON.stringify({ ok: false, retryable: false, error: 'Internal error', name: 'KeetaAnchorError' }), statusCode: 400, contentType: 'application/json' });
});

test('Error Round-trip Serialization', async function() {
	// Test KeetaAnchorError round-trip
	const keetaAnchorError = new KeetaAnchorError('test error');
	const serialized = JSON.stringify(keetaAnchorError.toJSON());
	const parsed: unknown = JSON.parse(serialized);
	const deserialized = await KeetaAnchorError.fromJSON(parsed);

	expect(deserialized).toBeInstanceOf(KeetaAnchorError);
	/*
	 * When deserialized, the message should be 'Internal error' since
	 * KeetaAnchorError does not expose the original message to users.
	 */
	expect(deserialized.message).toBe('Internal error');
	expect(deserialized.name).toBe(keetaAnchorError.name);
	expect(KeetaAnchorError.isInstance(deserialized)).toBe(true);

	// Test KeetaAnchorUserError round-trip
	const keetaAnchorUserError = new KeetaAnchorUserError('user error');
	const userSerialized = JSON.stringify(keetaAnchorUserError.toJSON());
	const userParsed: unknown = JSON.parse(userSerialized);
	const userDeserialized = await KeetaAnchorError.fromJSON(userParsed);

	expect(userDeserialized).toBeInstanceOf(KeetaAnchorUserError);
	expect(userDeserialized.message).toBe(keetaAnchorUserError.message);
	expect(userDeserialized.name).toBe(keetaAnchorUserError.name);
	expect(KeetaAnchorUserError.isInstance(userDeserialized)).toBe(true);
	expect(KeetaAnchorError.isInstance(userDeserialized)).toBe(true);
}, 30_000);

test('Error fromJSON with invalid input', async function() {
	// Test that fromJSON throws on invalid input
	await expect(async () => await KeetaAnchorError.fromJSON({ ok: true })).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorError.fromJSON(null)).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorError.fromJSON('invalid')).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorError.fromJSON({ ok: false, message: 'Foo', name: 'UnknownError' })).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorUserError.fromJSON({ ok: true })).rejects.toThrow('Invalid error JSON object');
});

test('KeetaAnchorUserValidationError Test', async function() {
	interface AssertLike { key: string; message: { type: 'string'; value: string } };
	const validateValue = typia.createValidate<AssertLike>();
	const assertValue = createAssertEquals<AssertLike>();

	const tests: [ unknown, { path?: string; message: string; expected?: unknown; receivedValue?: unknown; } | null][] = [
		[
			{ key: 'test', message: { type: 'abc', value: 'hello' }},
			{ message: 'Invalid value', path: 'message.type', receivedValue: 'abc', expected: '"string"' }
		],
		[
			{ key: 123, message: { type: 'string', value: 'hello' }},
			{ message: 'Invalid value', expected: 'string', path: 'key', receivedValue: 123 }
		],
		[
			{ key: 'test', message: { type: 'string', value: 'hello' }},
			null
		],
		[
			'5',
			{ message: 'Invalid value', expected: 'AssertLike', receivedValue: '5' }
		]
	];

	for (const [ input, expectedError ] of tests) {
		try {
			assertValue(input);
			if (expectedError === null) {
				continue;
			}
		} catch (error) {
			if (expectedError === null) {
				throw(new Error(`Expected assertion to pass, but it failed with error: ${error}`));
			}

			if (!KeetaAnchorUserValidationError.isTypeGuardErrorLike(error)) {
				throw(new TypeError('Invalid TypeGuardErrorLike object'));
			}

			const keetaError = KeetaAnchorUserValidationError.fromTypeGuardError(error);
			const field = keetaError.fields[0];

			if (!field) {
				throw(new Error('Expected at least one field in KeetaAnchorUserValidationError'));
			}

			expect(field.path).toBe(expectedError.path);
			expect(field.message).toBe(expectedError.message);
			expect(field.expected).toBe(expectedError.expected);
			expect(field.receivedValue).toBe(expectedError.receivedValue);

			continue;
		}

		if (expectedError !== null) {
			throw(new Error('Expected assertion to do opposite of what happened'));
		}
	}

	for (const [ input, expectedError ] of tests) {
		const validate = validateValue(input);

		if (expectedError === null && validate.success) {
			continue;
		} else if (expectedError !== null && !validate.success) {
			const keetaError = KeetaAnchorUserValidationError.fromTypeGuardError(validate.errors);
			const field = keetaError.fields[0];

			if (!field) {
				throw(new Error('Expected at least one field in KeetaAnchorUserValidationError'));
			}

			expect(field.path).toBe(expectedError.path);
			expect(field.message).toBe(expectedError.message);
			expect(field.expected).toBe(expectedError.expected);
			expect(field.receivedValue).toBe(expectedError.receivedValue);
		} else {
			throw(new Error('Expected validation to do opposite of what happened'));
		}
	}
})
