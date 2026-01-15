/**
 * CSpell configuration for KeetaNetwork Anchor
 * 
 * This configuration attempts to import words from the keetanet-node package
 * if available, falling back to a basic configuration if not.
 */

let keetanetNodeWords = [];
let keetanetNodeIgnoreRegExpList = [];

// Try to import the cspell config from keetanet-node if it exists in the source
try {
	const keetanetNodeConfig = await import('@keetanetwork/keetanet-node/cspell.config.js');
	if (keetanetNodeConfig.default && keetanetNodeConfig.default.words) {
		keetanetNodeWords = keetanetNodeConfig.default.words;
	}
	if (keetanetNodeConfig.default && keetanetNodeConfig.default.ignoreRegExpList) {
		keetanetNodeIgnoreRegExpList = keetanetNodeConfig.default.ignoreRegExpList;
	}
} catch (e) {
	// If import fails, we'll use the base configuration below
	console.warn('Could not import cspell config from @keetanetwork/keetanet-node, using base configuration');
}

/** @type { import("@cspell/cspell-types").CSpellUserSettings } */
export default {
	language: 'en',
	dictionaries: ['english', 'typescript', 'softwareTerms'],
	words: [
		...keetanetNodeWords,
		// Anchor-specific words
		'Anchor',
		'Anchorlist',
		'ACCOUNTOWNERS',
		'ASSETMOVEMENT',
		'autorun',
		'backoff',
		'BYTEA',
		'certutil',
		'ciphertext',
		'cjson',
		'clabe',
		'CLABE',
		'cnpj',
		'datagrams',
		'decryptable',
		'ECDSA',
		'eddsa',
		'EURC',
		'Externalizable',
		'FINALOUT',
		'futoin',
		'HTTPSURL',
		'iban',
		'inspectable',
		'iso20022',
		'Keeta',
		'keetaencryptedcontainerv',
		'KeetaNet',
		'keetanetwork',
		'KEETATEST',
		'KYCCA',
		'localnode',
		'Millis',
		'multiworker',
		'MWSBBIFBO',
		'nanos',
		'neginf',
		'notanumber',
		'OIDDB',
		'oids',
		'oldstatus',
		'Oldsmar',
		'postamble',
		'promiseerror',
		'Retryable',
		'retval',
		'secp',
		'SEPA',
		'singleworker',
		'Solana',
		'solana',
		'SOLANA',
		'SPEI',
		'subpartition',
		'subsubpartition',
		'testpromise',
		'testpromiseabort',
		'timedout',
		'Toctou',
		'toctou',
		'TODOC',
		'typia',
		'unenumerable',
		'Ungreeted',
		'unknownaction',
		'unmarshall',
		'unvalidated',
		'upsert',
		'upserts',
		'valuize',
		'Valuizable',
		'Valuize',
		'VALUIZABLE',
		'Verifable',
		'wrongpath'
	],
	flagWords: [
		'recieve'
	],
	ignoreRegExpList: [
		...keetanetNodeIgnoreRegExpList,
		'/(keeta|tyblocks)_a[a-zA-Z0-9]*/g',
		'/@ts-nocheck/',
		'/inboundws:\/\//',
		'import\\s+.*\\s+from\\s+["\'].+["\'];?',
		'/@\w*\/\w*/',
		'/0[xX][0-9a-fA-F]+n/', // hex BigInt
		'/0[bB][01]+n/',	// binary BigInt
		'/0[oO][0-7]+n/', // octal BigInt
		'/\\b\\d+n\\b/' // decimal BigInt
	],
	overrides: [
		{
			filename: 'src/services/kyc/**/*.ts',
			words: [
				'iso20022',
				'ACCOUNTINFO',
				'oids'
			]
		},
		{
			filename: 'src/lib/queue/**/*.ts',
			words: [
				'dequeue',
				'enqueue'
			]
		},
		{
			filename: '**/*.test.ts',
			words: [
				'Belgrave',
				'vitest'
			]
		}
	],
	useGitignore: true
};
