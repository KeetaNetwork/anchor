import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const pakistanBankAccountSchema: AccountAddressSchema = {
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
					minLength: 24,
					maxLength: 24,
					pattern: "^[a-zA-Z0-9]{24}$"
				},
				bankCode: {
					type: "string",
					description: "Bank Code"
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object",
			properties: {
				accountAddress: {
					oneOf: [
						{ type: 'string' },
						sharedSchemaReferences.PhysicalAddress
					]
				}
			}
		}
	}
}

export default pakistanBankAccountSchema;
