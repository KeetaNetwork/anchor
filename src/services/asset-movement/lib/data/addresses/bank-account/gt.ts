import type { AccountAddressSchema } from "../../types.js";

const guatemalaBankAccountSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
		bankName: true,
		accountNumberEnding: true
	},

	additionalProperties: {
		resolved: {
			type: "object",
			properties: {
				bankAccountNumber: {
					type: "string",
					description: "Account Number",
					minLength: 2,
					maxLength: 80,
					pattern: "^[a-zA-Z0-9]{2,80}$"
				},
				bankCode: {
					type: "string",
					description: "Sort Code"
				}
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default guatemalaBankAccountSchema;
