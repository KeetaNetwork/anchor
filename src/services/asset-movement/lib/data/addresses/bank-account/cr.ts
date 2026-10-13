import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const costaRicaBankAccountSchema: AccountAddressSchema = {
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
					minLength: 22,
					maxLength: 22,
					pattern: "^[a-zA-Z0-9]{22}$"
				},
				accountTypeDetail: { type: "string", enum: ['checking', 'savings'] },
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

export default costaRicaBankAccountSchema;
