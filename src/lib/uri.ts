import { GenericAccount, TokenAddress } from "@keetanetwork/keetanet-client/lib/account.js";
import { lib as KeetaNetLib } from '@keetanetwork/keetanet-client';

const URLProtocol = 'keeta:' as const;
export type KeetaURIString = `${typeof URLProtocol}//${string}`;


export type KeetaURIActions = {
    type: 'send';
    to?: GenericAccount;
    token?: TokenAddress;
    value?: bigint;
    external?: string[];
}

export function parseKeetaURI(uri: string): KeetaURIActions {
    const url = new URL(uri);

    if (url.protocol !== URLProtocol) {
        throw new Error(`Invalid protocol: ${url.protocol}`);
    }

    if (url.hostname !== 'actions') {
        throw new Error(`Invalid hostname: ${url.hostname}, expected actions`);
    }

    const path = url.pathname.slice(1); // Remove leading '/'
    const pathParts = path.split('/');
    const action = pathParts.shift()!;
    if (action === 'send') {
        if (pathParts.length !== 0) {
            throw new Error(`Unexpected path parts: ${pathParts.join('/')}`);
        }



        let ret: Extract<KeetaURIActions, { type: 'send' }> = {
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
                throw new Error(`Invalid value: ${valueParam}`);
            }
        }

        const externalParams = url.searchParams.getAll('external');
        if (externalParams.length > 0) {
            ret.external = externalParams;
        }

        return(ret);
    } else {
        throw new Error(`Invalid action: ${action}`);
    }
}

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

    return(url.toString() as KeetaURIString);
}

export function assertKeetaURIString(value: unknown): KeetaURIString {
    if (typeof value !== 'string') {
        throw new Error('KeetaURIString must be a string');
    }

    try {
        parseKeetaURI(value);
    } catch (e) {
        throw new Error(`Invalid KeetaURIString: ${(e as Error).message}`);
    }
    
    return(value as KeetaURIString);
}
