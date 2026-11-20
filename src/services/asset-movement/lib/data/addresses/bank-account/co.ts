import type { Schema } from "../../json-schema.js";
import type { AccountAddressSchema } from "../../types.js";

/**
 * The national document of a Colombian account owner. Every Colombian
 * address names it with these two fields.
 */
export const colombiaIdentityProperties: { readonly idName: Schema; readonly idType: Schema } = {
	idName: {
		type: "string",
		description: "Identity Number",
		minLength: 1,
		maxLength: 100,
		pattern: "^[a-zA-Z0-9 ]{1,100}$"
	},
	idType: { type: "string", description: "Identity Type", enum: ['Citizenship Card', 'NIT', 'Passport', 'Foreigner ID', 'Special Stay Permit'] }
};

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
				...colombiaIdentityProperties
			},
			required: [ 'bankAccountNumber', 'swiftCode', 'idName' ]
		},
		obfuscated: {
			type: "object"
		}
	}
}

export default colombiaBankAccountSchema;
