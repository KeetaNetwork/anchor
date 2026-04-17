// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

/**
 * Determine if an object type has at least one function property,
 * if so it's not a plain object
 */
type HasFunctionProperty<T extends object> = Extract< { [K in keyof T]-?: T[K] extends AnyFunction ? K : never }[keyof T], keyof T> extends never ? false : true;

export type DeepPartial<T> =
	T extends AnyFunction ? T :
		T extends (infer U)[] ? DeepPartial<U>[] :
			T extends object ? (HasFunctionProperty<T> extends true ? T : { [P in keyof T]?: DeepPartial<T[P]> }) :
				T;

export type DeepRequired<T> =
	T extends AnyFunction ? T :
		T extends (infer U)[] ? DeepRequired<U>[] :
			T extends object ? (HasFunctionProperty<T> extends true ? T : { [P in keyof T]-?: DeepRequired<T[P]> }) :
				T;
