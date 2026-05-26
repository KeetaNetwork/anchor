import type { AccountAddressSchema } from "../../types.js";

const burkinaFasoBankAccountSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
		accountNumberEnding: true
	},

	additionalProperties: {
		resolved: {
			type: "object",
			properties: {
				bankAccountNumber: {
					type: "string",
					description: "IBAN",
					minLength: 28,
					maxLength: 28,
					pattern: "^[a-zA-Z0-9]{28}$"
				}
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default burkinaFasoBankAccountSchema;
