import type { AccountAddressSchema } from "../../types.js";

const egyptBankAccountSchema: AccountAddressSchema = {
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
					minLength: 29,
					maxLength: 29,
					pattern: "^[a-zA-Z0-9]{29}$"
				},
				bankCode: {
					type: "string",
					description: "Bank Code"
				}
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default egyptBankAccountSchema;
