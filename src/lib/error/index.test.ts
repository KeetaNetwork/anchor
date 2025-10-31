import { test, expect } from 'vitest';
import { KeetaAnchorUserError, KeetaAnchorError } from './index.js';

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

test('Error Round-trip Serialization', async function() {
	// Test KeetaAnchorError round-trip
	const keetaAnchorError = new KeetaAnchorError('test error');
	const serialized = JSON.stringify(keetaAnchorError.toJSON());
	const parsed = JSON.parse(serialized);
	const deserialized = await KeetaAnchorError.fromJSON(parsed);
	
	expect(deserialized).toBeInstanceOf(KeetaAnchorError);
	expect(deserialized.message).toBe(keetaAnchorError.message);
	expect(deserialized.name).toBe(keetaAnchorError.name);
	expect(KeetaAnchorError.isInstance(deserialized)).toBe(true);

	// Test KeetaAnchorUserError round-trip
	const keetaAnchorUserError = new KeetaAnchorUserError('user error');
	const userSerialized = JSON.stringify(keetaAnchorUserError.toJSON());
	const userParsed = JSON.parse(userSerialized);
	const userDeserialized = await KeetaAnchorError.fromJSON(userParsed);
	
	expect(userDeserialized).toBeInstanceOf(KeetaAnchorUserError);
	expect(userDeserialized.message).toBe(keetaAnchorUserError.message);
	expect(userDeserialized.name).toBe(keetaAnchorUserError.name);
	expect(KeetaAnchorUserError.isInstance(userDeserialized)).toBe(true);
	expect(KeetaAnchorError.isInstance(userDeserialized)).toBe(true);
});

test('Error fromJSON with invalid input', async function() {
	// Test that fromJSON throws on invalid input
	await expect(async () => await KeetaAnchorError.fromJSON({ ok: true })).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorError.fromJSON(null)).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorError.fromJSON('invalid')).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await KeetaAnchorUserError.fromJSON({ ok: true })).rejects.toThrow('Invalid error JSON object');
});

test('Error Deserialization using deserializeError', async function() {
	// Import the deserializeError function
	const { deserializeError } = await import('./common.js');

	// Test deserializing and round-tripping a KeetaAnchorError
	const error = new KeetaAnchorError('test error');
	const json = JSON.stringify(error.toJSON());
	const parsed = JSON.parse(json);
	const errorDeserialized = await deserializeError(parsed);
	
	expect(errorDeserialized).toBeInstanceOf(KeetaAnchorError);
	expect(errorDeserialized.message).toBe(error.message);
	expect(errorDeserialized.name).toBe(error.name);

	// Test deserializing and round-tripping a KeetaAnchorUserError
	const userError = new KeetaAnchorUserError('user error');
	const userJson = JSON.stringify(userError.toJSON());
	const userParsed = JSON.parse(userJson);
	const userErrorDeserialized = await deserializeError(userParsed);
	
	expect(userErrorDeserialized).toBeInstanceOf(KeetaAnchorUserError);
	expect(userErrorDeserialized.message).toBe(userError.message);
	expect(userErrorDeserialized.name).toBe(userError.name);

	// Test invalid input
	await expect(async () => await deserializeError({ ok: true })).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await deserializeError(null)).rejects.toThrow('Invalid error JSON object');
	await expect(async () => await deserializeError('invalid')).rejects.toThrow('Invalid error JSON object');
});
