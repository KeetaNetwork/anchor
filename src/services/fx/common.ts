import type { lib as KeetaNetLib }  from '@keetanetwork/keetanet-client';

type KeetaNetTokenPublicKeyString = ReturnType<InstanceType<typeof KeetaNetLib.Account<typeof KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN>>['publicKeyString']['get']>;
export type KeetaFXAnchorEstimateResponse = ({
	ok: true;

    /**
     * Estimate for this conversion
     */
    estimate: {
        /**
         * Rate between the from and to currencies
         */
        rate: number;
        /**
         * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property. 
         */
        amount: string;
        /**
	     * Indicates whether the amount specified is in terms of the `from`
	     * currency (i.e., the user has this much) or the `to` currency
	     * (i.e., the user wants this much).
	     */
        affinity: 'from' | 'to';
    }
	/**
	 * The expected cost of the fx request, in the form of a
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

export type KeetaFXAnchorQuoteResponse = ({
	ok: true;

    /**
     * Estimate for this conversion
     */
    quote: {
        /**
         * Rate between the from and to currencies
         */
        rate: number;
        /**
         * Amount after the conversion as specified by either `from` or `to`, as specified by the `affinity` property. 
         */
        amount: string;
        /**
	     * Indicates whether the amount specified is in terms of the `from`
	     * currency (i.e., the user has this much) or the `to` currency
	     * (i.e., the user wants this much).
	     */
        affinity: 'from' | 'to';
        /**
         * Signature of the returned data to verify authenticity
         */
        signed: {
            nonce: string;
            /* Date and time of the request in ISO 8601 format */
            timestamp: string;
            /* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
            signature: string;
        };
    }
	/**
	 * The cost of the fx request, in the form of a
	 * token and amount that should be included with the swap
	 */
	cost: {
		amount: string;
		token: KeetaNetTokenPublicKeyString;
	};
} | {
	ok: false;
	error: string;
});

export type KeetaFXAnchorExchangeResponse = ({
	ok: true;

    /**
     * Vote Staple BlocksHash of the completed swap
     */
    blocksHash: string
} | {
	ok: false;
	error: string;
});
