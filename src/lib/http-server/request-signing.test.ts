import { expect, test } from 'vitest';
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { MemoryReplayGuard } from './replay-guard.js';
import { KeetaAnchorUserError } from '../error.js';
import { publicRequestURL, signRequest, verifySignedRequest } from './request-signing.js';

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
