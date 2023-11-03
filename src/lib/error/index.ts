import type { MetadataErrorCode } from './metadata';

export type ErrorCode = MetadataErrorCode;

interface ValidationOptions {
	type: string;
	codes: string[] | Readonly<string[]>;
}

export default class AnchorError extends Error {
	type: string;
	code: ErrorCode;

	constructor(code: ErrorCode, message: string, validation?: ValidationOptions) {
		super(message);

		let type = validation?.type;

		if (!type) {
			type = 'GENERIC';
		}

		if (validation !== undefined) {
			const prefix = `${validation.type}_`;

			const validPrefix = code.startsWith(prefix);

			const withoutPrefix = code.substring(prefix.length);
			const validCode = validation.codes.includes(withoutPrefix);

			if (!validPrefix || !validCode) {
				throw(new Error(`Invalid construction of KeetaNetError Type: ${validation.type} Code: ${code}, prefix ${prefix} valid ${validPrefix} valid code: ${validCode}`));
			}
		}

		this.code = code;
		this.type = type;
	}
}


export async function ExpectErrorCode(code: ErrorCode, test: () => any) {
	try {
		await test();

		throw new Error(`Expected function to throw ${code} but it did not`);
	} catch (error) {
		expect(error instanceof AnchorError).toBe(true);

		if (error instanceof AnchorError) {
			expect(error.code).toEqual(code);
		} else {
			expect(true).toEqual(false);
		}
	}
}
