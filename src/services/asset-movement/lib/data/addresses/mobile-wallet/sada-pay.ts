import type { AccountAddressSchema } from "../../types.js";

const sadaPayMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default sadaPayMobileWalletSchema;
