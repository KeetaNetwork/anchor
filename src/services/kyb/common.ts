import type {
	ServiceMetadata,
	ServiceSearchCriteria
} from '../../lib/resolver.ts';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as Signing from '../../lib/utils/signing.js';
import {
	KeetaAnchorUserError
} from '../../lib/error.js';
import type { HTTPSignedField } from '../../lib/http-server/common.js';

type KeetaNetToken = InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>;

export type CountryCodesSearchCriteria = ServiceSearchCriteria<'kyb'>['countryCodes'];

export type Operations = NonNullable<ServiceMetadata['services']['kyb']>[string]['operations'];
export type OperationNames = keyof Operations;

/**
 * A physical address for a business or one of its associated persons.
 */
export interface KeetaKYBAnchorBusinessAddress {
	streetAddress1?: string;
	streetAddress2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string;
}

/**
 * A person associated with the business (officer, director, or beneficial
 * owner) used to disambiguate the entity during verification.
 */
export interface KeetaKYBAnchorBusinessPerson {
	firstName?: string;
	lastName?: string;
}

/**
 * The business details used to perform a Know Your Business (KYB)
 * verification.
 *
 * Unlike an individual KYC verification (which redirects the user to a
 * hosted journey), a KYB verification is performed synchronously using
 * the business details supplied here.  There is no user-facing web URL.
 */
export interface KeetaKYBAnchorBusinessDetails {
	/**
	 * One or more legal / trade names for the business.  At least one
	 * name is required.  Additional names improve match accuracy.
	 */
	names: string[];
	/**
	 * Known addresses for the business (registered office, principal
	 * place of business, etc.).
	 */
	addresses?: KeetaKYBAnchorBusinessAddress[];
	/**
	 * Known associated persons (officers, directors, beneficial owners).
	 */
	persons?: KeetaKYBAnchorBusinessPerson[];
	/**
	 * Known websites for the business.
	 */
	websites?: string[];
}

export interface KeetaKYBAnchorCreateVerificationRequest {
	countryCodes: CountryCodesSearchCriteria;
	account: ReturnType<InstanceType<typeof KeetaNet.lib.Account>['publicKeyString']['get']>;
	signed: HTTPSignedField;
	/**
	 * The business to verify.
	 */
	business: KeetaKYBAnchorBusinessDetails;
}

type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNet.lib.Account<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;
export type KeetaKYBAnchorCreateVerificationResponse = ({
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
} | {
	ok: false;
	error: string;
});

export type KeetaKYBAnchorGetCertificateResponse = ({
	ok: true;
	/**
	 * The certificates that were issued by the KYB Anchor service.
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

class KeetaKYBAnchorVerificationNotFoundError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaKYBAnchorVerificationNotFoundError';
	private readonly KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID!: string;
	private static readonly KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID = '0a9c4d2e-3b7f-4c1a-9d6e-5f2b8c7a1e30';
	override readonly logLevel = 'DEBUG';

	constructor(message?: string) {
		super(message ?? 'Verification ID not found');
		this.statusCode = 400;

		Object.defineProperty(this, 'KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID', {
			value: KeetaKYBAnchorVerificationNotFoundError.KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaKYBAnchorVerificationNotFoundError {
		return(this.hasPropWithValue(input, 'KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID', KeetaKYBAnchorVerificationNotFoundError.KeetaKYBAnchorVerificationNotFoundErrorObjectTypeID));
	}
}

class KeetaKYBAnchorCertificateNotFoundError extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaKYBAnchorCertificateNotFoundError';
	private readonly KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID!: string;
	private static readonly KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID = '4e1d8f63-2a90-4b7c-8e35-7c9a0d4f6b21';

	constructor(message?: string) {
		super(message ?? 'Certificate not found (pending)');
		this.statusCode = 404;

		Object.defineProperty(this, 'KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID', {
			value: KeetaKYBAnchorCertificateNotFoundError.KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaKYBAnchorCertificateNotFoundError {
		return(this.hasPropWithValue(input, 'KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID', KeetaKYBAnchorCertificateNotFoundError.KeetaKYBAnchorCertificateNotFoundErrorObjectTypeID));
	}
}

class KeetaKYBAnchorCertificatePaymentRequired extends KeetaAnchorUserError {
	static override readonly name: string = 'KeetaKYBAnchorCertificatePaymentRequired';
	private readonly KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID!: string;
	private static readonly KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID = '8b3a52ed-c6f1-4d28-bb70-1e9d3c4a5f72';
	readonly amount: bigint;
	readonly token: KeetaNetToken;

	constructor(cost: { amount: bigint | string; token: KeetaNetToken | string; }, message?: string) {
		super(message ?? 'Payment required for certificate');
		this.statusCode = 402;

		this.amount = BigInt(cost.amount);
		this.token = KeetaNet.lib.Account.toAccount<typeof KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN>(cost.token);

		Object.defineProperty(this, 'KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID', {
			value: KeetaKYBAnchorCertificatePaymentRequired.KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID,
			enumerable: false
		});
	}

	static isInstance(input: unknown): input is KeetaKYBAnchorCertificatePaymentRequired {
		return(this.hasPropWithValue(input, 'KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID', KeetaKYBAnchorCertificatePaymentRequired.KeetaKYBAnchorCertificatePaymentRequiredObjectTypeID));
	}

	asErrorResponse(contentType: 'text/plain' | 'application/json'): { error: string; statusCode: number; contentType: string } {
		let message = this.message;
		if (contentType === 'application/json') {
			message = JSON.stringify({
				ok: false,
				code: 'KEETA_ANCHOR_KYB_PAYMENT_REQUIRED',
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

	toJSON(): { ok: false; retryable: boolean; error: string; name: string; statusCode: number; amount: string; token: string } {
		return({
			ok: false,
			retryable: this.retryable,
			error: this.message,
			name: this.name,
			statusCode: this.statusCode,
			amount: `0x${this.amount.toString(16)}`,
			token: this.token.publicKeyString.get()
		});
	}

	static async fromJSON(input: unknown): Promise<KeetaKYBAnchorCertificatePaymentRequired> {
		const { message, other } = this.extractErrorProperties(input, this);

		// Extract required properties specific to PaymentRequired
		if (!('amount' in other) || typeof other.amount !== 'string') {
			throw(new Error('Invalid KeetaKYBAnchorCertificatePaymentRequired JSON object: missing or invalid amount'));
		}

		if (!('token' in other) || typeof other.token !== 'string') {
			throw(new Error('Invalid KeetaKYBAnchorCertificatePaymentRequired JSON object: missing or invalid token'));
		}

		const error = new this(
			{
				amount: other.amount,
				token: other.token
			},
			message
		);

		error.restoreFromJSON(other);
		return(error);
	}
}

export const Errors: {
	VerificationNotFound: typeof KeetaKYBAnchorVerificationNotFoundError;
	CertificateNotFound: typeof KeetaKYBAnchorCertificateNotFoundError;
	PaymentRequired: typeof KeetaKYBAnchorCertificatePaymentRequired;
} = {
	/**
	 * The verification ID was not found
	 */
	VerificationNotFound: KeetaKYBAnchorVerificationNotFoundError,

	/**
	 * The certificate for the verification ID was not found
	 * (typically this means the verification is still pending)
	 */
	CertificateNotFound: KeetaKYBAnchorCertificateNotFoundError,

	/**
	 * Payment is required for the certificate
	 */
	PaymentRequired: KeetaKYBAnchorCertificatePaymentRequired
}

export async function generateSignedData(account: Signing.SignableAccount): Promise<{ nonce: string; timestamp: string; signature: string; }> {
	return(await Signing.SignData(account, []));
}

export async function verifySignedData(request: Pick<KeetaKYBAnchorCreateVerificationRequest, 'account' | 'signed'>): Promise<boolean> {
	const account = KeetaNet.lib.Account.fromPublicKeyString(request.account);
	return(await Signing.VerifySignedData(account, [], request.signed));
}
