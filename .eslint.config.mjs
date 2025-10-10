import keetanetworkConfig from '@keetanetwork/eslint-config-typescript';
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
	...keetanetworkConfig,
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parser: (await import('@typescript-eslint/parser')).default,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module'
			}
		},
		plugins: {
			'@typescript-eslint': tseslint
		}
	}
];