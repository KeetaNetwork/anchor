/**
 * Asserts that the provided value is never.
 *
 * This is useful for static type checking to ensure that all possible values
 * are handled.
 */     
export function assertNever(value: never): never {
        /**
         * If we got to this point, it means that the value is not never and
         * so can be logged
         */
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw(new Error(`Unexpected value: ${value}`));
}  
