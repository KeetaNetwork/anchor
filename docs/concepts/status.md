# Status

## Abstract

Transfer status has one standardized settled value: `COMPLETE`. This page is the home for that contract, for the status cache, and for the on-chain external envelope that names a transfer.

## Purpose

Read this page when a wallet and a provider disagree on whether a transfer settled. After reading, an engineer can name the type that carries the status and the rule that cached it.

## Related documents

- [History](history.md) for how status projects into logical transactions.
- [Resolver](resolver.md) for finding the provider that serves an anchor.
- [Services](services.md) for asset-movement and FX clients.

## Standardized status

`StandardizedTransferStatus` in `src/lib/anchor-status.ts` carries a provider status string, a `transactionID`, and the source record.

`isCompletedTransferStatus` returns true only for the string `COMPLETE`. Other strings stay provider-specific.

`AnchorTransactionStatus.getStatus` reads through an `AnchorStatusSource`. A missing reader returns `null`.

When a cache is present, a `COMPLETE` result is stored under `anchorPublicKey:transactionID`. A non-complete result is not stored. `src/lib/anchor-status.test.ts` counts reader calls to prove that cache rule.

`CompositeAnchorStatusSource` returns the first reader that serves the anchor.

## On-chain envelopes

`AnchorExternal` in `src/lib/anchor-external.ts` decodes the `external` field on a SEND operation. Per-anchor entries are keyed by account public key.

An entry MAY carry `transactionId`, `persistentForwardingId`, or `destination`. `getStatusesFromExternal` on `AnchorTransactionStatus` reads each entry.

| Result kind | Meaning |
| --- | --- |
| `status` | A status was read. |
| `unavailable` | The entry has no `transactionId`. |
| `unresolved` | No reader served the anchor. |
| `error` | Decode or read failed. The captured error is included. |

A signed envelope MAY bind to `previousBlockHash` and `operationIndex`. Inputs are backward links to earlier operations. History uses those links. See [History](history.md).

## Provider adapters

`KeetaAssetMovementStatusSource` in `src/services/asset-movement/status-source.ts` maps `KeetaAssetMovementTransaction.status` through without rewriting it. `findByOnChain` lists transactions at `chain:keeta:<networkID>`.

`KeetaFXStatusSource` in `src/services/fx/status-source.ts` maps a completed FX exchange to status `COMPLETE`. History then classifies the pair as a swap.

`KeetaAssetMovementTransaction.status` in `src/services/asset-movement/common.ts` is an open string. The asset-movement server chooses its vocabulary. Only `COMPLETE` is settled at this layer.

## Falsified by

A change to `isCompletedTransferStatus`, to the cache-only-on-`COMPLETE` rule, to `getStatusesFromExternal` result kinds, or to the FX completed-status mapping.
