import { describe, expect, test } from 'vitest';
import {
	Errors,
	formatGloballyIdentifiableUsername,
	parseGloballyIdentifiableUsername
} from './common.js';

describe('username common helpers', () => {
	test('format and parse round trip', () => {
		const username = 'alice';
		const providerID = 'provider-123';
		const formatted = formatGloballyIdentifiableUsername(username, providerID);

		const parsed = parseGloballyIdentifiableUsername(formatted);

		expect(parsed.username).toBe(username);
		expect(parsed.providerID).toBe(providerID);
	});

	test('parse rejects missing separator', () => {
		expect(() => {
			// @ts-expect-error Testing runtime validation of input
			parseGloballyIdentifiableUsername('invalid-username');
		}).toThrow(/separator/);
	});

	test('parse rejects empty segments', () => {
		expect(() => {
			parseGloballyIdentifiableUsername('$provider');
		}).toThrow(/must not be empty/);

		expect(() => {
			parseGloballyIdentifiableUsername('username$');
		}).toThrow(/must not be empty/);
	});

	test('parse rejects additional separators', () => {
		expect(() => {
			parseGloballyIdentifiableUsername('user$extra$provider');
		}).toThrow(/must not contain/);
	});

	test('username already taken error preserves custom message', async () => {
		const takenUsername = 'bob$provider';
		const error = new Errors.UsernameAlreadyTaken({ username: takenUsername }, 'Try a different username');
		const json = error.toJSON();
		const restored = await Errors.UsernameAlreadyTaken.fromJSON(json);

		expect(json.error).toBe('Try a different username');
		expect(restored).toBeInstanceOf(Errors.UsernameAlreadyTaken);
		expect(restored.message).toBe('Try a different username');
		expect(Errors.UsernameAlreadyTaken.isInstance(restored)).toBe(true);
		expect(restored.username).toBe(takenUsername);
	});
});
