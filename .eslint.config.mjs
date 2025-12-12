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
	...keetanetworkConfig
];
