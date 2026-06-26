import type { Schema } from "../../json-schema.js";
import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const interacDestinationType = { type: "string", enum: [ 'email', 'phone' ] } satisfies Schema;

const sharedInteracFields = {
	destinationType: interacDestinationType,
	destinationValue: { type: "string" }
} satisfies { [key: string]: Schema };

const interacSchema: AccountAddressSchema = {
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
				...sharedInteracFields,
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: [ 'destinationValue' ]
		},
		obfuscated: {
			type: "object",
			properties: {
				...sharedInteracFields,
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

export default interacSchema;
