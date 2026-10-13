import type { AccountAddressSchema } from "../../types.js";

const thailandBankAccountSchema: AccountAddressSchema = {
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
				swiftCode: {
					type: "string",
					description: "SWIFT code",
					minLength: 8,
					maxLength: 11,
					pattern: "^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{11}$"
				}
			},
			required: [ 'bankAccountNumber', 'swiftCode' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default thailandBankAccountSchema;
