# Copilot Instructions for KeetaNetwork Anchor

## Build System

This repository uses **Make** as the primary interface for all build, test, and automation tasks. Do not run npm scripts directly - always use the corresponding `make` targets instead.

### Common Make Targets

- `make help` - Display all available targets
- `make all` - Build the entire project (creates dist directory)
- `make test` - Run the test suite
- `make do-lint` - Run ESLint on the project source
- `make clean` - Remove build artifacts
- `make distclean` - Remove all build artifacts and dependencies

### Running Tests

To run tests, use:
```bash
make test
```

You can pass extra arguments to the test suite using the `ANCHOR_TEST_EXTRA_ARGS` variable:
```bash
make test ANCHOR_TEST_EXTRA_ARGS="--run --reporter=verbose"
```

### Running Linter

To run the linter, use:
```bash
make do-lint
```

## GitHub Package Registry Authentication

This project depends on packages from the GitHub Package Registry (@keetanetwork scope). To authenticate:

1. **Set the GITHUB_TOKEN environment variable**: This token must have `read:packages` permission
2. **Configure .npmrc**: The repository includes a `.npmrc` file that references the GitHub Package Registry. When running locally or in CI, ensure the authentication token is configured.

The CI workflow automatically sets up authentication using:
```bash
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> ~/.npmrc
```

If you need to install dependencies locally, ensure your `GITHUB_TOKEN` is set and properly configured in your `.npmrc` file.

## Project Structure

- `src/` - TypeScript source code
- `dist/` - Build output (created by `make dist`)
- `utils/` - Utility scripts
- `.vitest.config.js` - Vitest configuration for testing
- `.eslint.config.mjs` - ESLint configuration
- `tsconfig.json` - TypeScript configuration

## Development Workflow

1. Install dependencies: Dependencies are automatically installed when running `make` targets
2. Make your changes in the `src/` directory
3. Run linter: `make do-lint`
4. Run tests: `make test`
5. Build the project: `make dist`

## Important Notes

- **Always use `make` commands** instead of running npm scripts directly
- The project uses TypeScript and requires Node.js version specified in `package.json` (20.18.0)
- The `.nvmrc` file is automatically generated from `package.json`
- Generated files for KYC service are created automatically during the build process
- Do not commit `node_modules/`, `dist/`, or other build artifacts (they're in `.gitignore`)
