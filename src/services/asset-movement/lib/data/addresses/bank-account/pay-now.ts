import type { ObjectSchema } from '../../json-schema.js';
import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const sharedProperties = {
	payNowKeyType: { type: 'string', enum: [ 'mobile', 'uen', 'nric' ] }
} satisfies ObjectSchema['properties'];

const payNowSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				...sharedProperties,
				payNowKey: { type: 'string' },
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: []
		},
		obfuscated: {
			type: 'object',
			properties: {
				...sharedProperties,
				payNowKeyEnding: { type: 'string' },
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

export default payNowSchema;
