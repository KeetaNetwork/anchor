import type { BankAccountAddressSchema } from "../types.js";

const clabeSchema: BankAccountAddressSchema = {
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
				accountNumber: { type: "string" }
			},
			required: ['accountNumber']
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default clabeSchema;
