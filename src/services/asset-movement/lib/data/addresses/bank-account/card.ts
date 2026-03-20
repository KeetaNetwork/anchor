import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const cardSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true,
		bankName: false,
		accountNumberEnding: true
	},

	additionalProperties: {
		resolved: {
			type: "object",
			properties: {
				ownerAddress: sharedSchemaReferences.PhysicalAddress,
				cardNumber: { type: "string", minLength: 13, maxLength: 19, pattern: "^\\d{13,19}$" },
				securityCode: { type: "string", minLength: 3, maxLength: 4, pattern: "^\\d{3,4}$" },
				expirationDate: sharedSchemaReferences.MonthYearDateInput,
				cardType: sharedSchemaReferences.CardType
			},
			required: ['cardNumber', 'securityCode', 'expirationDate']
		},
		obfuscated: {
			type: "object",
			properties: {
				ownerAddress: sharedSchemaReferences.PhysicalAddress,
				cardNumberEnding: { type: "string" },
				expirationDate: sharedSchemaReferences.MonthYearDateInput,
				cardType: sharedSchemaReferences.CardType
			},
			required: ['cardNumberEnding']
		}
	}
}

export default cardSchema;
