/**
 * The environment contracts are built in when a build must be checkable:
 * a Docker image with every tool pinned, so the same source always gives
 * the same program, byte for byte, on any machine. A verifier rebuilds a
 * contract's source in it and compares the SHA-256 with the code hash the
 * network recorded when the contract was deployed.
 *
 * The image is defined here, not pulled from a registry: its tag is the
 * SHA-256 of this Dockerfile, so a verification names exactly the
 * environment it used, and anyone can build the same one.
 */
import { createHash } from 'node:crypto';

/** The Anza (Agave) release whose `cargo-build-sbf` builds contracts. */
export const AGAVE_VERSION = 'v4.3.2';

/** The platform tools (`rustc` and LLVM for sBPF) it builds with. */
export const PLATFORM_TOOLS_VERSION = 'v1.57';

/** Builds are for one platform, so their output does not depend on the host's. */
export const BUILD_PLATFORM = 'linux/amd64';

/** Where the source is put inside the container: the same path everywhere, as builds may embed it. */
export const BUILD_SOURCE_DIR = '/build';

export const BUILD_DOCKERFILE: string = [
	'# keeta-contract verifiable build environment',
	'FROM rust@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1',
	'ENV DEBIAN_FRONTEND=noninteractive',
	'RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates curl git && rm -rf /var/lib/apt/lists/*',
	`RUN sh -c "$(curl -sSfL https://release.anza.xyz/${AGAVE_VERSION}/install)"`,
	'ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"',
	'# Fetch the platform tools into the image, so builds do not download them',
	'RUN cargo new --lib /tmp/warm && cd /tmp/warm \\',
	'\t&& printf \'[lib]\\ncrate-type = ["cdylib"]\\n\' >> Cargo.toml \\',
	`\t&& cargo-build-sbf --arch v3 --tools-version ${PLATFORM_TOOLS_VERSION} \\`,
	'\t&& rm -rf /tmp/warm',
	`WORKDIR ${BUILD_SOURCE_DIR}`,
	''
].join('\n');

/** The image's tag: the SHA-256 of the Dockerfile, so it names its environment exactly. */
export function buildImageTag(): string {
	return(`keeta-contract-build:${createHash('sha256').update(BUILD_DOCKERFILE).digest('hex').slice(0, 16)}`);
}
