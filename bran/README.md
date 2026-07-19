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

![BRAN seated between two ravens beneath the memory tree](assets/brand/bran-repository-raven.png)

BRAN is a local repository-intelligence engine with a headless `bran` executable
and an optional terminal interface. Deterministic repository scanning, focused
packets, validation, and offline browsing do not require an agent account.

## Build and try it

Build and test the current scaffold:

```sh
./tools/ci/check.sh --fast
```

Run the smoke command from the repository root:

```sh
cargo run --quiet --manifest-path bran/Cargo.toml --bin bran -- smoke
```

It writes a versioned JSON envelope. Start the TUI with:

```sh
cargo run --quiet --manifest-path bran/Cargo.toml --bin bran -- tui
```

First-run onboarding shows requested and effective settings for offline mode,
SQZ, connected-agent mode, voice, structured history, and saved chat. A missing
capability remains visible as unavailable; BRAN does not simulate it. The safe
default is offline, read-only, zero-conversation retention. The configurable
connected-task total-token ceiling defaults to exactly 8,500. It is a requested
host limit until a connected adapter can attest enforcement.

After onboarding, inspect local readiness without contacting an account:

```sh
bran doctor --onboarding
bran doctor --agent
bran agents list
```

Both doctor modes are read-only. Their envelopes report unavailable capability
and attestation fields explicitly and include zero provider, auth, and network
call metrics. Agent doctor exits with validation status until connected runtime
and host attestation are effective, even when `local_setup_ready` is true. See
[Agent setup](docs/integrations/agent-setup.md) for the two
supported setup journeys, reasoning/tool recipes, no-session operation, and the
offline-return check. Install the public agent instructions from
[`skill/use-bran`](skill/use-bran/SKILL.md) when an external agent host should
call BRAN.

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

The fixed release assets are the five archives, `SHA256SUMS`, `SHA256SUMS.sig`, and `bran-release-manifest.json`.

- Provenance lives in `bran-release-manifest.json`.
- Separate SBOM evidence is unavailable in this readiness workflow and deferred to an owner-authorized real release; it is not an extra fixed asset.
- Release notes are release metadata. Use exact tags only: no `latest`.

For a published exact tag, the locked Cargo install form is:

```sh
cargo install --git https://github.com/alphazede/developers --tag bran-vX.Y.Z --locked bran-cli
```

## License

BRAN is licensed, at the recipient's choice, under either the Apache License 2.0 (see [LICENSE-APACHE](LICENSE-APACHE)) or the MIT license (see [LICENSE-MIT](LICENSE-MIT)).
