import type { BankAccountAddressSchema } from "../types.js";
import { sharedSchemaReferences } from "../types.js";

const ibanSwiftSchema: BankAccountAddressSchema = {
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
				country: sharedSchemaReferences.ISOCountryCode,
				accountNumber: { type: "string" },
				bic: { type: "string" },
				iban: { type: "string" },
				bankAddress: sharedSchemaReferences.PhysicalAddress,
				swift: {
					type: "object",
					properties: {
						category: { type: "string" },
						// Represent array of strings until array schema support lands.
						purposeOfFunds: { type: "object", description: "Array of strings" },
						businessDescription: { type: "string" }
					}
				}
			},
			required: []
		},
		obfuscated: {
			type: "object",
			properties: {
				country: sharedSchemaReferences.ISOCountryCode,
				bic: { type: "string" }
			},
			required: []
		}
	}
}

export default ibanSwiftSchema;
