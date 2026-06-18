/**
 * Secure local token storage for MCP CLI credentials.
 *
 * SecureFile provides a file-abstraction with explicit invariant checks:
 *   - Write: atomic rename with exclusive temp-file creation
 *   - Write: dir fsync after rename for durability
 *   - Read: symlink rejection (open with O_NOFOLLOW + fstat)
 *   - Read: hardlink rejection (nlink > 1 check)
 *   - Read/Write: mode enforcement (0o600 for files, 0o700 for dir)
 *   - Read/Write: ownership check (file uid must match process uid)
 *   - Delete: full file invariant check before overwrite/unlink
 *   - Delete: overwrite-before-unlink to reduce forensic recoverability
 *
 * What chmod cannot defend against:
 *   On Linux, file permissions are enforced by the kernel but do not protect
 *   against a root process, a process running as the same uid, or a process
 *   with CAP_DAC_OVERRIDE. chmod 0600 means no other non-root user can read
 *   the file; it does NOT protect against the file owner's other processes,
 *   against root, or against an attacker who has already escalated to the same
 *   uid. The overwrite-before-unlink pattern reduces forensic recovery from
 *   disk imaging but is not a guarantee on SSDs with wear-leveling. Future
 *   hardening: OS keychain promotion (macOS Keychain, Linux Secret Service,
 *   Windows DPAPI) would move the plaintext out of the filesystem entirely.
 *   See the public MCP security notes.
 *
 * ACL behavior on non-Linux platforms:
 *   - macOS: HFS+/APFS ACLs can grant additional access beyond POSIX mode bits.
 *     The ownership check (`uid === process.getuid()`) is the primary guard;
 *     ACLs are not inspected. Tests run on Linux; macOS-specific ACL tests are
 *     skipped in CI.
 *   - Windows: NTFS ACLs are the access-control mechanism; POSIX mode bits do
 *     not apply. The token-store is not supported on Windows (login command
 *     logs a warning if `process.platform === 'win32'`). Windows-specific
 *     tests are skipped.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isValidStoredMcpToken,
  normalizedStoredMcpToken,
} from "./auth-token.js";
import { writeCliStderr } from "./output-sink-registry.js";

const TOKEN_DIR_MODE = 0o700;
const TOKEN_FILE_MODE = 0o600;
const O_NOFOLLOW =
  typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : null;
export const DEFAULT_MCP_CLIENT_ID = "azs-claude-mcp";
const MCP_CLIENT_ID_PATTERN = /^azs-(claude|cursor|codex|gemini)-mcp$/;

// ---------------------------------------------------------------------------
// SecureFile class
// ---------------------------------------------------------------------------

/**
 * SecureFile wraps fs operations with consistent invariant checks.
 * All public methods throw on invariant violation rather than returning null.
 */
export class SecureFile {
  readonly path: string;
  readonly expectedMode: number;
  readonly label: string;

  constructor(path: string, expectedMode: number, label: string) {
    this.path = path;
    this.expectedMode = expectedMode;
    this.label = label;
  }

  /**
   * Read the file content after verifying all security invariants.
   * Returns null if the file does not exist.
   */
  read(): string | null {
    const fd = openExistingNoFollow(
      this.path,
      fs.constants.O_RDONLY,
      this.label,
    );
    if (fd === null) {
      return null;
    }

    try {
      this.verifyReadStats(fs.fstatSync(fd));
      return fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  private verifyReadStats(stats: fs.Stats): void {
    // Reject symlinks
    if (!stats.isFile()) {
      throw new Error(
        `${this.label}: token file is not a regular file (possible symlink or special file).`,
      );
    }

    // Reject hardlinks (nlink > 1 means multiple directory entries point here)
    if (stats.nlink > 1) {
      throw new Error(
        `${this.label}: token file has ${stats.nlink} hard links; refusing to read (possible hardlink attack).`,
      );
    }

    // Ownership check: file must be owned by the current process user
    checkOwnership(stats, this.label);

    // Mode check
    const mode = stats.mode & 0o777;
    if (mode !== this.expectedMode) {
      throw new Error(
        `${this.label}: token file has insecure permissions: ${formatMode(mode)}. Expected ${formatMode(this.expectedMode)}.`,
      );
    }
  }

  /**
   * Atomically write the file using a temp-file + rename pattern.
   * Syncs the file data and the containing directory after rename.
   */
  write(value: string): void {
    const tempFile = `${this.path}.tmp.${randomBytes(8).toString("hex")}`;
    const fd = fs.openSync(
      tempFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        requireNoFollow(this.label),
      this.expectedMode,
    );
    try {
      fs.fchmodSync(fd, this.expectedMode);
      fs.writeFileSync(fd, value, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempFile, this.path);

    // Dir fsync: flush the directory entry so the rename is durable
    const dirFd = fs.openSync(dirname(this.path), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }

    tightenMode(this.path, this.expectedMode, this.label);
    this.verify();
  }

  /**
   * Overwrite with random bytes before unlinking to reduce forensic recovery.
   * Opens with O_NOFOLLOW and validates the opened file descriptor before any
   * destructive write.
   */
  delete(): void {
    const fd = openExistingNoFollow(this.path, fs.constants.O_RDWR, this.label);
    if (fd === null) {
      return;
    }
    const deleteStats = fs.fstatSync(fd);
    this.verifyReadStats(deleteStats);
    const length = Math.max(deleteStats.size, 64);
    try {
      fs.writeSync(fd, randomBytes(length), 0, length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(this.path);
  }

  /**
   * Post-write invariant check (not a substitute for the read-path checks).
   */
  verify(): void {
    const fd = openExistingNoFollow(
      this.path,
      fs.constants.O_RDONLY,
      this.label,
    );
    if (fd === null) {
      throw new Error(`${this.label}: token file is missing after write.`);
    }
    try {
      this.verifyReadStats(fs.fstatSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------------------
// Token-store public API (thin wrappers over SecureFile)
// ---------------------------------------------------------------------------

export function getTokenDir(): string {
  return join(homedir(), ".config", "alphazede-sports");
}

export function getTokenFile(): string {
  return join(getTokenDir(), "token");
}

export function getClientIdFile(): string {
  return join(getTokenDir(), "client_id");
}

export function readToken(): string | null {
  const token = new SecureFile(
    getTokenFile(),
    TOKEN_FILE_MODE,
    "TOKEN_FILE",
  ).read();
  if (token === null) {
    return null;
  }
  if (!isValidStoredMcpToken(token)) {
    throw new Error("Stored MCP token is invalid.");
  }
  return normalizedStoredMcpToken(token);
}

export function readClientId(): string | null {
  const value = new SecureFile(
    getClientIdFile(),
    TOKEN_FILE_MODE,
    "CLIENT_ID_FILE",
  ).read();
  if (!value) {
    return null;
  }
  if (!MCP_CLIENT_ID_PATTERN.test(value)) {
    throw new Error("Stored MCP client_id is invalid.");
  }
  return value;
}

export function writeToken(
  token: string,
  clientId: string = DEFAULT_MCP_CLIENT_ID,
): void {
  if (!isValidStoredMcpToken(token)) {
    throw new Error("Invalid MCP token.");
  }
  if (!MCP_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("Invalid MCP client_id.");
  }
  const storedToken = normalizedStoredMcpToken(token);
  const tokenDir = getTokenDir();
  fs.mkdirSync(tokenDir, { recursive: true, mode: TOKEN_DIR_MODE });
  tightenMode(tokenDir, TOKEN_DIR_MODE, "TOKEN_DIR");

  new SecureFile(getTokenFile(), TOKEN_FILE_MODE, "TOKEN_FILE").write(
    storedToken,
  );
  new SecureFile(getClientIdFile(), TOKEN_FILE_MODE, "CLIENT_ID_FILE").write(
    clientId,
  );
}

export function deleteToken(): void {
  new SecureFile(getTokenFile(), TOKEN_FILE_MODE, "TOKEN_FILE").delete();
  new SecureFile(getClientIdFile(), TOKEN_FILE_MODE, "CLIENT_ID_FILE").delete();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkOwnership(stats: fs.Stats, label: string): void {
  // process.getuid() is undefined on Windows; skip ownership check there.
  if (typeof process.getuid !== "function") {
    return;
  }
  const processUid = process.getuid();
  if (stats.uid !== processUid) {
    throw new Error(
      `${label}: token file is owned by uid ${stats.uid} but current process uid is ${processUid}; refusing to read.`,
    );
  }
}

function tightenMode(path: string, expectedMode: number, label: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | requireNoFollow(label));
  try {
    const actualMode = fs.fstatSync(fd).mode & 0o777;
    if (actualMode === expectedMode) {
      return;
    }

    fs.fchmodSync(fd, expectedMode);
    writeCliStderr(
      `tightened ${label} permissions from ${formatMode(actualMode)} to ${formatMode(expectedMode)}\n`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

function openExistingNoFollow(
  path: string,
  flags: number,
  label: string,
): number | null {
  try {
    return fs.openSync(path, flags | requireNoFollow(label));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    if (isNodeErrorCode(error, "ELOOP")) {
      throw new Error(
        `${label}: token file is not a regular file (possible symlink or special file).`,
      );
    }
    throw error;
  }
}

function requireNoFollow(label: string): number {
  if (O_NOFOLLOW === null) {
    throw new Error(
      `${label}: O_NOFOLLOW is unavailable on this platform; refusing token file access.`,
    );
  }
  return O_NOFOLLOW;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}
