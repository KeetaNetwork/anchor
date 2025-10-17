export type Brand<T, BrandName extends string> = T & {
	readonly [B in BrandName as `__${B}_brand`]: never;
};

/**
 * A branded string type. This is a string that is branded with a specific
 * type, making it impossible to accidentally mix it with other strings.
 *
 * We pretend that `symbol` is a primitive type for the purposes of branding
 * it, since it is unique and cannot be easily created by accident.
 */
export type BrandedString<BrandName extends string> = Brand<symbol, BrandName>;
