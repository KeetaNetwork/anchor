import type { AccountAddressSchema } from "../../types.js";

const nayaPayMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default nayaPayMobileWalletSchema;
