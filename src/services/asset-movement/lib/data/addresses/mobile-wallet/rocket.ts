import type { AccountAddressSchema } from "../../types.js";

const rocketMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default rocketMobileWalletSchema;
