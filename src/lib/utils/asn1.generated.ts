import * as typia from 'typia';

/*
 * We can't statically check that ReferenceSchemaNormalized is a subset of ReferenceSchema
 * because it is generated as ASN1.Schema instead of a more specific type
 */
type ReferenceSchemaNormalized = {
	type: 'struct';
	fieldNames: string[];
	contains: {
		external: {
			type: 'struct';
			fieldNames: string[];
			contains: {
				url: {
					type: 'string';
					kind: 'utf8';
					value: string;
				};
				contentType: { type: 'string'; kind: 'utf8'; value: string; };
			};
		};
		digest: {
			type: 'struct';
			fieldNames: string[];
			contains: {
				digestAlgorithm: { type: 'oid'; oid: string; };
				digest: unknown;
			};
		};
		encryptionAlgorithm: { type: 'oid'; oid: string; } | undefined;
	};
};

export const isReferenceSchema: (input: unknown) => input is ReferenceSchemaNormalized = typia.createIs<ReferenceSchemaNormalized>();
export const assertReference: (input: unknown) => ReferenceSchemaNormalized = typia.createAssert<ReferenceSchemaNormalized>();
