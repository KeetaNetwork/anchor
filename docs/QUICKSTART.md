# Quickstart

## Abstract

This guide shows you how to install `@keetanetwork/anchor` and call a published service client. It covers the Node pin, Make targets, resolver roots, and first use of `Username` and `KYC`.

## Purpose

Use this guide when you add the package to an application, or when you run the repository tests. After reading, you can place install, build, and first-call steps at their correct boundary.

## Install the package

Configure GitHub Packages for the `@keetanetwork` scope.

```sh
echo '@keetanetwork:registry=https://npm.pkg.github.com/' >> .npmrc
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> .npmrc
```

Set `GITHUB_TOKEN` to a GitHub personal access token with `read:packages`. Then install the package.

```sh
npm install @keetanetwork/anchor
```

The package entry is `client/index.js`. Import the published namespaces from `@keetanetwork/anchor`.

## Set up this repository

Install [nvm](https://github.com/nvm-sh/nvm). Then install the Node version from `package.json` `engines.node` and the dependencies.

```sh
make
```

`make` writes `.nvmrc` from that pin and builds `dist`. The current pin is Node `24.14.1`.

Use Make as the build interface.

| Target | Action |
| --- | --- |
| `make help` | Print the target list. |
| `make` or `make all` | Install dependencies, generate files, and build `dist`. |
| `make test` | Typecheck, then run Vitest. |
| `make do-lint` | Run the ASCII check, ESLint, and cspell on `src/**/*.ts`. |
| `make dist` | Build the publishable tree. |
| `make clean` | Remove build artifacts. |
| `make distclean` | Remove artifacts and `node_modules`. |

Pass extra Vitest flags through `ANCHOR_TEST_EXTRA_ARGS`.

```sh
make test ANCHOR_TEST_EXTRA_ARGS="--reporter=verbose"
```

## Start optional test backends

CI starts Postgres, Redis, and Firestore before `make test`. Queue driver suites skip a backend when its `ANCHOR_TESTING_*` variables are unset. See `src/lib/queue/index.test.ts`.

1. Confirm Docker is running.
2. Evaluate the enable script you need.

```sh
eval "$(./utils/enable-postgres-backend)"
eval "$(./utils/enable-redis-backend)"
eval "$(./utils/enable-firestore-backend)"
```

3. Run `make test`.
4. Stop the containers when you finish.

```sh
eval "$(./utils/enable-postgres-backend off)"
eval "$(./utils/enable-redis-backend off)"
eval "$(./utils/enable-firestore-backend off)"
```

Each `on` script prints `export` lines. Each `off` script prints `unset` lines and stops the container.

## Construct a client

Every published client takes a KeetaNet `UserClient` and an optional config. If you omit `resolver`, the client calls `getDefaultResolver` in `src/config.ts`. That helper uses the network account as `root` unless you pass `root` or `network`.

In-repository tests publish metadata on a local account. They pass that account as `root`. Follow that pattern in a local node test. Follow the default network root in a public-network app.

The happy-path excerpts below use the published namespaces. Complete flows live in the cited tests.

```typescript
import { KYC, Username, lib, KeetaNet } from '@keetanetwork/anchor';
```

`KeetaNet` is `@keetanetwork/keetanet-client`. `lib` is the published library barrel.

## Resolve a username

A globally identifiable username is `name$providerID`. `formatGloballyIdentifiableUsername` in `src/services/username/common.ts` builds that string.

```typescript
const usernameClient = new Username.Client(userClient, {
	root: providerAccount,
	signer: claimantAccount,
	account: claimantAccount
});

const provider = await usernameClient.getProvider(providerID);
if (provider === null) {
	throw(new Error(`Username provider ${providerID} not found`));
}

const resolved = await usernameClient.resolve(`alice$${providerID}`);
```

`src/services/username/client.test.ts` constructs the same client, publishes resolver metadata, and claims a name. Read that test for claim, release, transfer, and search.

## Start a KYC verification

```typescript
const kycClient = new KYC.Client(userClient, {
	root: account
});

const countries = await kycClient.getSupportedCountries();
const providers = await kycClient.createVerification({
	countryCodes: ['US'],
	account: account
});

const provider = providers[0];
if (provider === undefined) {
	throw(new Error('No KYC providers returned'));
}

const verification = await provider.startVerification();
```

`src/services/kyc/client.test.ts` starts `KeetaNetKYCAnchorHTTPServer`, publishes metadata through `Resolver.Metadata.formatMetadata`, and reads certificates. Read that test for the server side.

## Call FX or asset movement

Construct `FX.Client` or `AssetMovement.Client` the same way. Pass a `UserClient` and an optional `root` or `resolver`. Then look up providers and call the operation the metadata advertises.

`src/services/fx/client.test.ts` and `src/services/asset-movement/server.test.ts` are the in-repository cookbooks. [Services](concepts/services.md) holds the client, server, and common split.

`Storage` follows the same client pattern under `src/services/storage/client.ts`. It is not exported from `src/client/index.ts`. Import it only from that path inside this repository.

## Read status and history

Build an `AnchorTransactionStatus` from a status source when you need a provider-independent read. `KeetaAssetMovementStatusSource` in `src/services/asset-movement/status-source.ts` and `KeetaFXStatusSource` in `src/services/fx/status-source.ts` implement `AnchorStatusSource`.

```typescript
const status = new lib.AnchorTransactionStatus(source);
const result = await status.getStatus(anchor, transactionID);
```

`UserHistory` in `src/lib/history.ts` folds blocks and optional enrichment. [Status](concepts/status.md) and [History](concepts/history.md) hold those contracts.

## Falsified by

A change to the published client constructors, to `getDefaultResolver` root selection, to the Make targets, to the Node engine pin, or to the enable-script environment variables.
