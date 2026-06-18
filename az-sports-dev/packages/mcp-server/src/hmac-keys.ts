import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { writeCliStderr } from "./output-sink-registry.js";

const ROOT_SECRET = loadRootSecret();
const SECRET_A = deriveKey(ROOT_SECRET, "params_hash");
const SECRET_B = deriveKey(ROOT_SECRET, "identity_key");

export function paramsHash(params: unknown): string {
  return createHmac("sha256", SECRET_A)
    .update(canonicalStringify(params))
    .digest("hex");
}

export function identityKey(identitySource: string): string {
  // Keyed pseudonymous identifier for observability, not password storage.
  return createHmac("sha256", SECRET_B).update(identitySource).digest("hex");
}

function canonicalStringify(value: unknown): string {
  return stringifyValue(value, new WeakSet<object>());
}

function stringifyValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) {
    return "null";
  }

  const valueType = typeof value;
  if (valueType === "function" || valueType === "symbol") {
    throw new TypeError("Cannot canonicalize functions or symbols");
  }

  if (valueType !== "object") {
    return JSON.stringify(value);
  }

  if (seen.has(value as object)) {
    throw new TypeError("Cannot canonicalize circular values");
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value.map((item) => stringifyValue(item, seen));
    seen.delete(value as object);
    return `[${items.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const properties = keys.map(
    (key) => `${JSON.stringify(key)}:${stringifyValue(record[key], seen)}`,
  );
  seen.delete(value as object);
  return `{${properties.join(",")}}`;
}

function loadRootSecret(): Buffer {
  const configured = process.env.AZS_MCP_OBS_HMAC_SECRET;
  if (!configured) {
    writeCliStderr(
      "[WARN] AZS_MCP_OBS_HMAC_SECRET not set; params_hash will rotate on restart.\n",
    );
    return randomBytes(32);
  }
  return validateSecret(configured.trim());
}

function deriveKey(rootSecret: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", rootSecret, Buffer.alloc(0), info, 32));
}

function validateSecret(value: string): Buffer {
  const bytes = Buffer.from(value, "hex");
  if (!/^[0-9a-fA-F]{64}$/.test(value) || bytes.length !== 32) {
    throw new Error(
      "AZS_MCP_OBS_HMAC_SECRET must be 32 random bytes as hex. Generate with: openssl rand -hex 32",
    );
  }
  if (bytes.every((byte) => byte === 0x00)) {
    throw new Error(
      "AZS_MCP_OBS_HMAC_SECRET must not be all zero bytes. Generate with: openssl rand -hex 32",
    );
  }
  if (bytes.every((byte) => byte === 0xff)) {
    throw new Error(
      "AZS_MCP_OBS_HMAC_SECRET must not be all 0xff bytes. Generate with: openssl rand -hex 32",
    );
  }
  if (bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
    throw new Error(
      "AZS_MCP_OBS_HMAC_SECRET must not be an ASCII-printable pattern. Generate with: openssl rand -hex 32",
    );
  }
  if (isRepeatedPattern(bytes)) {
    throw new Error(
      "AZS_MCP_OBS_HMAC_SECRET must not be a repeated byte pattern. Generate with: openssl rand -hex 32",
    );
  }
  const entropy = shannonBitEntropyPerByte(bytes);
  if (entropy < 6.5) {
    throw new Error(
      `AZS_MCP_OBS_HMAC_SECRET entropy is too low (${entropy.toFixed(1)} bits/byte). Generate with: openssl rand -hex 32`,
    );
  }
  return bytes;
}

function isRepeatedPattern(bytes: Buffer): boolean {
  for (let width = 1; width <= bytes.length / 2; width += 1) {
    if (
      bytes.length % width === 0 &&
      bytes.every((byte, index) => byte === bytes[index % width])
    ) {
      return true;
    }
  }
  return false;
}

function shannonBitEntropyPerByte(bytes: Buffer): number {
  let ones = 0;
  for (const byte of bytes) {
    ones += byte.toString(2).replaceAll("0", "").length;
  }
  const totalBits = bytes.length * 8;
  const p1 = ones / totalBits;
  if (p1 === 0 || p1 === 1) {
    return 0;
  }
  const p0 = 1 - p1;
  return 8 * (-(p0 * Math.log2(p0)) - p1 * Math.log2(p1));
}
