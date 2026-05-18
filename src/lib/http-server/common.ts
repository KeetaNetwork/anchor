import type { Account } from "@keetanetwork/keetanet-client/lib/account.js";
import type { ResolvedCertificateChainRequirement } from "../utils/certificate-network.js";
import type { Signable } from "../utils/signing.js";
import { KeetaAnchorUserError } from "../error.js";
import { KeetaNet } from "../../client/index.js";
import { assertAccountCertificateChain } from "../utils/certificate-network.js";
import { createAssertEquals } from "typia";
import { VerifySignedData } from "../utils/signing.js";

export type ExtractOk<T> = Omit<Extract<T, { ok: true }>, 'ok'>;

export type HTTPSignedField = {
	nonce: string;
	/* Date and time of the request in ISO 8601 format */
	timestamp: string;
	/* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
	signature: string;
};

export const assertHTTPSignedField: (input: unknown) => HTTPSignedField = createAssertEquals<HTTPSignedField>();

export interface HTTPSignedFieldURLParameters {
	signedField: HTTPSignedField;
	account: Account;
}

export function addSignatureToURL(input: URL | string, data: HTTPSignedFieldURLParameters): URL {
	let url: URL;

	if (typeof input === 'string') {
		url = new URL(input);
	} else {
		url = new URL(input.toString());
	}

	for (const key of [ 'nonce', 'timestamp', 'signature' ] as const) {
		const searchKey = `signed.${key}`;

		if (url.searchParams.has(searchKey)) {
			throw(new KeetaAnchorUserError(`URL already has signed field parameter: ${searchKey}`));
		}

		url.searchParams.set(`signed.${key}`, data.signedField[key]);
	}

	url.searchParams.set('account', data.account.publicKeyString.get());

	return(url);
}

export function parseSignatureFromURL(input: URL | string): Partial<HTTPSignedFieldURLParameters> {
	let url: URL;

	if (typeof input === 'string') {
		url = new URL(input);
	} else {
		url = new URL(input.toString());
	}

	const retVal: Partial<HTTPSignedFieldURLParameters> = {};

	const signedField = ((): HTTPSignedField | undefined => {
		const nonce = url.searchParams.get('signed.nonce');
		const timestamp = url.searchParams.get('signed.timestamp');
		const signature = url.searchParams.get('signed.signature');

		if (!nonce && !timestamp && !signature) {
			return(undefined);
		}

		if (!nonce || !timestamp || !signature) {
			throw(new KeetaAnchorUserError('Incomplete signature fields in URL'));
		}

		return({ nonce, timestamp, signature });
	})();

	if (signedField) {
		retVal.signedField = signedField;
	}

	const account = ((): Account | undefined => {
		const accountParam = url.searchParams.get('account');
		if (!accountParam) {
			return(undefined);
		}

		return(KeetaNet.lib.Account.fromPublicKeyString(accountParam).assertAccount());
	})();

	if (account) {
		retVal.account = account;
	}

	return(retVal);
}

/**
 * Verify a signed body, then enforce the cert-chain gate. Returns the
 * authenticated account. Throws `KeetaAnchorUserError` on missing or
 * invalid auth, and `KeetaAnchorCertificateRequiredError` when the
 * caller's on-chain cert chain doesn't satisfy `certificateChain`.
 */
export async function verifyBodyAuth<T extends { account?: string; signed?: unknown }>(
	request: T,
	getSigningData: (req: T) => Signable,
	certificateChain?: ResolvedCertificateChainRequirement
): Promise<Account> {
	if (!request.account || !request.signed) {
		throw(new KeetaAnchorUserError('Authentication required'));
	}

	const account = KeetaNet.lib.Account.fromPublicKeyString(request.account).assertAccount();

	const signable = getSigningData(request);
	const signed = assertHTTPSignedField(request.signed);
	const valid = await VerifySignedData(account, signable, signed);
	if (!valid) {
		throw(new KeetaAnchorUserError('Invalid signature'));
	}

	await assertAccountCertificateChain(account, certificateChain);

	return(account);
}

/**
 * Verify a URL-signed request, then enforce the cert-chain gate. Returns
 * the authenticated account. The signable is built by the caller from a
 * request derived from the URL-bound account public key.
 */
export async function verifyURLAuth(
	url: URL | string,
	getSigningData: (account: Account) => Signable,
	certificateChain?: ResolvedCertificateChainRequirement
): Promise<Account> {
	let urlString: string;
	if (typeof url === 'string') {
		urlString = url;
	} else {
		urlString = url.href;
	}

	const parsed = parseSignatureFromURL(urlString);
	if (!parsed.account || !parsed.signedField) {
		throw(new KeetaAnchorUserError('Authentication required'));
	}

	const signable = getSigningData(parsed.account);
	const valid = await VerifySignedData(parsed.account, signable, parsed.signedField);
	if (!valid) {
		throw(new KeetaAnchorUserError('Invalid signature'));
	}

	await assertAccountCertificateChain(parsed.account, certificateChain);

	return(parsed.account);
}
