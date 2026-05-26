import type { AccountAddressSchema } from "../../types.js";

const nigeriaBankAccountSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
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
					description: "Sort Code"
				},
				idName: {
					type: "string",
					description: "Identity Number",
					minLength: 1,
					maxLength: 100,
					pattern: "^[a-zA-Z0-9 ]{1,100}$"
				},
				idType: { type: "string", description: "Identity Type", enum: ['National ID Card', 'Drivers License', 'Passport'] }
			},
			required: [ 'bankAccountNumber', 'idName' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default nigeriaBankAccountSchema;
