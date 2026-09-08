import keetanetworkConfig from '@keetanetwork/eslint-config-typescript';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

/** @type {import('eslint').Linter.Config[]} */
export default [
	{
		ignores: ['**/*', '!src/**']
	},
	{
		ignores: fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf-8').split('\n').map(function(/** @type {string} */line) {
			if (line.startsWith('/src/')) {
				return(line.slice(1));
			}
			return(null);
		}).filter(function(/** @type {string | null} */line) {
			return(line !== null);
		})
	},
	...keetanetworkConfig,
	{
		// Prevent importing `KeetaNet` from the top-level client barrel. That barrel
		// re-exports every service client + the lib barrel, so pulling KeetaNet from it
		// creates a back-edge that makes the package non-tree-shakeable for SPA consumers.
		// Import KeetaNet directly from '@keetanetwork/keetanet-client' instead.
		// Tests are exempt since they are not shipped.
		files: ['src/**/*.ts'],
		ignores: ['**/*.test.ts', '**/test-utils.ts'],
		rules: {
			'no-restricted-imports': ['error', {
				patterns: [{
					group: ['**/client/index.js', '**/client/index'],
					importNames: ['KeetaNet'],
					message: "Import KeetaNet from '@keetanetwork/keetanet-client' directly, not the client/index barrel (it defeats tree-shaking)."
				}]
			}]
		}
	},
	{
		// Buffer is not available in browser environments. Import it from utils/buffer.js
		// (the polyfill re-export) instead of using the global or importing from 'buffer'.
		files: ['src/**/*.ts'],
		ignores: ['**/*.generated.ts'],
		rules: {
			'no-restricted-globals': ['error', {
				name: 'Buffer',
				message: "Import Buffer from 'utils/buffer.js' (e.g. './utils/buffer.js' or '../../lib/utils/buffer.js') instead of using the global Buffer."
			}],
			'no-restricted-imports': ['error', {
				paths: [{
					name: 'buffer',
					message: "Import Buffer from 'utils/buffer.js' instead of the 'buffer' package."
				}, {
					name: 'node:buffer',
					message: "Import Buffer from 'utils/buffer.js' instead of 'node:buffer'."
				}]
			}]
		}
	}
];
