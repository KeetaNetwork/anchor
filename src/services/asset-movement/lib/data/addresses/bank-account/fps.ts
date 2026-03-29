import { sharedSchemaReferences, type AccountAddressSchema } from "../../types.js";

// UK Faster payments schema
const fpsSchema: AccountAddressSchema = {
    type: 'bank-account',

    includeFields: {
        accountOwner: true,
        accountNumberEnding: true
    },

    additionalProperties: {
        resolved: {
            type: "object",
            properties: {
                accountAddress: sharedSchemaReferences.PhysicalAddress,
                accountNumber: { type: "string", pattern: "^[a-zA-Z0-9]{2,80}$" },
                sortCode: { type: "string" }
            },
            required: []
        },
        obfuscated: {
            type: "object",
            properties: {
                sortCode: { type: "string" },
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

export default fpsSchema;
