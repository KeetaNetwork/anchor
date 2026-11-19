import { expect, test } from 'vitest';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { MemoryReplayGuard } from './replay-guard.js';
import { KeetaAnchorUserError } from '../error.js';
import { publicRequestURL, signRequest, verifyRequestSignature, verifySignedRequest } from './request-signing.js';
import { SignData, VerifySignedData } from '../utils/signing.js';

const account = KeetaNetLib.Account.fromSeed(KeetaNetLib.Account.generateRandomSeed(), 0);

test('a request signature covers the anchor, method, path, query and body', async function() {
	const url = new URL('https://anchor-a.example.com/api/op?b=2&a=1');
	const body = { amount: '10' };
	const signed = await signRequest(account, { method: 'POST', url, body }, [ 'data' ]);

	const variants = [
		{ method: 'POST', url: new URL('https://anchor-b.example.com/api/op?b=2&a=1'), body },
		{ method: 'GET', url, body },
		{ method: 'POST', url: new URL('https://anchor-a.example.com/api/other?b=2&a=1'), body },
		{ method: 'POST', url: new URL('https://anchor-a.example.com/api/op?b=3&a=1'), body },
		{ method: 'POST', url, body: { amount: '11' }}
	];
	for (const variant of variants) {
		expect(await verifySignedRequest(account, { ...variant, replayGuard: new MemoryReplayGuard() }, [ 'data' ], signed)).toBe(false);
	}

	expect(await verifySignedRequest(account, { method: 'POST', url, body, replayGuard: new MemoryReplayGuard() }, [ 'other' ], signed)).toBe(false);

	/* Query order, the signature parameters, and the body's own signed field do not change what is signed */
	const reordered = new URL('https://anchor-a.example.com/api/op?a=1&b=2&account=x&signed.nonce=y');
	const guard = new MemoryReplayGuard();
	expect(await verifySignedRequest(account, { method: 'post', url: reordered, body: { ...body, signed }, replayGuard: guard }, [ 'data' ], signed)).toBe(true);

	/* A second use is refused with its own error, not as a bad signature */
	await expect(verifySignedRequest(account, { method: 'POST', url, body, replayGuard: guard }, [ 'data' ], signed)).rejects.toSatisfy(KeetaAnchorUserError.isInstance.bind(KeetaAnchorUserError));
});

test('a server verifies requests against its configured URL, never the Host header', function() {
	const seen = new URL('http://attacker.example.com:8080/api/op?x=1');
	expect(publicRequestURL('https://anchor-a.example.com/', seen).toString()).toBe('https://anchor-a.example.com/api/op?x=1');
});

test('a request signature verifies at an anchor from before request binding, and binds the request at an upgraded one', async function() {
	const url = new URL('https://anchor-a.example.com/api/op');
	const body = { amount: '10' };
	const signed = await signRequest(account, { method: 'POST', url, body }, [ 'data' ]);

	/* What an anchor before request binding checks: the data alone */
	expect(await VerifySignedData(account, [ 'data' ], signed)).toBe(true);

	/* An upgraded anchor checks the request, even while it accepts legacy signatures */
	expect(await verifyRequestSignature(account, { method: 'POST', url, body }, [ 'data' ], signed)).toBe(true);
	expect(await verifyRequestSignature(account, { method: 'POST', url: new URL('https://anchor-b.example.com/api/op'), body }, [ 'data' ], signed)).toBe(false);
	expect(await verifyRequestSignature(account, { method: 'POST', url, body: { amount: '11' }}, [ 'data' ], signed)).toBe(false);
});

test('neither part of a request signature can be dropped or changed', async function() {
	const target = { method: 'POST', url: new URL('https://anchor-a.example.com/api/op'), body: { amount: '10' }};
	const signed = await signRequest(account, target, [ 'data' ]);
	const [ requestNonce, requestSignature ] = signed.nonce.split('~v2~');
	if (requestNonce === undefined || requestSignature === undefined) {
		throw(new Error('Expected a dual signature'));
	}

	/* Dropping the v2 part leaves a legacy signature over another nonce */
	expect(await verifyRequestSignature(account, target, [ 'data' ], { ...signed, nonce: requestNonce })).toBe(false);

	/* A changed v2 part, or a changed legacy part, fails */
	const otherSigned = await signRequest(account, target, [ 'data' ]);
	expect(await verifyRequestSignature(account, target, [ 'data' ], { ...signed, nonce: `${requestNonce}~v2~${otherSigned.signature}` })).toBe(false);
	expect(await verifyRequestSignature(account, target, [ 'data' ], { ...signed, signature: otherSigned.signature })).toBe(false);

	/* The v2 part alone, as a v0.0.113 client sends it, verifies and spends the same nonce */
	const requestOnly = { nonce: requestNonce, timestamp: signed.timestamp, signature: requestSignature };
	const guard = new MemoryReplayGuard();
	expect(await verifySignedRequest(account, { ...target, replayGuard: guard }, [ 'data' ], requestOnly)).toBe(true);
	await expect(verifySignedRequest(account, { ...target, replayGuard: guard }, [ 'data' ], signed)).rejects.toSatisfy(KeetaAnchorUserError.isInstance.bind(KeetaAnchorUserError));
});

test('an upgraded anchor accepts a legacy signature unless it is told not to', async function() {
	const target = { method: 'POST', url: new URL('https://anchor-a.example.com/api/op'), body: { amount: '10' }};
	const legacy = await SignData(account, [ 'data' ]);

	expect(await verifyRequestSignature(account, target, [ 'data' ], legacy)).toBe(true);
	expect(await verifyRequestSignature(account, { ...target, acceptLegacySignatures: false }, [ 'data' ], legacy)).toBe(false);
	expect(await verifyRequestSignature(account, target, [ 'other' ], legacy)).toBe(false);

	/* A legacy signature is still accepted only once */
	const guard = new MemoryReplayGuard();
	expect(await verifySignedRequest(account, { ...target, replayGuard: guard }, [ 'data' ], legacy)).toBe(true);
	await expect(verifySignedRequest(account, { ...target, replayGuard: guard }, [ 'data' ], legacy)).rejects.toSatisfy(KeetaAnchorUserError.isInstance.bind(KeetaAnchorUserError));
});
