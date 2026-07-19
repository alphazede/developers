#!/usr/bin/env python3
"""Strict local release seal verification; never signs, publishes, or uses network."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import release_contract_check as contract


def bran_root() -> Path:
    return Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_state(root: Path, tag: str) -> tuple[str, str | None, bool | None, str | None]:
    try:
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        tagged = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        dirty = bool(subprocess.check_output(
            ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], text=True
        ).strip())
        lock_path = (bran_root() / "Cargo.lock").relative_to(root).as_posix()
        tagged_lock = subprocess.check_output(
            ["git", "-C", str(root), "show", f"refs/tags/{tag}:{lock_path}"],
            stderr=subprocess.DEVNULL,
        )
        return head, tagged, dirty, hashlib.sha256(tagged_lock).hexdigest()
    except (OSError, subprocess.CalledProcessError, ValueError):
        return "", None, None, None


def verify_signature(
    sums: Path,
    signature: Path,
    *,
    _which: Callable[[str], str | None] = shutil.which,
    _run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[str, str]:
    """Return the verified fingerprint and signature time."""
    gpg = _which("gpg")
    if not gpg:
        raise ValueError("signature verification unavailable: gpg is not installed")
    try:
        result = _run(
            [
                gpg,
                "--batch",
                "--no-auto-key-retrieve",
                "--auto-key-locate",
                "clear",
                "--status-fd",
                "1",
                "--verify",
                str(signature),
                str(sums),
            ],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    except OSError as error:
        raise ValueError(f"signature verification unavailable: cannot run gpg: {error}") from error
    if result.returncode:
        detail = result.stderr.strip() or "no VALIDSIG status"
        raise ValueError(f"signature verification unavailable: {detail}")

    valid = [line.split() for line in result.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
    if len(valid) != 1 or len(valid[0]) < 5:
        raise ValueError("signature verification unavailable: expected exactly one complete VALIDSIG status")
    fingerprint, creation_date, creation_epoch = valid[0][2:5]
    fingerprint = fingerprint.lower()
    if not contract.is_fingerprint(fingerprint):
        raise ValueError("signature verification unavailable: gpg returned an invalid signer fingerprint")
    try:
        epoch = int(creation_epoch)
        if epoch < 0:
            raise ValueError
        signed_at = datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        parsed_date = datetime.strptime(creation_date, "%Y-%m-%d").strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError) as error:
        raise ValueError("signature verification unavailable: gpg returned an invalid signature time") from error
    if parsed_date != creation_date or creation_date != signed_at[:10]:
        raise ValueError("signature verification unavailable: gpg signature date and epoch disagree")
    return fingerprint, signed_at


def archives(tag: str) -> tuple[str, ...]:
    # The semantic oracle owns the exact seven-asset contract; five are archives.
    return contract.expected_asset_names(tag)[:5]


def require_archives(tag: str, dist: Path) -> tuple[str, ...]:
    names = archives(tag)
    present = {
        path.name
        for path in dist.iterdir()
        if path.is_file() and path.name.endswith((".tar.gz", ".zip"))
    }
    missing = sorted(set(names) - present)
    extra = sorted(present - set(names))
    if missing or extra:
        parts = ([f"missing platform archives: {missing}"] if missing else []) + (
            [f"extra platform archives: {extra}"] if extra else []
        )
        raise ValueError("; ".join(parts))
    return names


def expected_sums(names: tuple[str, ...], dist: Path) -> str:
    return "".join(f"{digest(dist / name)}  {name}\n" for name in sorted(names))


def require_sums(names: tuple[str, ...], dist: Path, create: bool) -> Path:
    sums = dist / "SHA256SUMS"
    expected = expected_sums(names, dist)
    if not sums.exists() and create:
        sums.write_text(expected, encoding="utf-8")
    if not sums.is_file():
        raise ValueError("missing required asset: SHA256SUMS")
    if sums.read_text(encoding="utf-8") != expected:
        raise ValueError("SHA256SUMS does not match exactly the five platform archives")
    return sums


def expected_manifest(
    tag: str,
    head: str,
    lock_digest: str,
    names: tuple[str, ...],
    dist: Path,
    sums: Path,
    signature: Path,
    signer: str,
    signed_at: str,
) -> dict:
    media = lambda name: "application/zip" if name.endswith(".zip") else "application/gzip"
    assets = [{"name": name, "url": f"{contract.RELEASE_BASE}/{tag}/{name}", "sha256": digest(dist / name), "media_type": media(name)} for name in names]
    assets += [
        {"name": "SHA256SUMS", "url": f"{contract.RELEASE_BASE}/{tag}/SHA256SUMS", "sha256": digest(sums), "media_type": "text/plain"},
        {"name": "SHA256SUMS.sig", "url": f"{contract.RELEASE_BASE}/{tag}/SHA256SUMS.sig", "sha256": digest(signature), "media_type": "application/pgp-signature"},
    ]
    return {
        "schema_version": contract.SCHEMA_VERSION, "tag": tag, "repository": contract.REPOSITORY,
        "source_commit": head, "lockfile_sha256": lock_digest, "immutable": True,
        "manifest_asset": "bran-release-manifest.json", "assets": assets,
        "checksums": {"asset": "SHA256SUMS", "algorithm": "sha256", "sha256": digest(sums)},
        "signature": {"asset": "SHA256SUMS.sig", "format": "openpgp", "key_fingerprint": signer,
                      "signed_at": signed_at},
        "provenance": {"format": "https://slsa.dev/provenance/v1", "predicate_type": "https://slsa.dev/provenance/v1",
                       "source_repository": contract.REPOSITORY, "source_commit": head, "lockfile_sha256": lock_digest,
                       "build_type": "https://alphazede.dev/bran/build/v1"},
    }


def seal(tag: str, dist: Path, dry_run: bool, required_fingerprint: str | None,
         _git: Callable[[Path, str], tuple[str, str | None, bool | None, str | None]] = git_state,
         _proof: Callable[[Path, Path], tuple[str, str]] = verify_signature) -> int:
    if not contract.TAG_PATTERN.fullmatch(tag):
        print(f"FAIL invalid tag (must be bran-vX.Y.Z): {tag}")
        return 1
    if not dist.is_dir():
        print(f"FAIL --dist must be an existing directory: {dist}")
        return 1
    lock = bran_root() / "Cargo.lock"
    if not lock.is_file():
        print(f"FAIL required lockfile is missing: {lock}")
        return 1
    lock_digest = digest(lock)
    head, tagged, dirty, tagged_lock_digest = _git(bran_root().parent, tag)
    if not contract.is_git_sha(head):
        print("FAIL git evidence unavailable: cannot determine HEAD")
        return 1
    if tagged != head or dirty is not False or tagged_lock_digest != lock_digest:
        print(
            "FAIL exact release required: "
            f"clean={dirty is False} tag_equals_head={tagged == head} "
            f"lock_matches_tag={tagged_lock_digest == lock_digest}"
        )
        return 1
    try:
        names = require_archives(tag, dist)
        sums = require_sums(names, dist, create=dry_run)
    except (OSError, UnicodeDecodeError, ValueError) as error:
        print(f"FAIL {error}")
        return 1

    manifest_path = dist / "bran-release-manifest.json"
    if dry_run:
        if manifest_path.exists() or manifest_path.is_symlink():
            print("FAIL dry-run unsigned rejects bran-release-manifest.json final-state input")
            return 1
        evidence = {
            "archives": [{"name": name, "sha256": digest(dist / name)} for name in sorted(names)],
            "checksums": {"asset": "SHA256SUMS", "sha256": digest(sums)},
            "final_manifest": "unavailable",
            "kind": "bran-release-unsigned-evidence",
            "lockfile_sha256": lock_digest,
            "publication": "unavailable",
            "signature": "unavailable",
            "source_commit": head,
            "tag": tag,
        }
        path = dist / "bran-release-evidence.unsigned.json"
        path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("DRY-RUN UNSIGNED: signature, final manifest, and publication unavailable")
        print(f"wrote non-final evidence: {path.name}")
        return 0

    if not required_fingerprint or not contract.is_fingerprint(required_fingerprint.lower()):
        print("FAIL real mode requires a valid --fingerprint policy value")
        return 1
    if not manifest_path.is_file():
        print("FAIL missing required asset: bran-release-manifest.json")
        return 1
    signature = dist / "SHA256SUMS.sig"
    if not signature.is_file():
        print("FAIL missing required asset: SHA256SUMS.sig")
        return 1
    try:
        signer, signed_at = _proof(sums, signature)
        if signer != required_fingerprint.lower():
            raise ValueError(
                f"verified signer fingerprint mismatch: actual={signer} "
                f"required={required_fingerprint.lower()}"
            )
    except (OSError, ValueError) as error:
        print(f"FAIL {error}")
        return 1

    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"FAIL invalid final manifest: {error}")
        return 1
    errors = contract.validate_manifest(manifest)
    if errors:
        print("FAIL semantic oracle rejected final manifest: " + "; ".join(errors))
        return 1
    expected = expected_manifest(tag, head, lock_digest, names, dist, sums, signature, signer, signed_at)
    manifest_fields = {key: value for key, value in manifest.items() if key != "assets"}
    expected_fields = {key: value for key, value in expected.items() if key != "assets"}
    manifest_assets = {asset["name"]: asset for asset in manifest["assets"]}
    expected_assets = {asset["name"]: asset for asset in expected["assets"]}
    if manifest_fields != expected_fields or manifest_assets != expected_assets:
        print("FAIL final manifest does not match locally verified release evidence")
        return 1
    if manifest_path.read_bytes() != manifest_bytes:
        print("FAIL final manifest changed during verification")
        return 1
    print("PASS sealed release and existing final manifest verified locally; publication remains excluded")
    return 0


def test_p4_sealed_release() -> None:
    """The single named P4 journey covers dry-run and strict refusal paths."""
    print("=== P4-SEALED-RELEASE self-test ===")
    tag, fingerprint, head = "bran-v4.2.0", "0123456789abcdef0123456789abcdef01234567", "a" * 40
    signed_at = "2026-01-02T03:04:05Z"
    lock_digest = digest(bran_root() / "Cargo.lock")
    good_git = lambda _root, _tag: (head, head, False, lock_digest)
    good_proof = lambda _sums, _signature: (fingerprint, signed_at)
    commands: list[list[str]] = []

    def fake_gpg(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        status = f"[GNUPG:] VALIDSIG {fingerprint.upper()} 2026-01-02 1767323045 0 4 0 1 10 00\n"
        return subprocess.CompletedProcess(command, 0, status, "")

    verified = verify_signature(
        Path("SHA256SUMS"),
        Path("SHA256SUMS.sig"),
        _which=lambda _name: "/usr/bin/gpg",
        _run=fake_gpg,
    )
    assert verified == (fingerprint, signed_at)
    assert commands == [[
        "/usr/bin/gpg", "--batch", "--no-auto-key-retrieve", "--auto-key-locate", "clear",
        "--status-fd", "1", "--verify", "SHA256SUMS.sig", "SHA256SUMS",
    ]]
    try:
        verify_signature(Path("SHA256SUMS"), Path("SHA256SUMS.sig"), _which=lambda _name: None)
        raise AssertionError("missing gpg was accepted")
    except ValueError as error:
        assert "gpg is not installed" in str(error)

    with tempfile.TemporaryDirectory() as tmp:
        dist = Path(tmp)
        for index, name in enumerate(archives(tag)):
            (dist / name).write_bytes(f"artifact-{index}".encode())
        missing = dist / archives(tag)[0]
        missing.unlink()
        assert seal(tag, dist, True, None, good_git, good_proof) == 1
        missing.write_bytes(b"artifact-0")
        extra = dist / f"{tag}-unsupported.tar.gz"
        extra.write_bytes(b"extra")
        assert seal(tag, dist, True, None, good_git, good_proof) == 1
        extra.unlink()
        assert seal(tag, dist, True, None, lambda *_: (head, "b" * 40, False, lock_digest), good_proof) == 1
        assert seal(tag, dist, True, None, lambda *_: (head, head, True, lock_digest), good_proof) == 1
        assert seal(tag, dist, True, None, lambda *_: (head, head, False, "0" * 64), good_proof) == 1
        assert seal(tag, dist, True, None, good_git, good_proof) == 0
        sums = dist / "SHA256SUMS"
        assert sums.read_text(encoding="utf-8") == expected_sums(archives(tag), dist)
        evidence = dist / "bran-release-evidence.unsigned.json"
        first = evidence.read_bytes()
        assert seal(tag, dist, True, None, good_git, good_proof) == 0 and evidence.read_bytes() == first
        assert not (dist / "bran-release-manifest.json").exists()
        sums.write_text("drift\n", encoding="utf-8")
        assert seal(tag, dist, True, None, good_git, good_proof) == 1
        sums.write_text(expected_sums(archives(tag), dist), encoding="utf-8")
        signature = dist / "SHA256SUMS.sig"
        signature.write_bytes(b"not accepted by the injected verifier alone")
        manifest_path = dist / "bran-release-manifest.json"
        assert seal(tag, dist, False, fingerprint, good_git, good_proof) == 1
        manifest = expected_manifest(
            tag, head, lock_digest, archives(tag), dist, sums, signature, fingerprint, signed_at
        )
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        assert seal(tag, dist, False, fingerprint, good_git, lambda *_: (_ for _ in ()).throw(ValueError("signature verification unavailable: no key"))) == 1
        assert seal(tag, dist, False, fingerprint, good_git, lambda *_: ("f" * 40, signed_at)) == 1
        original_manifest = manifest_path.read_bytes()
        assert seal(tag, dist, False, fingerprint, good_git, good_proof) == 0
        assert manifest_path.read_bytes() == original_manifest
        assert seal(tag, dist, True, None, good_git, good_proof) == 1
        assert manifest_path.read_bytes() == original_manifest
        manifest["assets"][0]["sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        tampered_manifest = manifest_path.read_bytes()
        assert seal(tag, dist, False, fingerprint, good_git, good_proof) == 1
        assert manifest_path.read_bytes() == tampered_manifest
    print("=== P4-SEALED-RELEASE self-test PASS ===")


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        try:
            test_p4_sealed_release()
            return 0
        except (AssertionError, OSError, ValueError) as error:
            print(f"FAIL P4-SEALED-RELEASE: {error}")
            return 1
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--dist", required=True, type=Path)
    parser.add_argument("--dry-run-unsigned", action="store_true")
    parser.add_argument("--fingerprint")
    args = parser.parse_args()
    return seal(args.tag, args.dist.resolve(), args.dry_run_unsigned, args.fingerprint)


if __name__ == "__main__":
    sys.exit(main())
