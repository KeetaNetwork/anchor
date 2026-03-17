import type { AccountAddressSchema } from "../../types.js";

const airtelMoneyMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default airtelMoneyMobileWalletSchema;
