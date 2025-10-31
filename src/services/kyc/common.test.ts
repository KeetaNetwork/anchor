import { test, expect } from 'vitest';
import { Errors } from './common.js';
import { deserializeError } from '../../lib/error/common.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

test('KYC Error Round-trip Serialization - VerificationNotFound', async function() {
	const error = new Errors.VerificationNotFound('Custom verification error');
	const json = JSON.stringify(error.toJSON());
	const parsed = JSON.parse(json);
	const deserialized = await deserializeError(parsed);
	
	expect(deserialized).toBeInstanceOf(Errors.VerificationNotFound);
	expect(deserialized.message).toBe(error.message);
	expect(deserialized.name).toBe(error.name);
});

test('KYC Error Round-trip Serialization - CertificateNotFound', async function() {
	const error = new Errors.CertificateNotFound('Custom certificate error');
	const json = JSON.stringify(error.toJSON());
	const parsed = JSON.parse(json);
	const deserialized = await deserializeError(parsed);
	
	expect(deserialized).toBeInstanceOf(Errors.CertificateNotFound);
	expect(deserialized.message).toBe(error.message);
	expect(deserialized.name).toBe(error.name);
});

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
	const parsed = JSON.parse(json);
	const deserialized = await deserializeError(parsed);
	
	expect(deserialized).toBeInstanceOf(Errors.PaymentRequired);
	expect(deserialized.message).toBe(error.message);
	expect(deserialized.name).toBe(error.name);
	
	// Check that the PaymentRequired-specific properties are restored
	if (deserialized instanceof Errors.PaymentRequired) {
		expect(deserialized.amount).toBe(error.amount);
		expect(deserialized.token.publicKeyString.get()).toBe(error.token.publicKeyString.get());
	}
});


