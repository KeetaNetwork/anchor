import type { BankAccountAddressSchema } from "../types.js";

const usSchema: BankAccountAddressSchema = {
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
				accountNumber: { type: "string" },
				routingNumber: { type: "string" },
				accountTypeDetail: { type: "string", enum: ['checking', 'savings'] }
			},
			required: ['accountNumber', 'routingNumber', 'accountTypeDetail']
		},
		obfuscated: {
			type: "object",
			properties: {
				routingNumber: { type: "string" },
				accountTypeDetail: { type: "string", enum: ['checking', 'savings'] }
			},
			required: ['routingNumber']
		}
	}
}

export default usSchema;
