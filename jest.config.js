/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
	globals: { },
	testPathIgnorePatterns: [ '/node_modules/', '<rootDir>/dist'],
	testEnvironment: 'node',
	transform: {
		"^.+\\.tsx?$": [
			"esbuild-jest", {
				sourcemap: true
			}
		]
	},
	modulePaths: ['<rootDir>/src/'],
	collectCoverageFrom: [
		'src/**/*.ts',
		'!**/node_modules/**'
	],
	testTimeout: 20000,
	workerIdleMemoryLimit: 0.5,

	/**
	 * Configure Coverage, enabled with --coverage
	 */
	coverageDirectory: ".coverage",
	coverageReporters: [ "json", "lcov" ]
};
