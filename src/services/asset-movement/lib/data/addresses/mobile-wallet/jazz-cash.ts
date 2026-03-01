import type { AccountAddressSchema } from "../../types.js";

const jazzCashMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default jazzCashMobileWalletSchema;
