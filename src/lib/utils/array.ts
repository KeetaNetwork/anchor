type Grow<T, A extends T[]> = ((x: T, ...xs: A) => void) extends ((...a: infer X) => void) ? X : never;
type GrowToSize<T, A extends T[], N extends number> = { 0: A, 1: GrowToSize<T, Grow<T, A>, N> }[A['length'] extends N ? 0 : 1];
type FixedLengthArray<T, N extends number> = GrowToSize<T, [], N>;

export function isArray<Length extends number>(input: unknown, len: Length): input is FixedLengthArray<unknown, Length>;
export function isArray(input: unknown, len?: number): input is unknown[];
export function isArray(input: unknown, len?: number): input is unknown[] {
	if (!Array.isArray(input)) {
		return(false);
	}

	if (len !== undefined) {
		if (input.length !== len) {
			return(false);
		}
	}

	return(true);
}
