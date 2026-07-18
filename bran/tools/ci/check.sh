#!/bin/sh

set -eu

usage() {
    printf '%s\n' "usage: $0 --test-budget|--fast|--conformance|--full" >&2
    exit 2
}

[ "$#" -eq 1 ] || usage

case "$1" in
    --test-budget)
        gate_mode='test-budget'
        ;;
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

run_budget() {
    python3 "$script_dir/test_budget_check.py" "$script_dir/test-budget.json"
}

run_conformance() {
    printf '%s\n' 'CONFORMANCE: running frozen Slice 1.2 corpus and schema checks.'

    run_budget
    cargo test --manifest-path "$bran_root/Cargo.toml" -p bran-core p1_conformance
}

run_fast() {
    printf '%s\n' 'FAST: running Slice 1.1 gates.'

    run_budget
    cargo fmt --manifest-path "$bran_root/Cargo.toml" --all -- --check
    cargo clippy --manifest-path "$bran_root/Cargo.toml" --workspace --all-targets --all-features -- -D warnings
    cargo test --manifest-path "$bran_root/Cargo.toml" --workspace --all-targets --all-features p1_ -- --skip p1_conformance

    # cargo-deny availability failure (clear) then exact check for licenses bans sources (common fast/full gate)
    if ! command -v cargo-deny >/dev/null 2>&1; then
        printf '%s\n' "FAIL cargo-deny is required but not available in PATH" >&2
        exit 1
    fi
    cargo deny --manifest-path "$bran_root/Cargo.toml" check licenses bans sources

    python3 "$bran_root/tools/ci/release_contract_check.py"
    python3 "$bran_root/tools/ci/public_boundary_check.py"

    printf '%s\n' 'PASS Slice 1.1 fast gate'
}

case "$gate_mode" in
    test-budget)
        run_budget
        ;;
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
