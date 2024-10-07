import { defineConfig } from 'vitest/config'
import UnpluginTypia from '@ryoppippi/unplugin-typia/vite'

export default defineConfig({
	plugins: [
		UnpluginTypia()
	],
	test: {
		coverage: {
			reporter: ['lcov'],
			reportsDirectory: '.coverage',
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
