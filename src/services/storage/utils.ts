import type { StorageObjectVisibility } from './common.ts';
import { Errors } from './common.js';

const VALID_VISIBILITIES = new Set<string>(['public', 'private']);

export function assertVisibility(value: unknown): StorageObjectVisibility {
	if (typeof value !== 'string' || !VALID_VISIBILITIES.has(value)) {
		throw new Errors.InvalidMetadata(`visibility must be 'public' or 'private'`);
	}

	return(value as StorageObjectVisibility);
}
