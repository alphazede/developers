---
type: product-readme
title: BRAN
okf_status: active
tags:
  - public
  - developer
public_boundary: public
---

# BRAN

BRAN is the repository-intelligence product and its `bran` headless executable.

## Current Slice 1.1

Slice 1.1 provides a versioned, non-interactive `bran smoke` command, an exact-release manifest and verifier contract, and a public-boundary gate.

Build and test the current scaffold:

```sh
./tools/ci/check.sh --fast
```

Run the smoke command from the repository root:

```sh
cargo run --quiet --manifest-path bran/Cargo.toml --bin bran -- smoke
```

It writes exactly:

```json
{"version":"1","status":"ok"}
```

## Future release contract

No BRAN release is published by this scaffold. A supported future release must use an exact `bran-vX.Y.Z` tag and direct asset URLs rooted at:

```text
https://github.com/alphazede/developers/releases/download/bran-vX.Y.Z/
```

That release shape requires these five platform archives:

- `bran-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz`
- `bran-vX.Y.Z-aarch64-unknown-linux-gnu.tar.gz`
- `bran-vX.Y.Z-x86_64-apple-darwin.tar.gz`
- `bran-vX.Y.Z-aarch64-apple-darwin.tar.gz`
- `bran-vX.Y.Z-x86_64-pc-windows-msvc.zip`

It also requires `SHA256SUMS`, `SHA256SUMS.sig`, and `bran-release-manifest.json`. Generic `/releases/latest` URLs are unsupported.

For a published exact tag, the locked Cargo install form is:

```sh
cargo install --git https://github.com/alphazede/developers --tag bran-vX.Y.Z --locked bran-cli
```

## License

BRAN is licensed, at the recipient's choice, under either the Apache License 2.0 (see [LICENSE-APACHE](LICENSE-APACHE)) or the MIT license (see [LICENSE-MIT](LICENSE-MIT)).
