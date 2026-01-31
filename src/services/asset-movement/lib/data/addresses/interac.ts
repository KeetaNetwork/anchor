import type { BankAccountAddressSchema } from "../types.js";

const interacSchema: BankAccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: false,
		bankName: true,
		accountNumberEnding: true
	},

	additionalProperties: {
		resolved: {
			type: "object",
			properties: {
				bankCode: {
					type: "string",
					description: "Institution Number",
					maxLength: 3,
					minLength: 3,
					pattern: "^\\d{3}$"
				},
				bankAccountNumber: {
					type: "string",
					description: "Account Number"
				},
				routingCode: {
					type: "string",
					description: "Transit Code",
					maxLength: 5,
					minLength: 5,
					pattern: "^\\d{5}$"
				}
			},
			required: [ 'routingCode', 'bankCode']
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default interacSchema;
