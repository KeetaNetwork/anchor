import type { Account, GenericAccount } from "@keetanetwork/keetanet-client/lib/account.js";
import { KeetaAnchorUserError } from "../error.js";
import { KeetaNet } from "../../client/index.js";
import { createAssertEquals } from "typia";

export type ExtractOk<T> = Omit<Extract<T, { ok: true }>, 'ok'>;

export interface HTTPSignedField {
	nonce: string;
	/* Date and time of the request in ISO 8601 format */
	timestamp: string;
	/* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
	signature: string;
}

export const assertHTTPSignedField: (input: unknown) => HTTPSignedField = createAssertEquals<HTTPSignedField>();

export interface HTTPSignedFieldURLParameters {
	signedField: HTTPSignedField;
	account: Account;
}

export interface HTTPSignedFieldURLParametersGenericAccount {
	signedField: HTTPSignedField;
	account: GenericAccount;
}

export function addSignatureToURL(input: URL | string, data: HTTPSignedFieldURLParametersGenericAccount): URL {
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

export function parseSignatureFromURL(input: URL | string): Partial<HTTPSignedFieldURLParameters>;
export function parseSignatureFromURL(input: URL | string, options: { assertKeyed: false }): Partial<HTTPSignedFieldURLParametersGenericAccount>;
export function parseSignatureFromURL(input: URL | string, options?: { assertKeyed?: boolean }): Partial<HTTPSignedFieldURLParametersGenericAccount> {
	let url: URL;

	if (typeof input === 'string') {
		url = new URL(input);
	} else {
		url = new URL(input.toString());
	}

	const retVal: Partial<HTTPSignedFieldURLParametersGenericAccount> = {};

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

	const accountParam = url.searchParams.get('account');
	if (accountParam) {
		const parsed = KeetaNet.lib.Account.fromPublicKeyString(accountParam);
		if (options?.assertKeyed === false) {
			retVal.account = parsed;
		} else {
			retVal.account = parsed.assertAccount();
		}
	}

	return(retVal);
}
