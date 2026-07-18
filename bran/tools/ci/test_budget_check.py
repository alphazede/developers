#!/usr/bin/env python3
from __future__ import annotations
import ast, json, re, sys
from collections import Counter
from pathlib import Path
PHASES = {"1": 6, "2": 6, "3": 7, "4": 2, "5": 4, "6": 0}
SLICES = {"1.1": 3, "1.2": 3, "2.1": 2, "2.2": 2, "2.3": 2,
          "3.1": 2, "3.2": 2, "3.3": 1, "3.4": 2, "4.1": 1, "4.2": 1,
          "5.1": 1, "5.2": 1, "5.3": 0, "5.4": 2, "6.1": 0}
PHASE_ONE = ("P1-CLI", "P1-RELEASE", "P1-PUBLIC-BOUNDARY", "P1-BUNDLE",
             "P1-PROFILES", "P1-CONFORMANCE")
FIELDS = {"stable_id", "phase", "slice", "runner", "name", "category",
          "classification", "source", "support_fixtures"}
RUNNERS = {"rust", "python", "shell", "golden", "fixture"}
RUST = re.compile(r"#\[test\]\s*(?:#\[[^\]]+\]\s*)*fn\s+([A-Za-z_]\w*)\s*\(")
PYTEST = re.compile(r"^def\s+(test_[A-Za-z_]\w*)\s*\(", re.M)
STABLE = re.compile(r"^P([1-6])-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HIDDEN = re.compile(r"\b(?:self[-_ ]?test|probe|cases?|matrix|parameteri[sz]ed)\b", re.I)
IDENTIFIER = re.compile(r"[A-Za-z_]\w*")
def fail(errors: list[str]) -> int:
    for error in errors:
        print(f"FAIL test budget: {error}")
    return 1
def text(path: Path, errors: list[str]) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        errors.append(f"cannot read {path}: {error}")
        return ""
def body(shell: str, name: str) -> str | None:
    match = re.search(rf"^{re.escape(name)}\(\) \{{\n(.*?)^\}}$", shell, re.M | re.S)
    return match.group(1) if match else None
def suspicious_identifier(value: str) -> bool:
    parts = value.lower().split("_")
    return (any(part in {"case", "cases", "matrix", "matrices", "probe", "probes",
                         "parameterized", "parameterised", "selftest", "selftests"}
                for part in parts)
            or any(parts[index:index + 2] in (["self", "test"], ["self", "tests"])
                   for index in range(len(parts) - 1)))
def rust_body(source: str, name: str) -> str | None:
    match = re.search(rf"#\[test\]\s*(?:#\[[^\]]+\]\s*)*fn\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", source)
    if match is None:
        return None
    opening = match.end() - 1
    depth, quote, escaped, line_comment, block_comment = 0, None, False, False, 0
    index = opening
    while index < len(source):
        char = source[index]
        following = source[index:index + 2]
        if line_comment:
            line_comment = char != "\n"
        elif block_comment:
            if following == "/*": block_comment += 1; index += 1
            elif following == "*/": block_comment -= 1; index += 1
        elif quote:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == quote: quote = None
        elif following == "//": line_comment = True; index += 1
        elif following == "/*": block_comment = 1; index += 1
        elif char in {'"', "'"}: quote = char
        elif char == "{": depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0: return source[opening + 1:index]
        index += 1
    return None
def hidden_source(runner: str, name: str, source: str, direct: bool) -> bool:
    if runner == "rust":
        scoped = rust_body(source, name)
        return (scoped is None
                or re.search(r"\b(?:for|while|loop)\b|\.(?:iter|into_iter)\s*\(", scoped) is not None
                or any(suspicious_identifier(item) for item in IDENTIFIER.findall(scoped)))
    if runner == "python":
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return True
        if not direct:
            matches = [node for node in tree.body
                       if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                       and node.name == name]
            if len(matches) != 1:
                return True
            tree = matches[0]
        identifiers: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                identifiers.append(node.name)
            elif isinstance(node, ast.Name):
                identifiers.append(node.id)
            elif isinstance(node, ast.arg):
                identifiers.append(node.arg)
            elif isinstance(node, ast.Attribute):
                identifiers.append(node.attr)
        return any(suspicious_identifier(item) for item in identifiers)
    if runner == "shell":
        scoped = source if direct else body(source, name)
        if scoped is None:
            return True
        identifiers = re.findall(r"^\s*([A-Za-z_]\w*)\(\)|^\s*([A-Za-z_]\w*)=|\bfor\s+([A-Za-z_]\w*)\s+in|\$\{?([A-Za-z_]\w*)", scoped, re.M)
        return any(suspicious_identifier(item) for group in identifiers for item in group if item)
    return False
def local(root: Path, value: object) -> Path | None:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        return None
    path = root / value
    return path if path.is_file() else None
def check_shell(root: Path, journeys: list[dict], errors: list[str]) -> None:
    shell = text(root / "tools/ci/check.sh", errors)
    functions = {match.group(1): match.group(2) for match in
                 re.finditer(r"^([A-Za-z_]\w*)\(\) \{\n(.*?)^\}$", shell, re.M | re.S)}
    executable = lambda value: [line.strip() for line in value.splitlines()
                                if line.strip() and not line.lstrip().startswith("#")]
    calls = {name: {line for line in executable(part) if line in functions}
             for name, part in functions.items()}
    dispatch_match = re.search(r'^case "\$gate_mode" in\n(.*?)^esac$', shell, re.M | re.S)
    dispatch: dict[str, set[str]] = {}
    if dispatch_match:
        for match in re.finditer(r"^\s*([a-z-]+)\)\n(.*?)(?=^\s*[a-z-]+\)|\Z)",
                                 dispatch_match.group(1), re.M | re.S):
            dispatch[match.group(1)] = {line for line in executable(match.group(2))
                                        if line in functions}
    expected_dispatch = {"test-budget": {"run_budget"}, "fast": {"run_fast"},
                         "conformance": {"run_conformance"},
                         "security": {"run_security"},
                         "performance": {"run_performance"},
                         "full": {"run_fast", "run_conformance", "run_security",
                                  "run_performance"}}
    if dispatch != expected_dispatch:
        errors.append("check.sh supported gate dispatch is missing or not exact")
    def reachable(roots: set[str]) -> set[str]:
        found, pending = set(), list(roots)
        while pending:
            current = pending.pop()
            if current in found or current not in functions: continue
            found.add(current); pending.extend(calls[current] - found)
        return found
    reachable_from_modes = reachable(set().union(*dispatch.values()) if dispatch else set())
    budget = 'python3 "$script_dir/test_budget_check.py" "$script_dir/test-budget.json"'
    global_commands = [line for line in executable(shell)
                       if re.match(r"^(?:python3|sh|bash)\s+", line)]
    all_commands = [(name, line) for name, part in functions.items()
                    for line in executable(part) if re.match(r"^(?:python3|sh|bash)\s+", line)]
    budget_sites = [(name, line) for name, line in all_commands if line == budget]
    if global_commands.count(budget) != 1 or budget_sites != [("run_budget", budget)]:
        errors.append("check.sh must execute the budget checker exactly once in run_budget")
    for name in ("run_fast", "run_conformance", "run_security", "run_performance"):
        if "run_budget" not in reachable({name}):
            errors.append(f"check.sh {name} must reach run_budget")
    expected = {budget}
    for journey in journeys:
        runner, name, source = (journey[key] for key in ("runner", "name", "source"))
        if isinstance(runner, str) and runner in {"python", "shell"} and name == source:
            commands = ({f'python3 "$bran_root/{source}"'} if runner == "python"
                        else {f'sh "$bran_root/{source}"', f'bash "$bran_root/{source}"'})
            sites = [(owner, line) for owner, line in all_commands if line in commands]
            if sum(global_commands.count(command) for command in commands) != 1 or len(sites) != 1 or sites[0][0] not in reachable_from_modes:
                errors.append(f"check.sh must execute {source} exactly once from a supported gate mode")
            expected.update(commands)
    for line in global_commands:
        if line not in expected:
            errors.append(f"unregistered direct Python/shell journey or variant: {line}")
def check_fixtures(root: Path, owned: list[str], errors: list[str]) -> None:
    actual = {path.relative_to(root).as_posix() for path in (root / "fixtures").rglob("*") if path.is_file()}
    counts = Counter(owned)
    for fixture in sorted(actual ^ set(owned)):
        errors.append(f"{'unowned' if fixture in actual else 'missing'} fixture file: {fixture}")
    for fixture, count in sorted(counts.items()):
        if count != 1:
            errors.append(f"support fixture must have exactly one owner: {fixture}")
    for fixture in sorted(actual):
        if HIDDEN.search(fixture) or HIDDEN.search(text(root / fixture, errors)):
            errors.append(f"suspicious hidden test artifact: {fixture}")
def main() -> int:
    if len(sys.argv) != 2:
        print("usage: test_budget_check.py PATH/TO/test-budget.json", file=sys.stderr)
        return 2
    errors: list[str] = []
    try:
        manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return fail([f"invalid manifest: {error}"])
    root = Path(__file__).resolve().parents[2]
    if not isinstance(manifest, dict):
        return fail(["manifest root must be an object"])
    if set(manifest) != {"schema_version", "plan_ceiling", "phase_ceilings", "slice_ceilings", "journeys"}:
        errors.append("manifest must contain exactly schema_version, plan_ceiling, phase_ceilings, slice_ceilings, and journeys")
    if manifest.get("schema_version") != 1 or manifest.get("plan_ceiling") != 25:
        errors.append("manifest schema_version and plan_ceiling must be 1 and 25")
    if manifest.get("phase_ceilings") != PHASES or manifest.get("slice_ceilings") != SLICES:
        errors.append("manifest must exactly encode the approved phase and slice ceilings")
    journeys = manifest.get("journeys")
    if not isinstance(journeys, list):
        return fail(errors + ["journeys must be an ordered array"])
    ids, names = [], []
    rust, fixtures = Counter(), []
    phases, slices = Counter(), Counter()
    valid: list[dict] = []
    for index, journey in enumerate(journeys):
        label = f"journeys[{index}]"
        if not isinstance(journey, dict) or set(journey) != FIELDS:
            errors.append(f"{label} must contain exactly the required inventory fields")
            continue
        valid.append(journey)
        stable_id, phase, slice_name = (journey[key] for key in ("stable_id", "phase", "slice"))
        runner, name, source = (journey[key] for key in ("runner", "name", "source"))
        support = journey["support_fixtures"]
        if not isinstance(stable_id, str) or not (match := STABLE.fullmatch(stable_id)) or type(phase) is not int or match.group(1) != str(phase):
            errors.append(f"{label}.stable_id must be a P{{phase}}-prefixed deterministic slug")
        else:
            ids.append(stable_id)
        if not isinstance(name, str) or HIDDEN.search(name):
            errors.append(f"{label}.name must be an exact non-hidden name")
        else:
            names.append(name)
        if type(phase) is not int or str(phase) not in PHASES:
            errors.append(f"{label}.phase is unknown")
        else:
            phases[phase] += 1
        if not isinstance(slice_name, str) or slice_name not in SLICES or type(phase) is not int or not slice_name.startswith(f"{phase}."):
            errors.append(f"{label}.slice is unknown or belongs to another phase")
        else:
            slices[slice_name] += 1
        if not isinstance(runner, str) or runner not in RUNNERS or not isinstance(journey["category"], str) or not SLUG.fullmatch(journey["category"]) or not isinstance(journey["classification"], str) or journey["classification"] not in {"new", "materially-expanded"}:
            errors.append(f"{label} has an unknown runner, category, or classification")
        source_path = local(root, source)
        if source_path is None:
            errors.append(f"{label}.source is missing or not a file")
        if not isinstance(support, list) or not all(isinstance(item, str) and item.startswith("fixtures/") and local(root, item) for item in support):
            errors.append(f"{label}.support_fixtures must be existing fixture paths")
        else:
            fixtures.extend(support)
        content = text(source_path, errors) if source_path else ""
        if runner == "rust" and isinstance(name, str):
            rust[name] += 1
            if name not in RUST.findall(content): errors.append(f"{label} Rust name is not an exact #[test] in source")
        if runner == "python" and isinstance(name, str) and name != source and name not in PYTEST.findall(content):
            errors.append(f"{label} Python name must be a direct script or exact def test_* item")
        if runner == "shell" and isinstance(name, str) and name != source and body(content, name) is None:
            errors.append(f"{label} shell name is not an exact function")
        if isinstance(runner, str) and isinstance(name, str) and hidden_source(runner, name, content, name == source):
            errors.append(f"{label} source contains a suspicious hidden test multiplier")
        if isinstance(runner, str) and runner in {"golden", "fixture"} and (name != source or not isinstance(source, str) or not source.startswith("fixtures/") or source not in support):
            errors.append(f"{label} {runner} name/source must be its owned fixture")
    if [item.get("stable_id") for item in valid if item.get("phase") == 1] != list(PHASE_ONE) or phases[1] != 6:
        errors.append("Phase 1 must contain exactly the six approved stable IDs in deterministic order")
    for values, what in ((ids, "stable IDs"), (names, "exact names")):
        if duplicates := sorted(item for item, count in Counter(values).items() if count > 1): errors.append(f"duplicate {what}: {', '.join(duplicates)}")
    later = [(item["phase"], item["slice"], item["stable_id"]) for item in valid if type(item["phase"]) is int and item["phase"] > 1]
    if later != sorted(later, key=lambda item: (item[0], item[1], item[2])): errors.append("later journeys must preserve deterministic phase, slice, and stable ID order")
    for key, count in phases.items():
        if count > PHASES.get(str(key), 0): errors.append(f"phase {key} exceeds its approved test ceiling")
    for key, count in slices.items():
        if count > SLICES.get(key, 0): errors.append(f"slice {key} exceeds its approved test ceiling")
    if len(journeys) > 25: errors.append("manifest exceeds the plan-wide test ceiling of 25")
    actual = Counter(name for path in (root / "crates").rglob("*.rs") for name in RUST.findall(text(path, errors)))
    for name in sorted(set(actual) | set(rust)):
        if actual[name] != 1 or rust[name] != 1: errors.append(f"Rust test {name} must be registered and defined exactly once")
    check_shell(root, valid, errors)
    check_fixtures(root, fixtures, errors)
    if errors: return fail(errors)
    print(f"PASS test budget: Phase 1=6 Phase 2=2 manifest={len(journeys)} plan_ceiling=25")
    return 0
if __name__ == "__main__":
    sys.exit(main())
