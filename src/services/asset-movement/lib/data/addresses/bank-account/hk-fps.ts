import type { ObjectSchema } from '../../json-schema.js';
import { sharedSchemaReferences, type AccountAddressSchema } from '../../types.js';

const sharedProperties = {
	fpsKeyType: { type: 'string', enum: [ 'mobile', 'email', 'id' ] }
} satisfies ObjectSchema['properties'];

const hkFpsSchema: AccountAddressSchema = {
	type: 'bank-account',

	includeFields: {
		accountOwner: true
	},

	additionalProperties: {
		resolved: {
			type: 'object',
			properties: {
				...sharedProperties,
				fpsKey: { type: 'string' },
				accountAddress: sharedSchemaReferences.PhysicalAddress
			},
			required: []
		},
		obfuscated: {
			type: 'object',
			properties: {
				...sharedProperties,
				fpsKeyEnding: { type: 'string' },
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

export default hkFpsSchema;
