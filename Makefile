# This is the Makefile for the KeetaNetwork Anchor project.
# It is used to automate the build, test, and cleanup processes.
#
# It is the place where all automation tasks are defined -- not
# "package.json" (which just holds the references to NodeJS packages
# binaries).
#
# To get a list of targets run "make help".

# The default target -- makes the "dist" directory
# and creates a ".nvmrc" file.
all: dist .nvmrc

# This target provides a list of targets.
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all           - Builds the project"
	@echo "  dist          - Builds the distribution directory"
	@echo "  do-lint       - Runs eslint on the project source"
	@echo "  test          - Runs the test suite"
	@echo "                  Specify extra flags with ANCHOR_TEST_EXTRA_ARGS"
	@echo "  clean         - Removes build artifacts"
	@echo "  distclean     - Removes all build artifacts and dependencies"
	@echo "  do-deploy     - Deploys the package to the Development (or QA) environment"
	@echo "  do-npm-pack   - Creates a distributable package for this project"

# Create a ".nvmrc" file if it does not exist
.nvmrc: package.json Makefile
	rm -f .nvmrc .nvmrc.new
	jq -rM '"v" + .engines.node' < package.json > .nvmrc.new
	mv .nvmrc.new .nvmrc

# This target creates the "node_modules" directory.
node_modules/.done: package.json package-lock.json Makefile
	rm -rf node_modules
	npm clean-install
	@touch node_modules/.done

# Creates the "node_modules" directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
node_modules: node_modules/.done
	@touch node_modules

# This target creates the distribution directory.
dist/npm-shrinkwrap.json: package-lock.json package.json Makefile
	mkdir -p dist
	jq '. | del(.devDependencies)' < package.json > dist/package.json
	cp package-lock.json dist/
	test -e .npmrc && cp .npmrc dist/
	cd dist && npm shrinkwrap
	cd dist && npm dedupe
	rm -f dist/.npmrc
	rm -f dist/package-lock.json
	sed '/"resolved":/d' dist/npm-shrinkwrap.json > dist/npm-shrinkwrap.json.new
	jq --tab . < dist/npm-shrinkwrap.json.new > /dev/null
	mv dist/npm-shrinkwrap.json.new dist/npm-shrinkwrap.json

dist/.done: $(shell find src -type f) dist/npm-shrinkwrap.json node_modules Makefile
	npm run tsc
	find dist -type f -name '*.test.*' | xargs rm -f
	rm -rf dist/lib/utils/tests
	cp LICENSE dist/
	@touch dist/.done

# Creates the distribution directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
dist: dist/.done
	@touch dist

# This is a synthetic target that creates a distributable
# package for this project.
do-npm-pack: dist node_modules
	cd dist && npm pack
	mv dist/keetanetwork-anchor-*.tgz .

# Deploy the package to the Development (or QA) environment.
do-deploy: dist node_modules
	@echo 'not implemented'
	@exit 1

# This is a synthetic target that runs this test suite.
test: node_modules
	rm -rf .coverage
	npm run vitest run -- --config ./.vitest.config.js $(ANCHOR_TEST_EXTRA_ARGS)

# Run linting
do-lint: node_modules
	npm run eslint -- --config .eslint.config.mjs src ${KEETA_ANCHOR_LINT_ARGS}

# Files created during the "build" or "prepare" processes
# are cleaned up by the "clean" target.
#
# These files should also be added to the ".gitignore" file.
clean:
	rm -rf dist
	rm -rf .coverage
	rm -f .tsbuildinfo
	rm -f keetanetwork-anchor-*.tgz

# Files created during the "install" process are cleaned up
# by the "distclean" target.
#
# These files should also be added to the ".gitignore" file.
distclean: clean
	rm -rf node_modules
	rm -f .nvmrc

.PHONY: all help test clean distclean do-npm-pack do-deploy
