// Common type guards used across the library

export function hasIndexSignature(v: unknown): v is { [key: string]: unknown } {
	return(typeof v === 'object' && v !== null);
}

export function isErrorLike(v: unknown): v is Error {
	return(typeof v === 'object' && v !== null && ('message' in (v)));
}

export function hasValueProp(v: unknown): v is { value: unknown } {
	return(typeof v === 'object' && v !== null && ('value' in (v)));
}

export function isContextTagged(v: unknown): v is { type: 'context'; kind: 'explicit'|'implicit'; value: number; contains: unknown } {
	if (!(typeof v === 'object' && v !== null)) {return(false);}
	if (!('type' in v) || !('kind' in v) || !('value' in v) || !('contains' in v)) {return(false);}
	// Now TS knows v has these keys
	const obj: { [key: string]: unknown } = v;
	if (obj.type !== 'context') {return(false);}
	if (!(obj.kind === 'explicit' || obj.kind === 'implicit')) {return(false);}
	if (typeof obj.value !== 'number') {return(false);}
	return(true);
}
