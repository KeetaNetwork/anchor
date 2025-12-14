import type { Account } from "@keetanetwork/keetanet-client/lib/account.js";
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
