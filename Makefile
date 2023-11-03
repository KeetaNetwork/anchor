TS_FILES := $(shell find src -type f -name '*.ts')

# Default target
default: dist

# All targets
all: dist

node_modules/.done: Makefile package.json package-lock.json | basic-sanity
	rm -rf node_modules
	npm ci --include=dev
	touch node_modules/.done

BUILD_PREREQ := Makefile tsconfig.json node_modules

# Only consider the TypeScript compilation step done if it finishes successfully
dist/.done: $(BUILD_PREREQ) | basic-sanity
	rm -rf dist
	./utils/basic-sanity .
	npm run tsc
	touch dist/.done

dist: dist/.done
	true

runtime/.done: $(BUILD_PREREQ) | basic-sanity
	rm -rf runtime
	mkdir runtime
	TSUP_TARGET=runtime npx tsup
	touch runtime/.done

runtime: runtime/.done
	true

node_modules: node_modules/.done
	true

# Generated dependencies
Makefile.deps: utils/create-deps $(TS_FILES) Makefile
	./utils/create-deps src > Makefile.deps.new
	mv Makefile.deps.new Makefile.deps

include Makefile.deps

clean:
	rm -rf dist built runtime node_modules

distclean: clean
	rm -f Makefile.deps
	rm -rf .certificates
	rm -rf .coverage

basic-sanity: utils/basic-sanity
	./utils/basic-sanity .

do-lint: node_modules | basic-sanity
	npm run eslint src

do-test: do-lint node_modules | basic-sanity
	npm run test:coverage -- $(ANCHOR_TEST_ARGS)

.PHONY: default all clean distclean test basic-sanity do-lint do-test
