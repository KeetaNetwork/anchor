import { createIs } from 'typia';
import type {
	KeetaContractsAnchorUploadResponseJSON,
	KeetaContractsAnchorCallResponseJSON,
	KeetaContractsAnchorQueryResponseJSON,
	KeetaContractsAnchorContractResponseJSON,
	KeetaContractsAnchorProveResponseJSON,
	KeetaContractsAnchorSimulateResponseJSON
} from './common.ts';

export const isKeetaContractsAnchorUploadResponseJSON: (input: unknown) => input is KeetaContractsAnchorUploadResponseJSON = createIs<KeetaContractsAnchorUploadResponseJSON>();
export const isKeetaContractsAnchorCallResponseJSON: (input: unknown) => input is KeetaContractsAnchorCallResponseJSON = createIs<KeetaContractsAnchorCallResponseJSON>();
export const isKeetaContractsAnchorQueryResponseJSON: (input: unknown) => input is KeetaContractsAnchorQueryResponseJSON = createIs<KeetaContractsAnchorQueryResponseJSON>();
export const isKeetaContractsAnchorContractResponseJSON: (input: unknown) => input is KeetaContractsAnchorContractResponseJSON = createIs<KeetaContractsAnchorContractResponseJSON>();
export const isKeetaContractsAnchorProveResponseJSON: (input: unknown) => input is KeetaContractsAnchorProveResponseJSON = createIs<KeetaContractsAnchorProveResponseJSON>();
export const isKeetaContractsAnchorSimulateResponseJSON: (input: unknown) => input is KeetaContractsAnchorSimulateResponseJSON = createIs<KeetaContractsAnchorSimulateResponseJSON>();
