import { types as nodeUtilsTypes } from 'util';
import type { JSONSerializable } from '@keetapay/keetanet-node/dist/lib/utils/conversion.js';
export type { JSONSerializable };

type ConvertToJSONOptions = {
	searchable?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertToJSONReplacer(this: any, key: string, jsonItem: unknown, options: ConvertToJSONOptions = { searchable: false }): JSONSerializable {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
	const item = this[key];

	switch (typeof item) {
		case 'string':
		case 'boolean':
			return(item);
		case 'undefined':
			return(String(item));
		case 'symbol':
			return(`[${item.toString()}]`);
		case 'function':
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if ('toString' in item && typeof item.toString === 'function') {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call
				const itemString: string = item.toString();
				if (itemString.toString().startsWith('class ')) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					return(`[Class ${item.name}]`);
				}
			}
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			return(`[Function ${item.name}]`);
		case 'bigint':
			if (item < BigInt(Number.MAX_SAFE_INTEGER) && item > BigInt(Number.MIN_SAFE_INTEGER)) {
				return(Number(item.toString()));
			} else {
				if (item < BigInt(0)) {
					const absItem = item * BigInt(-1);
					if (options.searchable) {
						return(`-0x${absItem.toString(16)}`);
					} else {
						return(`-0x${absItem.toString(16)}[=>${item.toString(10)}]`);
					}
				} else {
					if (options.searchable) {
						return(`0x${item.toString(16)}`);
					} else {
						return(`0x${item.toString(16)}[=>${item.toString(10)}]`);
					}
				}
			}
		case 'number':
			if (options.searchable) {
				if (isNaN(item)) {
					return('#NaN');
				}

				if (item === -Infinity) {
					return('#-Inf');
				}

				if (item === Infinity) {
					return('#Inf');
				}

				return(item);
			}

			if (item === -Infinity) {
				return('-∞');
			}
			if (item === Infinity) {
				return('∞');
			}

			if (isNaN(item)) {
				return('#NaN');
			}

			return(item);
		default:
			/* We handle other cases outside of this switch */
			break;
	}

	if (item === undefined) {
		return(String(item));
	}

	if (item === null) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return(item);
	}

	if (Array.isArray(item)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return(item);
	}

	if (nodeUtilsTypes.isDate(item)) {
		if (options.searchable) {
			return(item.toISOString());
		}

		return(`[Date ${item.toISOString()}]`);
	}

	if (Buffer.isBuffer(item)) {
		return(item.toString('base64'));
	}

	if (nodeUtilsTypes.isArrayBuffer(item)) {
		return(Buffer.from(item).toString('base64'));
	}

	if (item instanceof Promise) {
		return('[Promise]');
	}

	if (!(item instanceof Object)) {
		throw(new Error(`internal error: Unknown type ${typeof item}`));
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	if ('toJSON' in item && typeof item.toJSON === 'function') {
		/*
		 * No need to call toJSON() if it's a function, as it will
		 * be called by the JSON.stringify() function and passed in
		 * as the second argument to this function (jsonItem).
		 */
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return,no-type-assertion/no-type-assertion,@typescript-eslint/no-explicit-any
		return(jsonItem as any);
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-member-access
	if ('publicKeyString' in item && typeof item.publicKeyString === 'object' && item.publicKeyString !== null) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-member-access
		if ('get' in item.publicKeyString && item.publicKeyString.get !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (typeof item.publicKeyString.get === 'function') {
				// eslint-disable-next-line @typescript-eslint/no-inferrable-types
				let addToString: string = 'UNKNOWN';
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				if ('hasPrivateKey' in item && typeof item.hasPrivateKey === 'boolean') {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
					const hasPrivateKey = item.hasPrivateKey;
					if (hasPrivateKey) {
						addToString = 'PRIVATE';
					} else {
						addToString = 'PUBLIC';
					}
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-call
				return(`[Account ${item.publicKeyString.get()} ${addToString}]`);
			}
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	if ('constructor' in item && typeof item.constructor === 'function') {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-member-access
		if ('name' in item.constructor && typeof item.constructor.name === 'string') {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
			const typeID = item.constructor.name;
			if (typeID !== 'Object') {
				return(`[Instance ${typeID}]`);
			}
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	return(item);
}

export function convertToJSON(input: unknown, options?: Parameters<typeof convertToJSONReplacer>[2]): JSONSerializable {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-explicit-any
	return(JSON.parse(JSON.stringify(input, function(this: any, key: string, value: unknown) {
		return(convertToJSONReplacer.call(this, key, value, options));
	})));
}

/** @internal */
export const _Testing = {
	convertToJSONReplacer
};
