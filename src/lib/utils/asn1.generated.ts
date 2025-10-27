import * as typia from 'typia';

type ReferenceX = {
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
export const isReferenceSchema: (input: unknown) => input is ReferenceX = typia.createIs<ReferenceX>();
export const assertReference: (input: unknown) => ReferenceX = typia.createAssert<ReferenceX>();
