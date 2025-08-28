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