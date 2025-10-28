import { Account } from "@keetanetwork/keetanet-client/lib/account.js";
import { KeetaAnchorUserError } from "./error.js";
import { KeetaNet } from "../client/index.js";

export interface HTTPSignedField {
    nonce: string;
    /* Date and time of the request in ISO 8601 format */
    timestamp: string;
    /* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
    signature: string;
}

export interface HTTPSignedFieldURLParameters {
    signedField: HTTPSignedField | null;
    account: Account | null;
}

export function addSignatureToURL(input: URL | string, data: HTTPSignedFieldURLParameters): URL {
    let url: URL;
    
    if (typeof input === 'string') {
        url = new URL(input);
    } else {
        url = new URL(input.toString());
    }

    for (const key of [ 'nonce', 'timestamp', 'signature' ] as const) {
        const searchKey = `signed.${key}`;

        if (url.searchParams.has(searchKey)) {
            throw(new KeetaAnchorUserError(`URL already has signed field parameter: ${searchKey}`));
        }

        if (data.signedField) {
            url.searchParams.set(`signed.${key}`, data.signedField[key]);
        }
    }

    if (data.account) {
        url.searchParams.set('account', data.account.publicKeyString.get());
    }

    return(url);
}

export function parseSignatureFromURL(input: URL | string): HTTPSignedFieldURLParameters {
    let url: URL;

    if (typeof input === 'string') {
        url = new URL(input);
    } else {
        url = new URL(input.toString());
    }

    const signedField = ((): HTTPSignedField | null => {
        const nonce = url.searchParams.get('signed.nonce');
        const timestamp = url.searchParams.get('signed.timestamp');
        const signature = url.searchParams.get('signed.signature');

        if (nonce === null && timestamp === null && signature === null) {
            return(null);
        }

        if (!nonce || !timestamp || !signature) {
            throw(new KeetaAnchorUserError('Incomplete signature fields in URL'));
        }
    
        return({ nonce, timestamp, signature });
    })();

    const account = ((): Account | null => {
        const accountParam = url.searchParams.get('account');
        if (accountParam === null) {
            return(null);
        }
        
        return(KeetaNet.lib.Account.fromPublicKeyString(accountParam).assertAccount());
    })();


    return({ signedField, account });
}