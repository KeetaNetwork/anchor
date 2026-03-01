import type { AccountAddressSchema } from "../../types.js";

const usernameObject: AccountAddressSchema['additionalProperties']['resolved'] = {
	type: "object",
	properties: {
		username: { type: "string" }
	},
	required: [ 'username' ]
};

const venmoMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: false },
	additionalProperties: {
		resolved: usernameObject,
		obfuscated: usernameObject
	}
}

export default venmoMobileWalletSchema;
