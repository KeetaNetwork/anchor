import type {
	ServiceMetadata,
	ServiceSearchCriteria
} from '../../lib/resolver.ts';
import type { lib as KeetaNetLib }  from '@keetanetwork/keetanet-client';

export type CountryCodesSearchCriteria = ServiceSearchCriteria<'kyc'>['countryCodes'];

export type Operations = NonNullable<ServiceMetadata['services']['kyc']>[string]['operations'];
export type OperationNames = keyof Operations;

export interface KeetaKYCAnchorCreateVerificationRequest {
	countryCodes: CountryCodesSearchCriteria;
	account: ReturnType<InstanceType<typeof KeetaNetLib.Account>['publicKeyString']['get']>;
	signed: {
		nonce: string;
		/* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
		signature: string;
	};
};

type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;
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
