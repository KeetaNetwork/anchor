import type { AccountAddressSchema } from "../../types.js";

const mtnMobileMoneyMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default mtnMobileMoneyMobileWalletSchema;
