import type {
	ServiceMetadata,
	ServiceSearchCriteria
} from '../../lib/resolver.ts';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as Signing from '../../lib/utils/signing.js';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type { HTTPSignedField } from '../../lib/http-server-shared.js';

type KeetaNetToken = InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>;

export type CountryCodesSearchCriteria = ServiceSearchCriteria<'kyc'>['countryCodes'];

export type Operations = NonNullable<ServiceMetadata['services']['kyc']>[string]['operations'];
export type OperationNames = keyof Operations;

export interface KeetaKYCAnchorCreateVerificationRequest {
	countryCodes: CountryCodesSearchCriteria;
	account: ReturnType<InstanceType<typeof KeetaNet.lib.Account>['publicKeyString']['get']>;
	signed: HTTPSignedField;
}

type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;
export type KeetaKYCAnchorCreateVerificationResponse = ({
	ok: true;

	/**
	 * The ID of the verification request -- this is a unique identifier
	 * for the verification request that can be used to fetch the
	 * certificate later
	 */
	id: string;
	/**
	 * The expected cost of the verification request, in the form of a
	 * token and a range of minimum and maximum expected costs
	 */
	expectedCost: {
		min: string;
		max: string;
		token: KeetaNetTokenPublicKeyString;
	};
	/**
	 * The URL to the verification service where the user can complete the
	 * verification process. This URL is expected to be a web URL that the
	 * user can visit to complete the verification.
	 */
	webURL: string;
} | {
	ok: false;
	error: string;
});

export type KeetaKYCAnchorGetCertificateResponse = ({
	ok: true;
	/**
	 * The certificates that were issued by the KYC Anchor service.
	 * Typically this will just be a single certificate, but
	 * it could also be multiple certificates if the service
	 * issues multiple certificates for a single verification.
	 *
	 * Each certificate is represented as a PEM-encoded string.
	 * The `intermediates` field is optional and may contain
	 * additional intermediate certificates that are required to
	 * validate the certificate chain.
	 */
	results: ({
		certificate: string;
		intermediates?: string[];
	})[];
} | {
	ok: false;
	error: string;
});

class KeetaKYCAnchorVerificationNotFoundError extends KeetaAnchorUserError {
	protected statusCode = 400;
	constructor(message?: string) {
		super(message ?? 'Verification ID not found');
	}
}

class KeetaKYCAnchorCertificateNotFoundError extends KeetaAnchorUserError {
	protected statusCode = 404;
	constructor(message?: string) {
		super(message ?? 'Certificate not found (pending)');
	}
}

class KeetaKYCAnchorCertificatePaymentRequired extends KeetaAnchorUserError {
	protected statusCode = 402;
	readonly amount: bigint;
	readonly token: KeetaNetToken;
	constructor(cost: { amount: bigint | string; token: KeetaNetToken | string; }, message?: string) {
		super(message ?? 'Payment required for certificate');

		this.amount = BigInt(cost.amount);
		this.token = KeetaNet.lib.Account.toAccount<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>(cost.token);
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		let message = this.message;
		if (contentType === 'application/json') {
			message = JSON.stringify({
				ok: false,
				code: 'KEETA_ANCHOR_KYC_PAYMENT_REQUIRED',
				data: {
					cost: {
						amount: `0x${this.amount.toString(16)}`,
						token: this.token.publicKeyString.get()
					}
				},
				error: this.message
			});
		}

		return({
			error: message,
			statusCode: this.statusCode,
			contentType: contentType
		});
	}
}

export const Errors: {
	VerificationNotFound: typeof KeetaKYCAnchorVerificationNotFoundError;
	CertificateNotFound: typeof KeetaKYCAnchorCertificateNotFoundError;
	PaymentRequired: typeof KeetaKYCAnchorCertificatePaymentRequired;
} = {
	/**
	 * The verification ID was not found
	 */
	VerificationNotFound: KeetaKYCAnchorVerificationNotFoundError,

	/**
	 * The certificate for the verification ID was not found
	 * (typically this means the verification is still pending)
	 */
	CertificateNotFound: KeetaKYCAnchorCertificateNotFoundError,

	/**
	 * Payment is required for the certificate
	 */
	PaymentRequired: KeetaKYCAnchorCertificatePaymentRequired
}

export async function generateSignedData(account: Signing.SignableAccount): Promise<{ nonce: string; timestamp: string; signature: string; }> {
	return(await Signing.SignData(account, []));
}

export async function verifySignedData(request: Pick<KeetaKYCAnchorCreateVerificationRequest, 'account' | 'signed'>): Promise<boolean> {
	const account = KeetaNet.lib.Account.fromPublicKeyString(request.account);
	return(await Signing.VerifySignedData(account, [], request.signed));
}
