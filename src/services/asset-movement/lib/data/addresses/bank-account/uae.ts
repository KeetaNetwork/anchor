import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const uaeBankAccountSchema: AccountAddressSchema = {
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
					minLength: 23,
					maxLength: 23,
					pattern: "^[a-zA-Z0-9]{23}$"
				},
				swiftCode: {
					type: "string",
					description: "Transit Code",
					maxLength: 11,
					minLength: 8,
					pattern: "^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{11}$"
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'bankAccountNumber', 'swiftCode' ]
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

export default uaeBankAccountSchema;
