import type { AccountAddressSchema } from "../../types.js";

const colombiaBankAccountSchema: AccountAddressSchema = {
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
				swiftCode: {
					type: "string",
					description: "SWIFT code",
					minLength: 8,
					maxLength: 11,
					pattern: "^[A-Za-z0-9]{8}$|^[A-Za-z0-9]{11}$"
				},
				idName: {
					type: "string",
					description: "Identity Number",
					minLength: 1,
					maxLength: 100,
					pattern: "^[a-zA-Z0-9 ]{1,100}$"
				},
				idType: { type: "string", description: "Identity Type", enum: ['Citizenship Card', 'NIT', 'Passport', 'Foreigner ID', 'Special Stay Permit'] }
			},
			required: [ 'bankAccountNumber', 'swiftCode', 'idName' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default colombiaBankAccountSchema;
