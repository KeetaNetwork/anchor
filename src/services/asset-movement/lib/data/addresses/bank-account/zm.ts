import type { AccountAddressSchema } from "../../types.js";

const zambiaBankAccountSchema: AccountAddressSchema = {
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
				bankCode: { type: "string", description: "Choose Bank", enum: ['ACCESS BANK', 'FNB BANK', 'STANBIC BANK', 'UBA BANK', 'ZANACO BANK'] }
			},
			required: [ 'bankAccountNumber' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default zambiaBankAccountSchema;
