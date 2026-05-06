import type { Account } from "@keetanetwork/keetanet-client/lib/account.js";
import { KeetaAnchorError, KeetaAnchorUserError } from "../error.js";
import { KeetaNet } from "../../client/index.js";
import { createAssertEquals } from "typia";

export type ExtractOk<T> = Omit<Extract<T, { ok: true }>, 'ok'>;

/**
 * Error thrown by anchor HTTP client wrappers when an outbound HTTP request
 * receives a non-2xx response.
 */
export class KeetaAnchorHTTPRequestError extends KeetaAnchorError {
	static override readonly name: string = 'KeetaAnchorHTTPRequestError';
	private readonly keetaAnchorHTTPRequestErrorObjectTypeID!: string;
	private static readonly keetaAnchorHTTPRequestErrorObjectTypeID = 'a3f9c1d2-7b4e-4a6c-9d1f-3e5b8c0a2d4f';
	readonly httpStatus: number;
	override readonly cause?: unknown;

	constructor(httpStatus: number, message: string, cause?: unknown) {
		super(message);
		this.httpStatus = httpStatus;
		this.retryable = httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);

		if (cause !== undefined) {
			this.cause = cause;
		}

		Object.defineProperty(this, 'keetaAnchorHTTPRequestErrorObjectTypeID', {
			value: KeetaAnchorHTTPRequestError.keetaAnchorHTTPRequestErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaAnchorHTTPRequestError {
		return(this.hasPropWithValue(input, 'keetaAnchorHTTPRequestErrorObjectTypeID', KeetaAnchorHTTPRequestError.keetaAnchorHTTPRequestErrorObjectTypeID));
	}
}

/**
 * Classify whether an error from an outbound HTTP request is retryable.
 */
export function isRetryableHttpError(input: unknown): boolean {
	if (KeetaAnchorError.isInstance(input)) {
		return(input.retryable);
	}
	if (input instanceof TypeError) {
		return(true);
	}
	if (input instanceof Error) {
		if (input.name === 'AbortError' || input.name === 'TimeoutError' || input.name === 'NetworkError') {
			return(true);
		}
	}

	return(false);
}

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
