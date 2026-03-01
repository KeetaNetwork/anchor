import type { AccountAddressSchema } from "../../types.js";

const finjaWalletMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default finjaWalletMobileWalletSchema;
