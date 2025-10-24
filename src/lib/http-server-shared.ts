export interface HTTPSignedField {
    nonce: string;
    /* Date and time of the request in ISO 8601 format */
    timestamp: string;
    /* Signature of the account public key and the nonce as an ASN.1 Sequence, Base64 DER */
    signature: string;
}
