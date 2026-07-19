import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import type { FixtureManifestV1 } from "../contracts/v1";

export type VerifiedFixtureFiles = ReadonlyMap<string, Uint8Array>;

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Verifies frozen fixture files before their JSON is handed to an adapter. */
export class FixtureIntegrity {
  async verify(directory: URL, manifest: FixtureManifestV1): Promise<VerifiedFixtureFiles> {
    if (directory.protocol !== "file:") throw new Error("Fixture directory must be local");

    const names = Object.keys(manifest.files);
    if (names.some((name) => name.includes("/") || name.includes("\\") || name === "manifest.json")) {
      throw new Error("Fixture manifest contains an unsafe file name");
    }
    const actual = (await readdir(directory)).sort();
    const expected = ["manifest.json", ...names].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error("Fixture files do not exactly match the manifest");
    }

    const files = new Map<string, Uint8Array>();
    for (const name of names) {
      const bytes = await readFile(new URL(name, directory));
      const declared = manifest.files[name];
      if (digest(bytes) !== declared.sha256) throw new Error(`Fixture hash mismatch: ${name}`);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const count = Array.isArray(parsed) ? parsed.length : 1;
      if (count !== declared.count) throw new Error(`Fixture count mismatch: ${name}`);
      files.set(name, bytes);
    }
    return files;
  }
}
