import { expect, test } from 'vitest';
import {
	KeetaAnchorHTTPRequestError,
	isRetryableHttpError
} from './common.js';
import { KeetaAnchorError, KeetaAnchorUserError } from '../error.js';

test('isRetryableHttpError classifies HTTP 429 as retryable', () => {
	const error = new KeetaAnchorHTTPRequestError(429, 'Too Many Requests');
	expect(isRetryableHttpError(error)).toBe(true);
});

test.each([
	[500],
	[502],
	[503],
	[504],
	[599]
])('isRetryableHttpError classifies HTTP %i as retryable', (status) => {
	const error = new KeetaAnchorHTTPRequestError(status, `HTTP ${status}`);
	expect(isRetryableHttpError(error)).toBe(true);
});

test.each([
	[400],
	[401],
	[403],
	[404],
	[409],
	[422]
])('isRetryableHttpError classifies HTTP %i as non-retryable', (status) => {
	const error = new KeetaAnchorHTTPRequestError(status, `HTTP ${status}`);
	expect(isRetryableHttpError(error)).toBe(false);
});

test('isRetryableHttpError classifies HTTP 200 as non-retryable', () => {
	const error = new KeetaAnchorHTTPRequestError(200, 'OK');
	expect(isRetryableHttpError(error)).toBe(false);
});

test('isRetryableHttpError classifies TypeError (fetch network failure) as retryable', () => {
	const error = new TypeError('fetch failed');
	expect(isRetryableHttpError(error)).toBe(true);
});

test.each([
	['AbortError'],
	['TimeoutError'],
	['NetworkError']
])('isRetryableHttpError classifies %s by name as retryable', (name) => {
	const error = new Error('failure');
	error.name = name;
	expect(isRetryableHttpError(error)).toBe(true);
});

test('isRetryableHttpError classifies plain Error as non-retryable', () => {
	const error = new Error('whoops');
	expect(isRetryableHttpError(error)).toBe(false);
});

test.each([
	[undefined],
	[null],
	['error'],
	[500]
])('isRetryableHttpError classifies non-Error value (%p) as non-retryable', (value) => {
	expect(isRetryableHttpError(value)).toBe(false);
});

test('isRetryableHttpError respects KeetaAnchorError.retryable flag', () => {
	const userError = new KeetaAnchorUserError('user error');
	expect(isRetryableHttpError(userError)).toBe(false);
	expect(KeetaAnchorError.isInstance(userError)).toBe(true);
});

test('KeetaAnchorHTTPRequestError preserves cause and httpStatus', () => {
	const cause = new Error('inner');
	const error = new KeetaAnchorHTTPRequestError(503, 'Service Unavailable', cause);
	expect(error.httpStatus).toBe(503);
	expect(error.cause).toBe(cause);
	expect(error.message).toBe('Service Unavailable');
	expect(KeetaAnchorHTTPRequestError.isInstance(error)).toBe(true);
});

test('KeetaAnchorHTTPRequestError participates in KeetaAnchorError hierarchy', () => {
	const error = new KeetaAnchorHTTPRequestError(503, 'Service Unavailable');
	expect(KeetaAnchorError.isInstance(error)).toBe(true);
	expect(error.retryable).toBe(true);
});

test('KeetaAnchorHTTPRequestError marks 4xx (non-429) as non-retryable on the inherited flag', () => {
	const error = new KeetaAnchorHTTPRequestError(404, 'Not Found');
	expect(error.retryable).toBe(false);
});

test('KeetaAnchorHTTPRequestError isInstance returns false for unrelated errors', () => {
	expect(KeetaAnchorHTTPRequestError.isInstance(new Error('plain'))).toBe(false);
	expect(KeetaAnchorHTTPRequestError.isInstance(null)).toBe(false);
	expect(KeetaAnchorHTTPRequestError.isInstance({})).toBe(false);
});
