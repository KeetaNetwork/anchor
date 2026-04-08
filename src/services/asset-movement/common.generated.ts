import { createIs } from 'typia';
import type { FiatRails, MovableAssetSearchCanonical, Rail } from './common.js';

export const isMovableAssetSearchCanonical: (input: unknown) => input is MovableAssetSearchCanonical = createIs<MovableAssetSearchCanonical>();
export const isRail: (input: unknown) => input is Rail = createIs<Rail>();
export const isFiatRail: (input: unknown) => input is FiatRails = createIs<FiatRails>();
