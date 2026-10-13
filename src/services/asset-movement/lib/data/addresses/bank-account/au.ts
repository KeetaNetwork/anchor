import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const australiaBankAccountSchema: AccountAddressSchema = {
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
					description: "BSB Code",
					minLength: 6,
					maxLength: 6,
					pattern: "^\\d{6}$"
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'bankAccountNumber', 'bankCode' ]
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

export default australiaBankAccountSchema;
