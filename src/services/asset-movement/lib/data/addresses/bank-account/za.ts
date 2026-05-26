import type { AccountAddressSchema } from "../../types.js";

const southAfricaBankAccountSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
		bankName: true,
		phoneNumber: true,
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
					description: "Bank Code",
					minLength: 6,
					maxLength: 6,
					pattern: "^\\d{6}$"
				},
				accountTypeDetail: { type: "string", enum: ['checking', 'savings'] },
				email: {
					type: "string",
					description: "Beneficiary Email",
					minLength: 4,
					maxLength: 100,
					pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
				}
			},
			required: [ 'bankAccountNumber', 'bankCode', 'email' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default southAfricaBankAccountSchema;
