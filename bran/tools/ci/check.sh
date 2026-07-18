#!/bin/sh

set -eu

usage() {
    printf '%s\n' "usage: $0 --fast|--full" >&2
    exit 2
}

[ "$#" -eq 1 ] || usage

case "$1" in
    --fast)
        gate_mode='fast'
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

if [ "$gate_mode" = 'full' ]; then
    printf '%s\n' 'FULL requested: running available Slice 1.1 gates only.'
    printf '%s\n' 'Later conformance, performance, and release-seal stages are not available and did not run.'
else
    printf '%s\n' 'FAST: running Slice 1.1 gates.'
fi

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

printf '%s\n' "PASS Slice 1.1 $gate_mode gate"
