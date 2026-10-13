import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const philippinesBankAccountSchema: AccountAddressSchema = {
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
				bankCode: {
					type: "string",
					description: "Bank Code",
					minLength: 9,
					maxLength: 9,
					pattern: "^\\d{9}$"
				},
				swiftCode: {
					type: "string",
					description: "SWIFT Code",
					minLength: 8,
					maxLength: 11,
					pattern: "^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{11}$"
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'bankAccountNumber', 'bankCode', 'swiftCode' ]
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

export default philippinesBankAccountSchema;
