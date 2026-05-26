import type { AccountAddressSchema } from "../../types.js";

const elSalvadorBankAccountSchema: AccountAddressSchema = {
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
					description: "Phone Number",
					minLength: 1,
					maxLength: 80,
					pattern: "^\\d{1,80}$"
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

export default elSalvadorBankAccountSchema;
