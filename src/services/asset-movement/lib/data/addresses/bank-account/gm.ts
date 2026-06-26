import type { AccountAddressSchema } from "../../types.js";

const gambiaBankAccountSchema: AccountAddressSchema = {
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
				}
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default gambiaBankAccountSchema;
