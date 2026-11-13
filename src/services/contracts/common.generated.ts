import { createIs } from 'typia';
import type {
	KeetaContractsAnchorSubmitResponseJSON
} from './common.ts';

export const isKeetaContractsAnchorSubmitResponseJSON: (input: unknown) => input is KeetaContractsAnchorSubmitResponseJSON = createIs<KeetaContractsAnchorSubmitResponseJSON>();
