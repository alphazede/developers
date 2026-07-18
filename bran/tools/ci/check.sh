#!/bin/sh

set -eu

usage() {
    printf '%s\n' "usage: $0 --fast|--conformance|--full" >&2
    exit 2
}

[ "$#" -eq 1 ] || usage

case "$1" in
    --fast)
        gate_mode='fast'
        ;;
    --conformance)
        gate_mode='conformance'
        ;;
    --full)
        gate_mode='full'
        ;;
    *)
        usage
        ;;
esac

script_dir=$(CDPATH="" cd "$(dirname "$0")" && pwd -P)
bran_root=$(CDPATH="" cd "$script_dir/../.." && pwd -P)

if [ ! -f "$bran_root/Cargo.lock" ]; then
    printf '%s\n' "FAIL required lockfile is missing: $bran_root/Cargo.lock" >&2
    exit 1
fi

# Run shellcheck on check.sh if the tool is present (do not install tools)
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$script_dir/check.sh"
fi

run_conformance() {
    printf '%s\n' 'CONFORMANCE: running frozen Slice 1.2 corpus and schema checks.'

    cargo test --manifest-path "$bran_root/Cargo.toml" -p bran-core conformance_

    # Python's standard library parses the schemas and checks only their owned
    # contract shape; ProfileValidator remains the product validation oracle.
    python3 - "$bran_root" <<'PY'
import json
import pathlib
import sys

schemas = pathlib.Path(sys.argv[1]) / "schemas"

with (schemas / "okf-v0.1-normalized-bundle.schema.json").open(encoding="utf-8") as handle:
    bundle = json.load(handle)
with (schemas / "bran-profile-result.schema.json").open(encoding="utf-8") as handle:
    result = json.load(handle)

assert bundle["$schema"] == "https://json-schema.org/draft/2020-12/schema"
assert bundle["properties"]["schema_version"]["const"] == "1"
assert bundle["properties"]["docs"]["additionalProperties"] == {"$ref": "#/$defs/document"}
assert bundle["$defs"]["frontmatter"]["additionalProperties"] is True
assert "does not resolve Markdown links" in bundle["description"]

assert result["$schema"] == "https://json-schema.org/draft/2020-12/schema"
assert result["properties"]["exit_code"]["enum"] == [0, 1]
assert result["$defs"]["profileOutcome"]["additionalProperties"] is True
assert result["$defs"]["okfOutcome"]["allOf"][1]["properties"]["profile"]["const"] == "okf-v0.1"
assert result["$defs"]["strictOutcome"]["allOf"][1]["properties"]["profile"]["const"] == "bran-strict"
assert "Link targets remain unvalidated" in result["description"]

print("PASS Slice 1.2 schema JSON/contract shape")
PY
}

run_fast() {
    printf '%s\n' 'FAST: running Slice 1.1 gates.'

    cargo fmt --manifest-path "$bran_root/Cargo.toml" --all -- --check
    cargo clippy --manifest-path "$bran_root/Cargo.toml" --workspace --all-targets --all-features -- -D warnings
    cargo test --manifest-path "$bran_root/Cargo.toml" --workspace --all-targets --all-features

    # cargo-deny availability failure (clear) then exact check for licenses bans sources (common fast/full gate)
    if ! command -v cargo-deny >/dev/null 2>&1; then
        printf '%s\n' "FAIL cargo-deny is required but not available in PATH" >&2
        exit 1
    fi
    cargo deny --manifest-path "$bran_root/Cargo.toml" check licenses bans sources

    python3 "$bran_root/tools/ci/release_contract_check.py"
    python3 "$bran_root/tools/ci/public_boundary_check.py"
    python3 "$bran_root/tools/ci/public_boundary_check.py" --self-test

    printf '%s\n' 'PASS Slice 1.1 fast gate'
}

case "$gate_mode" in
    fast)
        run_fast
        ;;
    conformance)
        run_conformance
        printf '%s\n' 'PASS Slice 1.2 conformance gate'
        ;;
    full)
        printf '%s\n' 'FULL: running fast/security gates and Slice 1.2 conformance.'
        run_fast
        run_conformance
        printf '%s\n' 'PASS Slice 1.2 full gate'
        ;;
esac
