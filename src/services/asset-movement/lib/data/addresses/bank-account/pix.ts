import type { Schema } from "../../json-schema.js";
import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

const pixKeyType = { type: "string", enum: [ 'random', 'email', 'phone' ] } satisfies Schema;

const pixSchema: AccountAddressSchema = {
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
				brCode: { type: "string" },
				pixKeyType: pixKeyType,
				pixKey: { type: "string" },
				accountAddress: sharedSchemaReferences.PhysicalAddress,
				document: {
					type: 'object',
					properties: {
						type: { type: "string", enum: ['cpf', 'cnpj'] },
						number: { type: "string" }
					},
					required: ['number']
				}
			},
			required: []
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

export default pixSchema;
