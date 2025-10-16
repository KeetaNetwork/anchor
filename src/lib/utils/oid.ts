export function getOID(name: string, oidDB: { [name: string]: string }): string {
	if (name in oidDB) {
		const oid = oidDB[name];
		if (oid === undefined) {
			throw(new Error('internal error: OID was undefined'));
		}

		return(oid);
	}
	throw(new Error(`Unknown OID name: ${name}`));
}

export function lookupByOID(oid: string, oidDB: { [name: string]: string }): string {
	for (const [key, value] of Object.entries(oidDB)) {
		if (key === oid) { return(key); }
		if (value === oid) { return(key); }
	}

	throw(new Error(`Unknown OID: ${oid}`));
}
