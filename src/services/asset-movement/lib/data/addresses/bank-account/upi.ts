import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const upiSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		phoneNumber: true,
		accountOwner: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				upiKey: {
					type: 'string',
					maxLength: 62,
					minLength: 5,
					pattern: '^[a-zA-Z0-9._]{2,40}@[a-zA-Z0-9]{2,20}$'
				},
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: ['upiKey']
		},
		obfuscated: {
			type: 'object',
			properties: {
				upiKeyEnding: { type: 'string' },
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

export default upiSchema;
