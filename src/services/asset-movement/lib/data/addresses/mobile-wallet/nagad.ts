import type { AccountAddressSchema } from "../../types.js";

const nagadMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default nagadMobileWalletSchema;
