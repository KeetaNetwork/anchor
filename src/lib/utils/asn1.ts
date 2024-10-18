import * as KeetaNetClient from '@keetapay/keetanet-client';
/*
 * We import this file to make sure that the `asn1js` types are
 * defined, since they are required by the `ASN1toJS` and `JStoASN1`
 */
import type * as _ignored_asn1js from 'asn1js';

const ASN1toJS: typeof KeetaNetClient.lib.Utils.ASN1.ASN1toJS = KeetaNetClient.lib.Utils.ASN1.ASN1toJS;
const JStoASN1: typeof KeetaNetClient.lib.Utils.ASN1.JStoASN1 = KeetaNetClient.lib.Utils.ASN1.JStoASN1;
const isValidSequenceSchema: typeof KeetaNetClient.lib.Utils.ASN1.isValidSequenceSchema = KeetaNetClient.lib.Utils.ASN1.isValidSequenceSchema;

export {
	ASN1toJS,
	JStoASN1,
	isValidSequenceSchema
};
