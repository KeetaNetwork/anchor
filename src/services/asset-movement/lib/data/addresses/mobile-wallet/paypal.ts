import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const paypalAccountDetails: AccountAddressSchema['additionalProperties']['resolved'] = {
	type: "object",
	properties: {
		phoneNumber: sharedSchemaReferences.PhoneNumber,
		email: { type: "string" }
	},
	required: []
};

const paypalMobileWalletSchema: AccountAddressSchema = {
	type: 'mobile-wallet',
	includeFields: { phoneNumber: false },
	additionalProperties: {
		resolved: paypalAccountDetails,
		obfuscated: paypalAccountDetails
	}
}

export default paypalMobileWalletSchema;
