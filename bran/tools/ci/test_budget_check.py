#!/usr/bin/env python3
"""Statically enforce the owner-approved BRAN automated-test budget."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


EXPECTED_IDS = (
    "P1-CLI",
    "P1-RELEASE",
    "P1-PUBLIC-BOUNDARY",
    "P1-BUNDLE",
    "P1-PROFILES",
    "P1-CONFORMANCE",
)
EXPECTED_CEILINGS = {"1": 6, "2": 6, "3": 7, "4": 2, "5": 4, "6": 0}
EXPECTED_SLICE_CEILINGS = {
    "1.1": 3, "1.2": 3,
    "2.1": 2, "2.2": 2, "2.3": 2,
    "3.1": 2, "3.2": 2, "3.3": 1, "3.4": 2,
    "4.1": 1, "4.2": 1,
    "5.1": 1, "5.2": 1, "5.3": 0, "5.4": 2,
    "6.1": 0,
}
EXPECTED_JOURNEYS = {
    "P1-CLI": (1, "1.1", "rust", "p1_cli", "unit", "new", "crates/bran-cli/src/main.rs", []),
    "P1-RELEASE": (1, "1.1", "python", "tools/ci/release_contract_check.py", "contract", "new", "tools/ci/release_contract_check.py", ["fixtures/release/valid-exact-release-manifest.json"]),
    "P1-PUBLIC-BOUNDARY": (1, "1.1", "python", "tools/ci/public_boundary_check.py", "security", "new", "tools/ci/public_boundary_check.py", ["fixtures/public-boundary/public-safe/neutral-product-text.txt", "fixtures/public-boundary/rejected/synthetic-canaries.txt"]),
    "P1-BUNDLE": (1, "1.2", "rust", "p1_bundle", "unit", "new", "crates/bran-core/src/bundle.rs", []),
    "P1-PROFILES": (1, "1.2", "rust", "p1_profiles", "contract", "new", "crates/bran-core/src/profile.rs", []),
    "P1-CONFORMANCE": (1, "1.2", "rust", "p1_conformance", "conformance", "new", "crates/bran-core/src/profile.rs", ["fixtures/conformance/strict-gap-strict-selected.fixture"]),
}
EXPECTED_FIELDS = {
    "stable_id", "phase", "slice", "runner", "name", "category",
    "classification", "source", "support_fixtures",
}
KNOWN_RUNNERS = {"rust", "python", "shell", "golden", "fixture"}
KNOWN_CLASSIFICATIONS = {"new", "materially-expanded"}
RUST_TEST = re.compile(r"#\[test\]\s*(?:#\[[^\]]+\]\s*)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
PYTHON_TEST = re.compile(r"^def\s+(test_[A-Za-z_][A-Za-z0-9_]*)\s*\(", re.MULTILINE)
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
STABLE_ID = re.compile(r"^P([1-6])-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$")
SUSPICIOUS_CASE_ROW = re.compile(r"\b(?:case|cases|matrix|parameteri[sz]ed|self-test)\b", re.IGNORECASE)


def fail(errors: list[str]) -> int:
    for error in errors:
        print(f"FAIL test budget: {error}")
    return 1


def load_manifest(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"FAIL test budget: invalid manifest: {error}")
        return None
    if not isinstance(value, dict):
        print("FAIL test budget: manifest root must be an object")
        return None
    return value


def rust_tests(bran_root: Path, errors: list[str]) -> Counter[str]:
    found: Counter[str] = Counter()
    for path in sorted((bran_root / "crates").rglob("*.rs")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            errors.append(f"cannot read Rust source {path.relative_to(bran_root)}: {error}")
            continue
        found.update(RUST_TEST.findall(text))
    return found


def function_body(shell: str, name: str) -> str | None:
    match = re.search(rf"^{re.escape(name)}\(\) \{{\n(.*?)^\}}$", shell, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else None


def direct_script_journeys(journeys: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Return registered direct scripts, keyed by their required interpreter."""
    direct = {"python3": set(), "shell": set()}
    for journey in journeys:
        if not isinstance(journey, dict):
            continue
        runner = journey.get("runner")
        name = journey.get("name")
        source = journey.get("source")
        if runner == "python" and isinstance(name, str) and name == source:
            direct["python3"].add(source)
        if runner == "shell" and isinstance(name, str) and name == source:
            direct["shell"].add(source)
    return direct


def inspect_ci(bran_root: Path, journeys: list[dict[str, Any]], errors: list[str]) -> None:
    check = bran_root / "tools/ci/check.sh"
    try:
        shell = check.read_text(encoding="utf-8")
    except OSError as error:
        errors.append(f"cannot read tools/ci/check.sh: {error}")
        return

    budget_call = 'python3 "$script_dir/test_budget_check.py" "$script_dir/test-budget.json"'
    if shell.count(budget_call) != 1:
        errors.append("check.sh must invoke the budget checker exactly once")
    if "--test-budget)" not in shell or "run_budget" not in shell:
        errors.append("check.sh must expose --test-budget through run_budget")

    for name in ("run_fast", "run_conformance"):
        body = function_body(shell, name)
        if body is None or len(re.findall(r"^    run_budget$", body, re.MULTILINE)) != 1:
            errors.append(f"check.sh {name} must run the budget checker once")

    direct = direct_script_journeys(journeys)
    allowed_lines = {f"    {budget_call}"}
    for source in sorted(direct["python3"]):
        invocation = f'python3 "$bran_root/{source}"'
        if shell.count(invocation) != 1:
            errors.append(f"check.sh must invoke {source} exactly once without variants")
        allowed_lines.add(f"    {invocation}")
    for source in sorted(direct["shell"]):
        invocations = (
            f'sh "$bran_root/{source}"',
            f'bash "$bran_root/{source}"',
        )
        count = sum(shell.count(invocation) for invocation in invocations)
        if count != 1:
            errors.append(f"check.sh must invoke {source} exactly once without variants")
        allowed_lines.update(f"    {invocation}" for invocation in invocations)
    for line in shell.splitlines():
        stripped = line.strip()
        if stripped.startswith(("python3 ", "sh ", "bash ")) and line not in allowed_lines:
            errors.append(f"unregistered direct Python/shell journey or variant: {stripped}")

    conformance = 'cargo test --manifest-path "$bran_root/Cargo.toml" -p bran-core p1_conformance'
    if shell.count(conformance) != 1:
        errors.append("check.sh must run exactly the p1_conformance Rust journey once")


def inspect_support_files(bran_root: Path, owned: set[str], errors: list[str]) -> None:
    fixtures = bran_root / "fixtures"
    actual = {
        path.relative_to(bran_root).as_posix()
        for path in fixtures.rglob("*") if path.is_file()
    }
    unowned = sorted(actual - owned)
    missing = sorted(owned - actual)
    for path in unowned:
        errors.append(f"unowned fixture file: {path}")
    for path in missing:
        errors.append(f"owned fixture file is missing: {path}")
    for relative in sorted(owned):
        path = bran_root / relative
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            errors.append(f"cannot read owned fixture {relative}: {error}")
            continue
        if SUSPICIOUS_CASE_ROW.search(text):
            errors.append(f"suspicious hidden test-case matrix or fixture row: {relative}")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: test_budget_check.py PATH/TO/test-budget.json", file=sys.stderr)
        return 2
    manifest_path = Path(sys.argv[1]).resolve()
    manifest = load_manifest(manifest_path)
    if manifest is None:
        return 1
    bran_root = Path(__file__).resolve().parents[2]
    errors: list[str] = []

    if set(manifest) != {"schema_version", "plan_ceiling", "phase_ceilings", "slice_ceilings", "journeys"}:
        errors.append("manifest must contain exactly schema_version, plan_ceiling, phase_ceilings, slice_ceilings, and journeys")
    if manifest.get("schema_version") != 1:
        errors.append("manifest schema_version must be 1")
    if manifest.get("plan_ceiling") != 25:
        errors.append("manifest plan_ceiling must be 25")
    if manifest.get("phase_ceilings") != EXPECTED_CEILINGS:
        errors.append("phase_ceilings must exactly encode the approved 6,6,7,2,4,0 ceilings")
    if manifest.get("slice_ceilings") != EXPECTED_SLICE_CEILINGS:
        errors.append("slice_ceilings must exactly encode the approved plan allocation")
    if sum(EXPECTED_CEILINGS.values()) != 25:
        errors.append("approved phase ceilings do not total 25")

    journeys = manifest.get("journeys")
    if not isinstance(journeys, list):
        return fail(errors + ["journeys must be an ordered array"])
    ids: list[str] = []
    names: list[str] = []
    rust_registered: Counter[str] = Counter()
    owned_fixtures: set[str] = set()
    phase_subtotal: Counter[int] = Counter()
    slice_subtotal: Counter[str] = Counter()
    for index, journey in enumerate(journeys):
        label = f"journeys[{index}]"
        if not isinstance(journey, dict) or set(journey) != EXPECTED_FIELDS:
            errors.append(f"{label} must contain exactly the required inventory fields")
            continue
        stable_id = journey["stable_id"]
        name = journey["name"]
        phase = journey["phase"]
        slice_name = journey["slice"]
        runner = journey["runner"]
        category = journey["category"]
        classification = journey["classification"]
        source = journey["source"]
        support_fixtures = journey["support_fixtures"]
        if not isinstance(stable_id, str):
            errors.append(f"{label}.stable_id must be a string")
        else:
            ids.append(stable_id)
        if not isinstance(name, str):
            errors.append(f"{label}.name must be a string")
        else:
            names.append(name)
        if not isinstance(phase, int) or str(phase) not in EXPECTED_CEILINGS:
            errors.append(f"{label}.phase is unknown")
        else:
            phase_subtotal[phase] += 1
        if not isinstance(slice_name, str) or slice_name not in EXPECTED_SLICE_CEILINGS:
            errors.append(f"{label}.slice is unknown")
        else:
            slice_subtotal[slice_name] += 1
            if isinstance(phase, int) and not slice_name.startswith(f"{phase}."):
                errors.append(f"{label}.slice does not belong to phase {phase}")
        if not isinstance(runner, str) or runner not in KNOWN_RUNNERS:
            errors.append(f"{label}.runner is unknown")
        if not isinstance(category, str) or not SLUG.fullmatch(category):
            errors.append(f"{label}.category must be a nonempty lowercase slug")
        if not isinstance(classification, str) or classification not in KNOWN_CLASSIFICATIONS:
            errors.append(f"{label}.classification is unknown")
        if not isinstance(source, str) or not source or not (bran_root / source).is_file():
            errors.append(f"{label}.source is missing or not a file")
        if not isinstance(support_fixtures, list) or not all(isinstance(item, str) for item in support_fixtures):
            errors.append(f"{label}.support_fixtures must be an array of paths")
        else:
            for fixture in support_fixtures:
                if not fixture.startswith("fixtures/"):
                    errors.append(f"{label} owns a non-fixture support path: {fixture}")
                if fixture in owned_fixtures:
                    errors.append(f"support fixture is owned by more than one journey: {fixture}")
                owned_fixtures.add(fixture)
        if runner == "rust" and isinstance(name, str):
            rust_registered[name] += 1
        if isinstance(stable_id, str):
            stable_match = STABLE_ID.fullmatch(stable_id)
            if stable_id not in EXPECTED_JOURNEYS:
                if stable_match is None or not isinstance(phase, int) or stable_match.group(1) != str(phase):
                    errors.append(f"{label}.stable_id must be a P{{phase}}-prefixed deterministic slug")
        if runner == "rust" and isinstance(name, str) and isinstance(source, str):
            try:
                source_text = (bran_root / source).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                source_text = ""
            if name not in RUST_TEST.findall(source_text):
                errors.append(f"{label} Rust journey is not an exact #[test] function in its source")
        if runner == "python" and isinstance(name, str) and isinstance(source, str):
            if name != source:
                try:
                    source_text = (bran_root / source).read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    source_text = ""
                if name not in PYTHON_TEST.findall(source_text):
                    errors.append(f"{label} Python journey must be a direct script or exact def test_* item in its source")
        if runner == "shell" and isinstance(name, str) and isinstance(source, str) and name != source:
            try:
                source_text = (bran_root / source).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                source_text = ""
            if function_body(source_text, name) is None:
                errors.append(f"{label} shell journey is not an exact function or scenario in its source")
        if runner in {"golden", "fixture"}:
            if not isinstance(name, str) or name != source or not isinstance(source, str) or not source.startswith("fixtures/"):
                errors.append(f"{label} {runner} journey name and source must be the same fixture path")
            elif not isinstance(support_fixtures, list) or source not in support_fixtures:
                errors.append(f"{label} {runner} journey source must be owned as a support fixture")
        if isinstance(stable_id, str) and stable_id in EXPECTED_JOURNEYS:
            observed = (phase, slice_name, runner, name, category, classification, source, support_fixtures)
            if observed != EXPECTED_JOURNEYS[stable_id]:
                errors.append(f"{label} does not match the approved mapping for {stable_id}")

    duplicate_ids = sorted(name for name, count in Counter(ids).items() if count > 1)
    duplicate_names = sorted(name for name, count in Counter(names).items() if count > 1)
    if duplicate_ids:
        errors.append(f"duplicate stable IDs: {', '.join(duplicate_ids)}")
    if duplicate_names:
        errors.append(f"duplicate exact names: {', '.join(duplicate_names)}")
    phase_one_ids = [
        journey.get("stable_id")
        for journey in journeys
        if isinstance(journey, dict) and journey.get("phase") == 1
    ]
    if tuple(phase_one_ids) != EXPECTED_IDS:
        errors.append("Phase 1 must contain exactly the six approved stable IDs in deterministic order")
    if phase_subtotal[1] != 6:
        errors.append("Phase 1 subtotal must be exactly 6")
    later_ordering = [
        (journey.get("phase"), journey.get("slice"), journey.get("stable_id"))
        for journey in journeys
        if isinstance(journey, dict) and isinstance(journey.get("phase"), int) and journey["phase"] > 1
    ]
    if later_ordering != sorted(later_ordering, key=lambda item: (item[0], str(item[1]), str(item[2]))):
        errors.append("later journeys must preserve deterministic phase, slice, and stable ID order")
    for phase, count in sorted(phase_subtotal.items()):
        if count > EXPECTED_CEILINGS.get(str(phase), 0):
            errors.append(f"phase {phase} exceeds its approved test ceiling")
    for slice_name, count in sorted(slice_subtotal.items()):
        if count > EXPECTED_SLICE_CEILINGS.get(slice_name, 0):
            errors.append(f"slice {slice_name} exceeds its approved test ceiling")
    if len(journeys) > 25:
        errors.append("manifest exceeds the plan-wide test ceiling of 25")

    actual_rust = rust_tests(bran_root, errors)
    for name, count in sorted(actual_rust.items()):
        if name not in rust_registered:
            errors.append(f"unregistered actual Rust test: {name}")
        elif count != 1:
            errors.append(f"actual Rust test must have one definition: {name} (found {count})")
    for name, count in sorted(rust_registered.items()):
        if actual_rust[name] != 1 or count != 1:
            errors.append(f"registered Rust journey is not actually present exactly once: {name}")

    inspect_ci(bran_root, journeys, errors)
    inspect_support_files(bran_root, owned_fixtures, errors)
    if errors:
        return fail(errors)
    print(f"PASS test budget: Phase 1=6 manifest={len(journeys)} plan_ceiling=25")
    return 0


if __name__ == "__main__":
    sys.exit(main())
