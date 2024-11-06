import keetapayConfig from '@keetapay/eslint-config-typescript';

export default [
	...keetapayConfig,
	{
		languageOptions: {
			parserOptions: {
				project: ['tsconfig.json']
			}
		}
	}
];
