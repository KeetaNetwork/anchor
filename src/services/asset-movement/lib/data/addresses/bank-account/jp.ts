import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const japanBankAccountSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
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
					description: "Bank code"
				},
				swiftCode: {
					type: "string",
					description: "SWIFT code",
					minLength: 8,
					maxLength: 11,
					pattern: "^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{11}$"
				},
				routingCode: {
					type: "string",
					description: "Branch Code",
					minLength: 3,
					maxLength: 3,
					pattern: "^\\d{3}$"
				},
				accountTypeDetail: { type: "string", enum: ['checking', 'savings'] },
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'bankAccountNumber', 'swiftCode', 'routingCode' ]
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

export default japanBankAccountSchema;
