import { PhysicalAddress, Rail } from "../common.js";
import { ISOCountryCode } from "@keetanetwork/currency-info";

interface BaseBankAccountDetail<T extends string> {
    type: 'bank-account';
    accountType: T;

	accountAddress?: PhysicalAddress | string;
	obfuscated?: false;

	bankName?: string;

	accountOwner: {
		type: 'individual';
		firstName: string;
		lastName: string;
	} | {
		type: 'business';
		businessName: string;
	} | {
		type: 'unknown';
		beneficiaryName: string;
	}
}

interface BaseBankAccountDetailObfuscated<T extends string> {
    type: 'bank-account';
    accountType: T;
    obfuscated: true;

    accountOwner?: {
        type?: 'individual' | 'business';
        name?: string;
        businessName?: string;
    }

    bankName?: string;
    rail?: Rail;

    accountNumberEnding?: string;
}

/**
 * US Bank Account Types
 */
type USBankAccountType = 'checking' | 'savings';

interface USBankAccountDetailRaw extends BaseBankAccountDetail<'us'> {
	accountNumber: string;
	routingNumber: string;
	accountTypeDetail: USBankAccountType;
}

interface USBankAccountDetailObfuscated extends BaseBankAccountDetailObfuscated<'us'>  {
	routingNumber: string;
	accountTypeDetail?: USBankAccountType;
}

/**
 * iban-swift Bank Account Types
 */
interface IBANSwiftBankAccountDetailRaw extends BaseBankAccountDetail<'iban-swift'>  {
    country?: ISOCountryCode;

    accountNumber?: string;
    bic?: string;

    iban?: string;

    bankAddress?: PhysicalAddress;

    swift?: {
        category: string;
        purposeOfFunds: string[];
        businessDescription: string;
    }
}

interface IBANSwiftBankAccountDetailObfuscated extends BaseBankAccountDetailObfuscated<'iban-swift'> {
    country?: ISOCountryCode;
    bic?: string;
}

/**
 * CLABE Bank Account Types
 */
interface CLABEBankAccountDetailRaw extends BaseBankAccountDetail<'clabe'> {
	accountNumber: string;
}

interface CLABEBankAccountDetailObfuscated extends BaseBankAccountDetailObfuscated<'clabe'> {}

/**
 * PIX Bank Account Types
 */
interface PIXBankAccountDetailRaw extends BaseBankAccountDetail<'pix'> {
    document?: {
		type?: 'cpf' | 'cnpj';
		number: string;
	}
	brCode?: string;
	pixKey?: string;
}

interface PIXBankAccountDetailObfuscated extends BaseBankAccountDetailObfuscated<'pix'> {}

/**
 * Union Types
 */

type AllBankAccountDetailRaw =
    | USBankAccountDetailRaw
    | IBANSwiftBankAccountDetailRaw
    | CLABEBankAccountDetailRaw
    | PIXBankAccountDetailRaw;

type AllBankAccountDetailObfuscated =
    | USBankAccountDetailObfuscated
    | IBANSwiftBankAccountDetailObfuscated
    | CLABEBankAccountDetailObfuscated
    | PIXBankAccountDetailObfuscated;

type BankAccountType = AllBankAccountDetailRaw['accountType'];

export const locationConfiguration = {
    us: {
        supportedRails: ['ACH', 'ACH_DEBIT', 'WIRE', 'WIRE_INTL_PUSH'],
        supportedCurrencies: ['USD']
    },
    'iban-swift': {
        supportedRails: ['SEPA_PUSH', 'WIRE_INTL_PUSH'],
    },
    clabe: {
        supportedRails: ['SPEI_PUSH'],
        supportedCurrencies: ['MXN']
    },
    pix: {
        supportedRails: ['PIX_PUSH'],
        supportedCurrencies: ['BRL']
    }
} as const

// const __check = locationConfiguration satisfies {
//     [T in BankAccountType]: {
//         supportedRails?: Rail[];
//         supportedCurrencies?: ISOCurrencyCode[];
//     }
// };
