import type { GenericAccount, TokenAddress } from "@keetanetwork/keetanet-client/lib/account.js";
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';
import { KeetaAnchorUserError } from "./error.js";

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const URLProtocol = 'keeta:' as const;
export type KeetaURIString = `${typeof URLProtocol}//${string}`;


/**
 * The actions that can be represented in a Keeta URI, currently only "send"
 */
export type KeetaURIActions = {
	type: 'send';

	// Optional "to" parameter representing the recipient account of the action
	to?: GenericAccount;

	// Optional "token" parameter representing the token address of the action
	token?: TokenAddress;

	// Optional "value" parameter representing the amount to send
	value?: bigint;

	// Optional "external" parameter representing external data
	// When used the first item should be the external field of the SEND operation, and other fields can be used for chaining anchor actions
	external?: string[];
}

/**
 * Parse a Keeta URI string into a KeetaURIActions object
 * @param uri The string to parse, must be a valid Keeta URI
 * @returns The parsed Keeta URI action
 */
export function parseKeetaURI(uri: string): KeetaURIActions {
	const url = new URL(uri);

	if (url.protocol !== URLProtocol) {
		throw(new KeetaAnchorUserError(`Invalid protocol: ${url.protocol}`));
	}

	if (url.hostname !== 'actions') {
		throw(new KeetaAnchorUserError(`Invalid hostname: ${url.hostname}, expected actions`));
	}

	const path = url.pathname.slice(1); // Remove leading '/'
	const pathParts = path.split('/');
	const action = pathParts.shift();

	if (!action) {
		throw(new KeetaAnchorUserError('No action specified in URI'));
	}

	if (action === 'send') {
		if (pathParts.length !== 0) {
			throw(new KeetaAnchorUserError(`Unexpected path parts: ${pathParts.join('/')}`));
		}

		const ret: Extract<KeetaURIActions, { type: 'send' }> = {
			type: 'send'
		};

		const toParam = url.searchParams.get('to');
		if (toParam) {
			ret.to = KeetaNetLib.Account.fromPublicKeyString(toParam);
		}

		const tokenParam = url.searchParams.get('token');
		if (tokenParam) {
			ret.token = KeetaNetLib.Account.fromPublicKeyString(tokenParam).assertKeyType(KeetaNetLib.Account.AccountKeyAlgorithm.TOKEN);
		}

		const valueParam = url.searchParams.get('value');
		if (valueParam !== null) {
			try {
				ret.value = BigInt(valueParam);
			} catch {
				throw(new KeetaAnchorUserError(`Invalid value: ${valueParam}`));
			}
		}

		const externalParams = url.searchParams.getAll('external');
		if (externalParams.length > 0) {
			ret.external = externalParams;
		}

		return(ret);
	} else {
		throw(new KeetaAnchorUserError(`Invalid action: ${action}`));
	}
}

/**
 * Encode a KeetaURIActions object into a Keeta URI string
 * @param action The action to encode into a Keeta URI
 * @returns	The encoded Keeta URI string
 */
export function encodeKeetaURI(action: KeetaURIActions): KeetaURIString {
	const url = new URL(`${URLProtocol}//actions`);
	if (action.type === 'send') {
		url.pathname = '/send';

		if (action.to !== undefined) {
			url.searchParams.set('to', action.to.publicKeyString.get());
		}

		if (action.token !== undefined) {
			url.searchParams.set('token', action.token.publicKeyString.get());
		}

		if (action.value !== undefined) {
			url.searchParams.set('value', String(action.value));
		}

		for (const ext of (action.external ?? [])) {
			url.searchParams.append('external', ext);
		}
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(url.toString() as KeetaURIString);
}

export function assertKeetaURIString(value: unknown): KeetaURIString {
	if (typeof value !== 'string') {
		throw(new KeetaAnchorUserError('KeetaURIString must be a string'));
	}

	try {
		parseKeetaURI(value);
	} catch (e) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		throw(new KeetaAnchorUserError(`Invalid KeetaURIString: ${(e as Error).message}`));
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	return(value as KeetaURIString);
}
