export type DeepPartial<T> =
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T extends (...args: any[]) => any ? T :
		T extends (infer U)[] ? DeepPartial<U>[] :
			T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } :
				T;
