[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=KeetaPay_anchor&metric=coverage&token=628af58f03b821dbb0bb7e8f8104d0f3b832876d)](https://sonarcloud.io/summary/new_code?id=KeetaPay_anchor)

# Keeta Anchor

TypeScript reference SDK and client for KeetaNetwork Anchors. An Anchor bridges the KeetaNet ledger and a banking or payment system.

The documentation index is [docs/README.md](docs/README.md). To install the package and call a client, follow [docs/QUICKSTART.md](docs/QUICKSTART.md). How to write pages is [docs/STANDARD.md](docs/STANDARD.md). Architecture is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

A longer internal write-up remains on [Notion](https://www.notion.so/keeta/Anchor-Project-7fbb6ec93cb24c1cb52526857402197d). In-repository knowledge lives under `docs/`.

## Installation

Configure GitHub Packages for the `@keetanetwork` scope:

```sh
echo '@keetanetwork:registry=https://npm.pkg.github.com/' >> .npmrc
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> .npmrc
```

Set `GITHUB_TOKEN` to a GitHub personal access token with `read:packages`. Then install the package:

```sh
npm install @keetanetwork/anchor
```

## Repository setup

Install [nvm](https://github.com/nvm-sh/nvm), then install the project's Node version and dependencies:

```sh
nvm install
nvm use
make
```

Node is pinned to `24.14.1` in `package.json` `engines.node`. `make` writes `.nvmrc` from that pin.

## Testing

```sh
make test
```

`make help` lists the other targets. `make do-lint` runs the linters. `make dist` builds the publishable tree.

CI runs `make do-lint` and `make test` through `.github/workflows/nodejs.yml`. That workflow starts Postgres, Redis, and Firestore with `utils/enable-*-backend`. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the same local steps.

## Releasing

Publishing is automated via GitHub Actions:

- `publish-packages.yml` publishes the package tarball when `package.json` `version` changes on `main` / `releases/**`.
- `create-release.yml` creates a GitHub Release from a pushed `releases/v*` tag.

Use `make` targets in the `Makefile` to pack a local tarball.

## License

See [LICENSE](LICENSE).
