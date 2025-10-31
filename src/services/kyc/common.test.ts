import { test, expect } from 'vitest';
import { Errors } from './common.js';
import { deserializeError } from '../../lib/error-deserializer.js';
import * as KeetaNet from '@keetanetwork/keetanet-client';

test('KYC Error Serialization and Deserialization - VerificationNotFound', async function() {
	const error = new Errors.VerificationNotFound('Custom verification error');
	const serialized = error.toJSON();
	
	expect(serialized).toEqual({
		ok: false,
		retryable: false,
		error: 'Custom verification error',
		name: 'KeetaKYCAnchorVerificationNotFoundError',
		statusCode: 400
	});

	// Test deserialization
	const deserialized = deserializeError(serialized);
	expect(deserialized).toBeInstanceOf(Errors.VerificationNotFound);
	expect(deserialized.message).toBe('Custom verification error');
	expect(deserialized.name).toBe('KeetaKYCAnchorVerificationNotFoundError');
});

test('KYC Error Serialization and Deserialization - CertificateNotFound', async function() {
	const error = new Errors.CertificateNotFound('Custom certificate error');
	const serialized = error.toJSON();
	
	expect(serialized).toEqual({
		ok: false,
		retryable: false,
		error: 'Custom certificate error',
		name: 'KeetaKYCAnchorCertificateNotFoundError',
		statusCode: 404
	});

	// Test deserialization
	const deserialized = deserializeError(serialized);
	expect(deserialized).toBeInstanceOf(Errors.CertificateNotFound);
	expect(deserialized.message).toBe('Custom certificate error');
	expect(deserialized.name).toBe('KeetaKYCAnchorCertificateNotFoundError');
});

test('KYC Error Serialization and Deserialization - PaymentRequired', async function() {
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
	const serialized = error.toJSON();
	
	expect(serialized.ok).toBe(false);
	expect(serialized.retryable).toBe(false);
	expect(serialized.error).toBe('Custom payment message');
	expect(serialized.name).toBe('KeetaKYCAnchorCertificatePaymentRequired');
	expect(serialized.statusCode).toBe(402);
	expect(serialized.amount).toBe('0x3e8');
	expect(serialized.token).toBe(tokenAccount.publicKeyString.get());

	// Test deserialization
	const deserialized = deserializeError(serialized);
	expect(deserialized).toBeInstanceOf(Errors.PaymentRequired);
	expect(deserialized.message).toBe('Custom payment message');
	expect(deserialized.name).toBe('KeetaKYCAnchorCertificatePaymentRequired');
	
	// Check that the PaymentRequired-specific properties are restored
	if (deserialized instanceof Errors.PaymentRequired) {
		expect(deserialized.amount).toBe(1000n);
		expect(deserialized.token.publicKeyString.get()).toBe(tokenAccount.publicKeyString.get());
	}
});

test('KYC Error Round-trip Serialization', async function() {
	// Test VerificationNotFound
	const verificationError = new Errors.VerificationNotFound('Test verification');
	const verificationJson = JSON.stringify(verificationError.toJSON());
	const verificationParsed = JSON.parse(verificationJson);
	const verificationReconstructed = deserializeError(verificationParsed);
	
	expect(verificationReconstructed.message).toBe(verificationError.message);
	expect(verificationReconstructed.name).toBe(verificationError.name);
	expect(verificationReconstructed).toBeInstanceOf(Errors.VerificationNotFound);

	// Test CertificateNotFound
	const certificateError = new Errors.CertificateNotFound('Test certificate');
	const certificateJson = JSON.stringify(certificateError.toJSON());
	const certificateParsed = JSON.parse(certificateJson);
	const certificateReconstructed = deserializeError(certificateParsed);
	
	expect(certificateReconstructed.message).toBe(certificateError.message);
	expect(certificateReconstructed.name).toBe(certificateError.name);
	expect(certificateReconstructed).toBeInstanceOf(Errors.CertificateNotFound);

	// Test PaymentRequired
	const tokenAccount = KeetaNet.lib.Account.fromSeed(
		Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
		0,
		KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN
	);
	const paymentError = new Errors.PaymentRequired(
		{
			amount: 5000n,
			token: tokenAccount
		},
		'Test payment'
	);
	const paymentJson = JSON.stringify(paymentError.toJSON());
	const paymentParsed = JSON.parse(paymentJson);
	const paymentReconstructed = deserializeError(paymentParsed);
	
	expect(paymentReconstructed.message).toBe(paymentError.message);
	expect(paymentReconstructed.name).toBe(paymentError.name);
	expect(paymentReconstructed).toBeInstanceOf(Errors.PaymentRequired);
	
	if (paymentReconstructed instanceof Errors.PaymentRequired) {
		expect(paymentReconstructed.amount).toBe(5000n);
		expect(paymentReconstructed.token.publicKeyString.get()).toBe(tokenAccount.publicKeyString.get());
	}
});
