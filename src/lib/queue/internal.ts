import type { Logger } from '../log/index.ts';

/* XXX: Move this somewhere more common */
export function MethodLogger<T extends Logger | undefined>(input: T, from: { file: string; method: string; class: string; instanceID: string; }): T extends Logger ? Logger : undefined {
	if (input === undefined) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		return(undefined as T extends Logger ? Logger : undefined);
	}

	const fromStr = `${from.class}${from.instanceID ? `:${from.instanceID}` : ''}::${from.method}`;
	const retval: Logger = {
		debug: function(...logArgs: unknown[]): void {
			input.debug(fromStr, ...logArgs);
		},
		info: function(...logArgs: unknown[]): void {
			input.info(fromStr, ...logArgs);
		},
		warn: function(...logArgs: unknown[]): void {
			input.warn(fromStr, ...logArgs);
		},
		error: function(...logArgs: unknown[]): void {
			input.error(fromStr, ...logArgs);
		},
		log: function(...logArgs: unknown[]): void {
			input.log(fromStr, ...logArgs);
		}
	};

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(retval as T extends Logger ? Logger : undefined);
}
