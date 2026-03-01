import { createAssert, createIs } from "typia";
import type { BankAccountType, MobileWalletAccountType, PickChainLocation } from "./location.js";

export const isTronNetworkAlias: (input: unknown) => input is PickChainLocation<'tron'>['chain']['networkAlias'] = createIs<PickChainLocation<'tron'>['chain']['networkAlias']>();
export const assertBankAccountType: (input: unknown) => BankAccountType = createAssert<BankAccountType>();
export const assertMobileWalletAccountType: (input: unknown) => MobileWalletAccountType = createAssert<MobileWalletAccountType>();
