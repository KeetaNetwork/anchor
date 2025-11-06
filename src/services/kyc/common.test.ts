import { test, expect } from 'vitest';
import { Errors } from './common.js';
import { KeetaAnchorError, KeetaAnchorUserError } from '../../lib/error.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

for (const errorClass of [
	Errors.VerificationNotFound,
	Errors.CertificateNotFound
]) {
	test(`KYC Error Round-trip Serialization - ${errorClass.name}`, async function() {
		const error = new errorClass('Custom verification error');
		const json = JSON.stringify(error.toJSON());
		const parsed: unknown = JSON.parse(json);
		const deserialized1 = await KeetaAnchorError.fromJSON(parsed);
		const deserialized2 = await errorClass.fromJSON(parsed);

		expect(deserialized1).toBeInstanceOf(errorClass);
		expect(deserialized1.message).toBe(error.message);
		expect(deserialized1.name).toBe(error.name);
		expect(deserialized1.name).toBe(errorClass.name);

		expect(deserialized2).toBeInstanceOf(errorClass);
		expect(deserialized2.message).toBe(error.message);
		expect(deserialized2.name).toBe(error.name);
		expect(deserialized2.name).toBe(errorClass.name);

		expect(errorClass.isInstance(deserialized1)).toBe(true);
		expect(KeetaAnchorError.isInstance(deserialized1)).toBe(true);
		expect(KeetaAnchorUserError.isInstance(deserialized1)).toBe(true);
		expect(errorClass.isInstance(deserialized2)).toBe(true);
		expect(KeetaAnchorError.isInstance(deserialized2)).toBe(true);
		expect(KeetaAnchorUserError.isInstance(deserialized2)).toBe(true);
	});
}

test('KYC Error Round-trip Serialization - PaymentRequired', async function() {
	// Create a token account for testing
	const tokenAccount = KeetaNet.lib.Account.fromSeed(
		Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
		0,
		KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN
	);

	const error = new Errors.PaymentRequired(
		{
			amount: 1000n,
			token: tokenAccount
		},
		'Custom payment message'
	);

	const json = JSON.stringify(error.toJSON());
	const parsed: unknown = JSON.parse(json);
	const deserialized = await Errors.PaymentRequired.fromJSON(parsed);

	expect(deserialized).toBeInstanceOf(Errors.PaymentRequired);
	expect(deserialized.message).toBe(error.message);
	expect(deserialized.name).toBe(error.name);
	expect(Errors.PaymentRequired.isInstance(deserialized)).toBe(true);
	expect(Errors.CertificateNotFound.isInstance(deserialized)).toBe(false);
	expect(Errors.VerificationNotFound.isInstance(deserialized)).toBe(false);
	expect(KeetaAnchorError.isInstance(deserialized)).toBe(true);
	expect(KeetaAnchorUserError.isInstance(deserialized)).toBe(true);

	// Check that the PaymentRequired-specific properties are restored
	if (deserialized instanceof Errors.PaymentRequired) {
		expect(deserialized.amount).toBe(error.amount);
		expect(deserialized.token.publicKeyString.get()).toBe(error.token.publicKeyString.get());
	}
});
