import type { ObjectSchema } from '../../json-schema.js';
import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const sharedProperties = {
	duitNowKeyType: { type: 'string', enum: [ 'nric', 'passport', 'corporate_registration_number', 'army_id', 'mobile' ] }
} satisfies ObjectSchema['properties'];

const duitNowSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				...sharedProperties,
				duitNowKey: { type: 'string' },
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: []
		},
		obfuscated: {
			type: 'object',
			properties: {
				...sharedProperties,
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

export default duitNowSchema;
