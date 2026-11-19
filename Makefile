# This is the Makefile for the KeetaNetwork Anchor project.
# It is used to automate the build, test, and cleanup processes.
#
# It is the place where all automation tasks are defined -- not
# "package.json" (which just holds the references to NodeJS packages
# binaries).
#
# To get a list of targets run "make help".

# Dependencies vendored by commit hash. The tarball under "vendor/dynamic" is a
# build artifact and is not committed; the commit in the dependency string in
# "package.json" is the source of truth.
DYNAMIC_VENDOR_PACKAGES := $(shell jq -crM '( .dependencies + .devDependencies ) | .[] | select(match("file:vendor/dynamic/")) | sub("^file:"; "")' < package.json)
# Only these are shipped (bundled) in the package; vendored devDependencies
# are only installed for development
DYNAMIC_VENDOR_RUNTIME_PACKAGES := $(shell jq -crM '.dependencies | .[] | select(match("file:vendor/dynamic/")) | sub("^file:"; "")' < package.json)
DYNAMIC_VENDOR_KEETANET_NODE_REPO_URL := git@github.com:KeetaNetwork/node.git

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

# Builds the vendored KeetaNet Client and KeetaNet Node tarballs from a commit
# of the KeetaNet Node repository. The hash is read out of the target name,
# which is where "package.json" put it. Building the client also builds the
# Node package's "dist", so one build of the commit makes both (a pattern rule
# with two targets runs its recipe once for both).
#
# The client builds byte-for-byte the same from a commit, so its integrity
# hash is kept in the lock file. The Node package does not (the zip files in
# it carry build timestamps), so its integrity hash is removed from the lock
# file for npm to install whatever this builds.
vendor/dynamic/keetanetwork-keetanet-client-%.tgz vendor/dynamic/keetanetwork-keetanet-node-%.tgz:
	if [ "$$(jq -crM '.packages["node_modules/@keetanetwork/keetanet-node"].integrity' < package-lock.json)" != "null" ]; then \
		jq --tab 'del(.packages["node_modules/@keetanetwork/keetanet-node"].integrity)' < package-lock.json > package-lock.json.new && \
		mv package-lock.json.new package-lock.json; \
	fi
	mkdir -p vendor/dynamic
	rm -rf __TMP__KEETANET_NODE__
	mkdir __TMP__KEETANET_NODE__
	( cd __TMP__KEETANET_NODE__ && git clone --depth 1 '$(DYNAMIC_VENDOR_KEETANET_NODE_REPO_URL)' . && git fetch --depth 1 origin '$*' && git checkout FETCH_HEAD )
	$(MAKE) -C __TMP__KEETANET_NODE__ built/keetanet-clientlib.tar.gz
	mv __TMP__KEETANET_NODE__/built/keetanet-clientlib.tar.gz 'vendor/dynamic/keetanetwork-keetanet-client-$*.tgz.new'
	@# "dist" is already built, so skip the "prepack" script that builds it
	( cd __TMP__KEETANET_NODE__ && npm pack --ignore-scripts --pack-destination built )
	mv __TMP__KEETANET_NODE__/built/keetanetwork-keetanet-node-*.tgz 'vendor/dynamic/keetanetwork-keetanet-node-$*.tgz.new'
	rm -rf __TMP__KEETANET_NODE__
	tar -tf 'vendor/dynamic/keetanetwork-keetanet-client-$*.tgz.new' > /dev/null
	tar -tf 'vendor/dynamic/keetanetwork-keetanet-node-$*.tgz.new' > /dev/null
	mv 'vendor/dynamic/keetanetwork-keetanet-client-$*.tgz.new' 'vendor/dynamic/keetanetwork-keetanet-client-$*.tgz'
	mv 'vendor/dynamic/keetanetwork-keetanet-node-$*.tgz.new' 'vendor/dynamic/keetanetwork-keetanet-node-$*.tgz'

# This target creates the "node_modules" directory.
node_modules/.done: package.json package-lock.json Makefile $(DYNAMIC_VENDOR_PACKAGES)
	rm -rf node_modules
	npm clean-install
	@touch node_modules/.done

# Creates the "node_modules" directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
node_modules: node_modules/.done
	@touch node_modules

# Generated files for the KYC + Asset movement Service
GENERATED_FILES := src/services/kyc/iso20022.generated.ts src/services/kyc/oids.generated.ts src/services/asset-movement/lib/data/addresses/types.generated.ts src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts
src/services/kyc/oids.generated.ts: src/services/kyc/iso20022.generated.ts
src/services/kyc/iso20022.generated.ts: utils/run-ts src/services/kyc/utils/generate-kyc-schema.ts src/services/kyc/utils/oids.json node_modules
	./utils/run-ts ./src/services/kyc/utils/generate-kyc-schema.ts --oids-json=./src/services/kyc/utils/oids.json --oids-output=./src/services/kyc/oids.generated.ts --iso20022-output=./src/services/kyc/iso20022.generated.ts

src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts: utils/run-ts $(shell find src/services/asset-movement/lib/data/addresses/bank-account/ -type f ! -name '*.generated.ts') node_modules ./src/services/asset-movement/lib/data/scripts/generate-index.sh
	./src/services/asset-movement/lib/data/scripts/generate-index.sh src/services/asset-movement/lib/data/addresses/bank-account > ./src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts.tmp
	rm -f ./src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts
	mv ./src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts.tmp ./src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts

src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts: utils/run-ts $(shell find src/services/asset-movement/lib/data/addresses/mobile-wallet/ -type f ! -name '*.generated.ts') node_modules ./src/services/asset-movement/lib/data/scripts/generate-index.sh
	./src/services/asset-movement/lib/data/scripts/generate-index.sh src/services/asset-movement/lib/data/addresses/mobile-wallet > ./src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts.tmp
	rm -f ./src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts
	mv ./src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts.tmp ./src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts

src/services/asset-movement/lib/data/addresses/types.generated.ts: utils/run-ts $(shell find src/services/asset-movement/lib/data -type f ! -name '*.generated.ts') node_modules ./src/services/asset-movement/lib/data/addresses/bank-account/index.generated.ts ./src/services/asset-movement/lib/data/addresses/mobile-wallet/index.generated.ts ./src/services/asset-movement/lib/data/scripts/generator.ts
	./utils/run-ts ./src/services/asset-movement/lib/data/scripts/generator.ts --types-output=./src/services/asset-movement/lib/data/addresses/types.generated.ts

# This target creates the distribution directory.
dist/npm-shrinkwrap.json: package-lock.json package.json Makefile $(DYNAMIC_VENDOR_PACKAGES)
	mkdir -p dist
	@# The vendored tarballs are copied in for "npm shrinkwrap" to resolve,
	@# and listed in bundleDependencies for "do-npm-pack".  The bundle holds
	@# only the vendored packages themselves, so their dependencies are made
	@# dependencies of this package for npm to install.
	rm -rf dist/vendor
	mkdir -p dist/vendor/dynamic
	$(if $(DYNAMIC_VENDOR_RUNTIME_PACKAGES),cp $(DYNAMIC_VENDOR_RUNTIME_PACKAGES) dist/vendor/dynamic/)
	for tarball in $(DYNAMIC_VENDOR_RUNTIME_PACKAGES); do tar -xzOf "$$tarball" package/package.json || exit 1; done > dist/vendor-packages.json
	jq --slurpfile vendored dist/vendor-packages.json '. | del(.devDependencies) | del(.scripts.prepare) | .bundleDependencies = [.dependencies | to_entries[] | select(.value | startswith("file:vendor/dynamic/")) | .key] | .dependencies = (reduce $$vendored[] as $$package ({}; . + ($$package.dependencies // {})) + .dependencies) | .optionalDependencies = (reduce $$vendored[] as $$package ({}; . + ($$package.optionalDependencies // {})) + (.optionalDependencies // {})) | if .optionalDependencies == {} then del(.optionalDependencies) else . end' < package.json > dist/package.json
	rm -f dist/vendor-packages.json
	cp package-lock.json dist/
	test -e .npmrc && cp .npmrc dist/ || :
	cd dist && npm shrinkwrap
	cd dist && npm dedupe
	rm -f dist/.npmrc
	rm -f dist/package-lock.json
	jq --tab 'del(.. | .resolved?)' < dist/npm-shrinkwrap.json > dist/npm-shrinkwrap.json.new
	mv dist/npm-shrinkwrap.json.new dist/npm-shrinkwrap.json

dist/.done: $(shell find src -type f) $(GENERATED_FILES) dist/npm-shrinkwrap.json node_modules Makefile
	npm run tsc
	find dist -type f -name '*.test.*' | xargs rm -f
	rm -rf dist/lib/utils/tests
	cp LICENSE dist/
	@# Verify that "@keetanetwork/keetanet-node" is not listed in the
	@# distribution files
	@grep -r '@keetanetwork/keetanet-node' dist && (echo 'Error: @keetanetwork/keetanet-node should not be included in the distribution files' >&2; exit 1) || :
	@touch dist/.done

# Creates the distribution directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
dist: dist/.done
	@touch dist

# This is a synthetic target that creates a distributable
# package for this project.
#
# A registry install cannot resolve a "file:" dependency, so each vendored
# tarball is unpacked into dist/node_modules for the duration of "npm pack",
# which bundles it.
do-npm-pack: dist node_modules Makefile
	rm -rf dist/node_modules
	jq -crM '.dependencies | to_entries[] | select(.value | startswith("file:vendor/dynamic/")) | .key + " " + (.value | sub("^file:"; ""))' < dist/package.json | \
		while read -r name tarball; do \
			mkdir -p "dist/node_modules/$$name" && \
			tar -xzf "dist/$$tarball" -C "dist/node_modules/$$name" --strip-components=1 || exit 1; \
		done
	cd dist && npm pack
	rm -rf dist/node_modules
	mv dist/keetanetwork-anchor-*.tgz .

# Target for publishing to NPM
do-npm-publish: .npmrc do-npm-pack
	./utils/npm-check-logged-in .
	@if [ ! -e "$$(echo keetanetwork-anchor-*.tgz)" ] ; then \
		echo 'Package keetanetwork-anchor-*.tgz not found (maybe there is more than one?)' >&2 ; \
		exit 1; \
	fi
	npm publish ./keetanetwork-anchor-*.tgz

# Deploy the package to the Development (or QA) environment.
do-deploy: dist node_modules
	@echo 'not implemented'
	@exit 1

# This is a synthetic target that runs this test suite.
test: node_modules $(GENERATED_FILES)
	npm run tsc -- --noEmit
	rm -rf .coverage
	npm run vitest run -- --config ./.vitest.config.js $(ANCHOR_TEST_EXTRA_ARGS)

# Run linting
do-lint: node_modules $(GENERATED_FILES)
	unset $(shell locale | cut -f 1 -d =) && LC_ALL=C git grep '[^[:print:][:space:]]' && echo "Error: Found non-ASCII characters in the source code." && exit 1 || :
	npm run eslint -- --config .eslint.config.mjs ${KEETA_ANCHOR_LINT_ARGS}
	npm run cspell -- --config .cspell.config.mjs --no-progress 'src/**/*.ts'

# Files created during the "build" or "prepare" processes
# are cleaned up by the "clean" target.
#
# These files should also be added to the ".gitignore" file.
clean:
	rm -rf dist
	rm -rf .coverage
	rm -f .tsbuildinfo
	rm -f keetanetwork-anchor-*.tgz
	rm -f vendor/dynamic/*.new
	rm -f src/services/kyc/oids.generated.ts src/services/kyc/iso20022.generated.ts
	rm -f src/services/asset-movement/lib/data/addresses/*.generated.ts
	rm -f src/services/asset-movement/lib/data/addresses/*/*.generated.ts

# Files created during the "install" process are cleaned up
# by the "distclean" target.
#
# These files should also be added to the ".gitignore" file.
distclean: clean
	rm -rf node_modules
	rm -rf vendor/dynamic
	rm -f .nvmrc

.PHONY: all help test clean distclean do-npm-pack do-deploy do-lint
