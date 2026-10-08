import { defineConfig } from 'vitest/config'
import UnpluginTypia from '@typia/unplugin/vite';

function isCI() {
	return(process.env.CI === 'true');
}

export default defineConfig({
	plugins: [
		UnpluginTypia()
	],
	test: {
		fsModuleCache: !isCI(),
		coverage: {
			reporter: ['lcov'],
			reportsDirectory: '.coverage',
			include: [
				'src/**/*.ts',
				'src/**/*.js'
			],
			exclude: [
				/*
				 * This file only contains a single function that is used to
				 * assert a never type -- it can never realistically be
				 * tested since it prevents compilation
				 */
				'src/lib/utils/never.*',
				/*
				 * Exclude test files from coverage since they are not
				 * part of the source code
				 */
				'src/**/*.test.ts'
			],
			enabled: true
		}
	}
})
