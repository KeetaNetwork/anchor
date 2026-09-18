# Services

## Abstract

Each Anchor service is a client, a server, and a common contract. The client looks up providers and signs HTTP calls. The server publishes metadata and serves those operations.

## Purpose

Read this page when adding a service or calling one. After reading, an engineer can place a type, a signable, or a route in the correct file.

## Related documents

- [Resolver](resolver.md) for lookup and metadata signatures.
- [Certificates](certificates.md) for the KYC share path.
- [Queue](queue.md) for staged server work.
- [Quickstart](../QUICKSTART.md) for first client construction.

## Three files, one contract

A service directory under `src/services/` typically holds `client.ts`, `server.ts`, and `common.ts`.

| File | Ownership |
| --- | --- |
| `common.ts` | Request and response types, signables, and guards. |
| `client.ts` | Resolver lookup, HTTP calls, and caller-facing objects. |
| `server.ts` | `KeetaAnchorMetadataServer` subclass, routes, and operator callbacks. |

`common.generated.ts` holds client-safe validators. `common.server.generated.ts` holds server-only request validators. A route handler does not own a signable.

The published client barrel exports `KYC`, `FX`, `AssetMovement`, `Username`, and `Notification`. `Storage` follows the same three-file split and is not on that barrel. See `src/client/index.ts`.

## Client path

A published client constructor takes a KeetaNet `UserClient` and an optional config. The config MAY supply `resolver`, `root`, `signer`, `account`, `logger`, and `id`.

The client calls `Resolver.lookup` with the service kind. It then builds one provider object per matching id. Provider methods fetch the operation URL and apply the metadata authentication rule.

`addSignatureToURL` in `src/lib/http-server/common.ts` writes `signed.nonce`, `signed.timestamp`, `signed.signature`, and `account`. A URL that already has those keys throws.

KYC is the exception that accepts a plain `Client` or a `UserClient`. The other published clients require a `UserClient`.

## Server path

Service servers extend `KeetaAnchorMetadataServer` in `src/lib/anchor-metadata-server.ts`, except the FX family which extends a shared FX HTTP base. The metadata server extends `KeetaNetAnchorHTTPServer` in `src/lib/http-server/index.ts`.

`buildServiceMetadata` publishes operations and optional legal fields. `metadataSigner` signs those fields when present. [Resolver](resolver.md) verifies that signature on lookup.

`KeetaNetAnchorHTTPServer` matches `METHOD /path` keys, supports `:param` and `/**`, and prefers an exact match over a wildcard. CORS `OPTIONS` routes are added for each path.

Authenticated routes MAY require an on-chain certificate chain. See [Certificates](certificates.md).

FX servers attach queue runners for staged exchange work. [Queue](queue.md) holds that contract.

## In-repository cookbooks

| Service | Client construction | Server construction |
| --- | --- | --- |
| KYC | `src/services/kyc/client.test.ts` | `KeetaNetKYCAnchorHTTPServer` in that test |
| Username | `src/services/username/client.test.ts` | `KeetaNetUsernameAnchorHTTPServer` in that test |
| FX | `src/services/fx/client.test.ts` | `src/services/fx/server.test.ts` |
| Asset movement | `src/services/asset-movement/server.test.ts` | `KeetaNetAssetMovementAnchorHTTPServer` |
| Notification | `src/services/notification/client.test.ts` | `src/services/notification/server.test.ts` |

Those tests compile in this repository. They are the complete source for request signing and metadata publication.

## Falsified by

A change to the published client namespaces, to the client versus `UserClient` constructors, to signed URL query fields, or to `KeetaAnchorMetadataServer` signed-field coverage.
