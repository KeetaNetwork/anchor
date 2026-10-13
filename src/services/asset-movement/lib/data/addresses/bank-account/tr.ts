import type { AccountAddressSchema } from "../../types.js";

const turkeyBankAccountSchema: AccountAddressSchema = {
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
					description: "IBAN",
					minLength: 26,
					maxLength: 26,
					pattern: "^[a-zA-Z0-9]{26}$"
				}
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default turkeyBankAccountSchema;
