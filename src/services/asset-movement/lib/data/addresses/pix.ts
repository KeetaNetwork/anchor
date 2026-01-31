import type { BankAccountAddressSchema } from "../types.js";

const pixSchema: BankAccountAddressSchema = {
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
				brCode: { type: "string" },
				pixKey: { type: "string" },
				document: {
					type: 'object',
					properties: {
						type: { type: "string", enum: ['cpf', 'cnpj'] },
						number: { type: "string" }
					},
					required: ['number']
				}
			},
			required: []
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default pixSchema;
