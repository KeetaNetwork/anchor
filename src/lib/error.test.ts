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
