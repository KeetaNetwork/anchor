import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const bcrPaySchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				dui: {
					type: 'string',
					maxLength: 9,
					minLength: 9,
					pattern: '^\\d{9}$'
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: ['dui']
		},
		obfuscated: {
			type: 'object',
			properties: {
				duiEnding: { type: 'string' },
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

export default bcrPaySchema;
