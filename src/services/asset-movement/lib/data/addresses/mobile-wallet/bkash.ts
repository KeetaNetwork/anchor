import type { AccountAddressSchema } from "../../types.js";

const bKashMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default bKashMobileWalletSchema;
