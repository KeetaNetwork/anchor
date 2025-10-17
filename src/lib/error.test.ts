import { test, expect } from 'vitest';
import { KeetaAnchorUserError } from './error.js';

test('Basic Error Test', async function() {
	const keetaAnchorUserError = new KeetaAnchorUserError('test error');

	expect(KeetaAnchorUserError.isInstance(keetaAnchorUserError)).toBe(true);

	expect(keetaAnchorUserError.message).toBe('test error');

	expect(keetaAnchorUserError.asErrorResponse('text/plain')).toEqual({ error: 'test error', statusCode: 400, contentType: 'text/plain' });

	expect(keetaAnchorUserError.asErrorResponse('application/json')).toEqual({ error: JSON.stringify({ ok: false, error: 'test error' }), statusCode: 400, contentType: 'application/json' });
});
