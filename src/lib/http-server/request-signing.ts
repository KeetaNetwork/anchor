import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import type { Signable, SignableAccount, VerifiableAccount } from '../utils/signing.js';
import type { HTTPSignedField } from './common.js';
import type { KeetaAnchorReplayGuard } from './replay-guard.js';
import { Buffer } from '../utils/buffer.js';
import { DEFAULT_MAX_SKEW_MS, SignData, VerifySignedData, canonicalizeJson } from '../utils/signing.js';

/**
 * Version tag of the request signable layout. A signature made for
 * another layout never verifies.
 */
const REQUEST_SIGNABLE_TAG = 'keeta-anchor-request-v1';

/**
 * The request a signature is made for: the operation URL as the client
 * calls it, and the body. A JSON body is given as the value passed to
 * `JSON.stringify` (its `signed` field is ignored), and a raw body as a
 * `Buffer`.
 */
export interface RequestTarget {
	method: string;
	url: URL;
	body?: unknown;
}

/**
 * What a server needs to verify a signed request: the request as seen
 * at the server's public URL, and where it records spent nonces.
 */
export interface RequestAuthContext extends RequestTarget {
	replayGuard: KeetaAnchorReplayGuard;
}

/**
 * Collapse leading slashes in a request path, as the server does before
 * routing, so `//api/x` and `/api/x` name the same operation.
 */
export function normalizeRequestPath(path: string): string {
	return(path.replace(/^\/+/, '/'));
}

/**
 * The URL a signature covers: origin, path, and every query parameter
 * except the signature and the signer, in sorted order.
 */
function canonicalRequestURL(url: URL): string {
	const params = [ ...url.searchParams ].filter(function([ key ]) {
		return(key !== 'account' && !key.startsWith('signed.'));
	}).sort(function([ a ], [ b ]) {
		if (a === b) {
			return(0);
		}

		return(a < b ? -1 : 1);
	});

	const query = params.length === 0 ? '' : `?${new URLSearchParams(params).toString()}`;
	return(`${url.origin}${normalizeRequestPath(url.pathname)}${query}`);
}

/**
 * Hash of the body a signature covers. A JSON body is hashed in the form
 * the server parses, without its top-level `signed` field.
 */
function requestBodyDigest(body: RequestTarget['body']): string {
	if (body === undefined) {
		return('');
	}

	let bytes: Buffer;
	if (Buffer.isBuffer(body)) {
		bytes = body;
	} else {
		const parsed: unknown = JSON.parse(JSON.stringify(body));
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'signed' in parsed) {
			const unsigned = Object.entries(parsed).filter(function([ key ]) {
				return(key !== 'signed');
			});
			bytes = Buffer.from(canonicalizeJson(Object.fromEntries(unsigned)), 'utf-8');
		} else {
			bytes = Buffer.from(canonicalizeJson(parsed), 'utf-8');
		}
	}

	return(Buffer.from(KeetaNetLib.Utils.Hash.Hash(bytes)).toString('hex'));
}

/**
 * Bind `data` to one request: the method, the URL (which names the
 * anchor and the operation), and the body.
 */
export function requestSignable(target: RequestTarget, data: Signable): Signable {
	return([
		REQUEST_SIGNABLE_TAG,
		target.method.toUpperCase(),
		canonicalRequestURL(target.url),
		requestBodyDigest(target.body),
		...data
	]);
}

/**
 * Rebase a request URL onto the server's configured public URL, so the
 * audience never comes from the Host header.
 */
export function publicRequestURL(serverURL: string, requestURL: URL): URL {
	return(new URL(`${requestURL.pathname}${requestURL.search}`, serverURL));
}

/**
 * Sign `data` for one request.
 */
export async function signRequest(account: SignableAccount, target: RequestTarget, data: Signable): Promise<HTTPSignedField> {
	return(await SignData(account, requestSignable(target, data)));
}

/**
 * Verify a request signature, then spend its nonce. Resolves `false`
 * when the signature does not cover this request, or was already used.
 */
export async function verifySignedRequest(account: VerifiableAccount, context: RequestAuthContext, data: Signable, signed: HTTPSignedField): Promise<boolean> {
	let signable: Signable;
	try {
		signable = requestSignable(context, data);
	} catch {
		/* A body that cannot be canonicalized cannot have been signed */
		return(false);
	}

	const valid = await VerifySignedData(account, signable, signed, { maxSkewMs: DEFAULT_MAX_SKEW_MS });
	if (!valid) {
		return(false);
	}

	const expiresAt = new Date(new Date(signed.timestamp).valueOf() + DEFAULT_MAX_SKEW_MS);
	return(await context.replayGuard.claim(`request:${account.publicKeyString.get()}:${signed.nonce}`, expiresAt));
}
