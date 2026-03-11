import type { AccountAddressSchema } from "../../types.js";

const easyPaisaMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: true },
	additionalProperties: {}
}

export default easyPaisaMobileWalletSchema;
