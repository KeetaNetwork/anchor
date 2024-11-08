# This is the Makefile for the KeetaPay Anchor project.
# It is used to automate the build, test, and cleanup processes.
#
# It is the place where all automation tasks are defined -- not
# "package.json" (which just holds the references to NodeJS packages
# binaries).
#
# To get a list of targets run "make help".

# The default target -- makes the "dist" directory.
all: dist

# This target provides a list of targets.
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all           - Builds the project"
	@echo "  dist          - Builds the project"
	@echo "  test          - Runs the test suite"
	@echo "                  Specify extra flags with ANCHOR_TEST_EXTRA_ARGS"
	@echo "  clean         - Removes build artifacts"
	@echo "  distclean     - Removes all build artifacts and dependencies"
	@echo "  do-deploy     - Deploys the package to the Development (or QA) environment"
	@echo "  do-npm-pack   - Creates a distributable package for this project"

# This is a temporary measure, as needed, for developing alongside the
# KeetaNet Node project.
#
# Create the KeetaNet Node and KeetaNet Client packages from the
# Git hash specified
vendor/keetanet-node-%.tgz: KEETANET_NODE_COMMIT=$(shell echo "$@" | sed 's@^.*-@@;s@\.tgz$$@@')
vendor/keetanet-node-%.tgz: KEETANET_NODE_WORKDIR:=$(shell mktemp -u)
vendor/keetanet-node-%.tgz:
	@mkdir -p vendor
	@echo 'Building KeetaNet Node package from Commit $(KEETANET_NODE_COMMIT)'
	mkdir -p '$(KEETANET_NODE_WORKDIR)'
	git clone --no-checkout git@github.com:KeetaPay/node.git '$(KEETANET_NODE_WORKDIR)'
	cd '$(KEETANET_NODE_WORKDIR)' && git checkout $(KEETANET_NODE_COMMIT)
	cd '$(KEETANET_NODE_WORKDIR)' && make built/keetanet-clientlib.tar.gz
	cd '$(KEETANET_NODE_WORKDIR)' && npm pack
	mv '$(KEETANET_NODE_WORKDIR)'/keetapay-keetanet-node-*.tgz '$@.new'
	mv '$(KEETANET_NODE_WORKDIR)'/built/keetanet-clientlib.tar.gz vendor/keetanet-client-$(KEETANET_NODE_COMMIT).tgz.new
	cd '$(KEETANET_NODE_WORKDIR)' && cd .. && rm -rf '$(KEETANET_NODE_WORKDIR)'
	mv vendor/keetanet-client-$(KEETANET_NODE_COMMIT).tgz.new vendor/keetanet-client-$(KEETANET_NODE_COMMIT).tgz
	mv '$@.new' '$@'

vendor/keetanet-client-%.tgz: vendor/keetanet-node-%.tgz
	touch '$@'

# This target creates the "node_modules" directory.
node_modules/.done: package.json package-lock.json Makefile $(shell jq -crM '.dependencies | .[] | match("^file:(vendor/.*)") | .captures[0].string' < package.json)
	rm -rf node_modules
	npm clean-install
	@# TEMPORARY -- The Rust ASN1 library is not yet up-to-date
	rm -f node_modules/@keetapay/asn1-napi-rs/*.node
	@touch node_modules/.done

# Creates the "node_modules" directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
node_modules: node_modules/.done
	@touch node_modules

# This target creates the distribution directory.
dist/.done: $(shell find src -type f) node_modules Makefile
	npm run tsc
	cp package.json dist/
	cp package-lock.json dist/npm-shrinkwrap.json
	find dist -type f -name '*.test.*' | xargs rm -f
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
	mv dist/keetapay-anchor-*.tgz .

# Deploy the package to the Development (or QA) environment.
do-deploy: dist node_modules
	@echo 'not implemented'
	@exit 1

# This is a synthetic target that runs this test suite.
test: node_modules
	rm -rf .coverage
	npm run vitest run -- --config ./.vitest.config.js $(ANCHOR_TEST_EXTRA_ARGS)

# Files created during the "build" or "prepare" processes
# are cleaned up by the "clean" target.
#
# These files should also be added to the ".gitignore" file.
clean:
	rm -rf dist
	rm -rf .coverage
	rm -f .tsbuildinfo
	rm -f keetapay-anchor-*.tgz

# Files created during the "install" process are cleaned up
# by the "distclean" target.
#
# These files should also be added to the ".gitignore" file.
distclean: clean
	rm -rf node_modules

# Delete anything that is not part of the project.
mrproper: distclean
	rm -rf vendor

.PHONY: all help test clean distclean do-npm-pack do-deploy
