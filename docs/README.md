# Documentation Standard

## Abstract

This page is the documentation contract for `@keetanetwork/anchor`. It states what belongs in a documentation page. It also fixes the prose, the register, and the page shape.

## Purpose

Read this page before you write or review documentation in this repository. After reading you can tell whether a page belongs in the tree. You can also write it in the expected prose and shape.

## Requirements Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) [RFC 8174](https://datatracker.ietf.org/doc/html/rfc8174) when, and only when, they appear in all capitals, as shown here.

This page is the one home for that declaration. Other pages in this tree MAY use those keywords under this home. They MUST NOT repeat this section.

## The inclusion test

Documentation earns its maintenance cost by holding the knowledge that lives outside any one file. A page MUST carry at least one of the following.

- An invariant that spans several files, which puts it beyond the reach of a single file.
- A decision and the alternative it rejected, so a later reader keeps it closed.
- A contract that binds consumer behavior, such as a protocol format or an ordering requirement.
- A procedure an operator runs under pressure.

A page MUST NOT carry the following. The source is the one correct home for each one.

- Barrel maps, export lists, or directory listings.
- Field tables that repeat the API comments without adding protocol or operator semantics.
- Inventories of internal routes or error codes that the source already enumerates.
- A decision log or a changelog of past reviews.

Public protocol references MAY enumerate routes, fields, and error codes because those details bind consumers at the protocol boundary.

One body of knowledge takes one page as its home. A second page that needs it MUST link to that home rather than restate it. This page names the audience of every other page.

When you must name a symbol, cite it as `Symbol` in `path/to/file` and let the source carry its own detail.

## Prose

Use the working subset below. Write full sentences, and keep their articles. Keep one topic in a sentence. Use the active voice and the present tense.

Use the exact technical noun, in code font, on every mention of the same thing. Use the ASCII hyphen only, and write each relation as words. Prefer a table, a list, or a diagram whenever it reorganizes substance.

Each register addresses its reader differently, and a page MUST hold one register throughout.

| Register | Reader | Voice |
| --- | --- | --- |
| Concept | An engineer building a model of the system | Third person, declarative |
| Implementation | An engineer integrating the software into a service | Second person, imperative |
| Operations | An operator under time pressure | Second person, imperative, one action per step |
| Reference | An engineer checking an exact contract | Third person, terse, declarative |

## Page shape

Every page under `docs/**` MUST carry the following sections, in the following order.

1. **Title.** The subject of the page, as a noun phrase.
2. **Abstract.** Two or three sentences on what the page holds.
3. **Purpose.** Who reads the page, and what they can do afterward.
4. **Body.** The sections that carry the content, which SHOULD sit in the correct dependency order.
5. **Falsified by.** The changes that make the page wrong.

The closing section is the maintenance contract. It MUST name the code changes that invalidate the page.

A page SHOULD cite the test that encodes an invariant when that test is the enforcement point. One citation replaces a prose argument that the guarantee holds.

The package `README.md` MAY stay a thin pointer. It does not use this page shape.

## Pages in this tree

| Page | Audience | Register |
| --- | --- | --- |
| [Overview](OVERVIEW.md) | A new engineer in the first week | Concept |
| [Architecture](architecture.md) | An engineer who needs cross-file invariants | Concept |
| [Quickstart](QUICKSTART.md) | An engineer who installs the package and calls a client | Implementation |
| [Resolver](concepts/resolver.md) | An engineer who traces service discovery | Concept |
| [Certificates](concepts/certificates.md) | An engineer who shares KYC attributes | Concept |
| [Encrypted containers](concepts/encrypted-containers.md) | An engineer who encrypts bytes to principals | Concept |
| [Signed URLs](concepts/signed-urls.md) | An engineer who traces HTTP query signatures | Concept |
| [Queue](concepts/queue.md) | An engineer who persists staged work | Concept |
| [Status](concepts/status.md) | An engineer who reads transfer status | Concept |
| [History](concepts/history.md) | An engineer who folds on-chain history | Concept |
| [Services](concepts/services.md) | An engineer who adds or calls a service | Concept |

## Falsified by

A change to the prose contract, to the inclusion test, to the page shape, or to the published page map above.
