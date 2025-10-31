import { test, expect } from 'vitest';
import { KeetaAnchorUserError, KeetaAnchorError } from './error.js';

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

	expect(keetaAnchorUserError.asErrorResponse('application/json')).toEqual({ error: JSON.stringify({ ok: false, retryable: false, error: 'test error' }), statusCode: 400, contentType: 'application/json' });
	expect(keetaAnchorError.asErrorResponse('application/json')).toEqual({ error: JSON.stringify({ ok: false, retryable: false, error: 'Internal error' }), statusCode: 400, contentType: 'application/json' });
});

test('Error Serialization and Deserialization', async function() {
	// Test KeetaAnchorError serialization
	const keetaAnchorError = new KeetaAnchorError('test error');
	const serialized = keetaAnchorError.toJSON();
	
	expect(serialized).toEqual({
		ok: false,
		retryable: false,
		error: 'test error',
		name: 'KeetaAnchorError',
		statusCode: 400
	});

	// Test KeetaAnchorError deserialization
	const deserialized = KeetaAnchorError.fromJSON(serialized);
	expect(deserialized).toBeInstanceOf(KeetaAnchorError);
	expect(deserialized.message).toBe('test error');
	expect(deserialized.name).toBe('KeetaAnchorError');
	expect(KeetaAnchorError.isInstance(deserialized)).toBe(true);

	// Test KeetaAnchorUserError serialization
	const keetaAnchorUserError = new KeetaAnchorUserError('user error');
	const userSerialized = keetaAnchorUserError.toJSON();
	
	expect(userSerialized).toEqual({
		ok: false,
		retryable: false,
		error: 'user error',
		name: 'KeetaAnchorUserError',
		statusCode: 400
	});

	// Test KeetaAnchorUserError deserialization
	const userDeserialized = KeetaAnchorError.fromJSON(userSerialized);
	expect(userDeserialized).toBeInstanceOf(KeetaAnchorUserError);
	expect(userDeserialized.message).toBe('user error');
	expect(userDeserialized.name).toBe('KeetaAnchorUserError');
	expect(KeetaAnchorUserError.isInstance(userDeserialized)).toBe(true);
	expect(KeetaAnchorError.isInstance(userDeserialized)).toBe(true);
});

test('Error Round-trip Serialization', async function() {
	// Test that errors maintain their properties through JSON round-trip
	const originalError = new KeetaAnchorUserError('round trip test');
	const json = JSON.stringify(originalError.toJSON());
	const parsed = JSON.parse(json);
	const reconstructed = KeetaAnchorError.fromJSON(parsed);

	expect(reconstructed.message).toBe(originalError.message);
	expect(reconstructed.name).toBe(originalError.name);
	expect(KeetaAnchorUserError.isInstance(reconstructed)).toBe(true);
});

test('Error fromJSON with invalid input', async function() {
	// Test that fromJSON throws on invalid input
	expect(() => KeetaAnchorError.fromJSON({ ok: true })).toThrow('Invalid KeetaAnchorError JSON object');
	expect(() => KeetaAnchorError.fromJSON(null)).toThrow('Invalid KeetaAnchorError JSON object');
	expect(() => KeetaAnchorError.fromJSON('invalid')).toThrow('Invalid KeetaAnchorError JSON object');
	expect(() => KeetaAnchorUserError.fromJSON({ ok: true })).toThrow('Invalid KeetaAnchorUserError JSON object');
});

test('Error Deserialization using deserializeError', async function() {
	// Import the deserializeError function
	const { deserializeError } = await import('./error-deserializer.js');

	// Test deserializing a KeetaAnchorError
	const errorSerialized = new KeetaAnchorError('test error').toJSON();
	const errorDeserialized = deserializeError(errorSerialized);
	expect(errorDeserialized).toBeInstanceOf(KeetaAnchorError);
	expect(errorDeserialized.message).toBe('test error');

	// Test deserializing a KeetaAnchorUserError
	const userErrorSerialized = new KeetaAnchorUserError('user error').toJSON();
	const userErrorDeserialized = deserializeError(userErrorSerialized);
	expect(userErrorDeserialized).toBeInstanceOf(KeetaAnchorUserError);
	expect(userErrorDeserialized.message).toBe('user error');

	// Test invalid input
	expect(() => deserializeError({ ok: true })).toThrow('Invalid error JSON object');
	expect(() => deserializeError(null)).toThrow('Invalid error JSON object');
	expect(() => deserializeError('invalid')).toThrow('Invalid error JSON object');
});
