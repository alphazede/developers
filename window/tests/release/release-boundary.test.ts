import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ReleaseBoundary } from "../../src/runtime/release-boundary";
import { loadRuntimeMode } from "../../src/runtime/runtime-mode";

const packagePath = new URL("../../package.json", import.meta.url);
const publicCheckPath = new URL("../../tools/release/public-check.mjs", import.meta.url);
const guardPath = new URL("../../tools/release/no-network-guard.cjs", import.meta.url);

describe("release boundary", () => {
  it("rejects changed dependencies, public packages, and license mismatches", async () => {
    const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(packagePath, "utf8"));
    expect(ReleaseBoundary.verifyPublic(manifest)).toBe(true);
    expect(ReleaseBoundary.verifyPublic({ ...manifest, private: false })).toBe(false);
    expect(ReleaseBoundary.verifyPublic({ ...manifest, license: "MIT" })).toBe(false);
    expect(ReleaseBoundary.verifyPublic({ ...manifest, dependencies: { ...manifest.dependencies, zod: "latest" } })).toBe(false);
    expect(loadRuntimeMode({ APP_RUNTIME_MODE: "live" })).toBe("live");
  });

  it("rejects forbidden packed paths and content while allowing focus windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-"));
    try {
      const leaks = ["AlphaZede", "WNDW", "Everest", "WINDOW_RUNTIME_MODE", "/home/example", "private plan", "token=credential", "internal preview"];
      await Promise.all([
        writeFile(join(root, "safe.txt"), "daily focus windows"),
        ...leaks.map((content, index) => writeFile(join(root, `leak-${index}.txt`), content)),
      ]);
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      const failures = await inspectPackedFiles(root, ["safe.txt", "tests/hidden.ts", ...leaks.map((_, index) => `leak-${index}.txt`)]);
      expect(failures).toEqual(expect.arrayContaining(["forbidden packed path: tests/hidden.ts", ...leaks.map((_, index) => `forbidden packed content: leak-${index}.txt`)]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the packed runtime file contract exact", async () => {
    const { inspectPackContract, packedFileAllowlist } = await import(publicCheckPath.href);
    expect(packedFileAllowlist).toEqual([...packedFileAllowlist].sort());
    expect(inspectPackContract(packedFileAllowlist)).toEqual([]);
    expect(inspectPackContract(packedFileAllowlist.filter((path: string) => path !== "src/app/page.tsx"))).toContain("missing packed contract file: src/app/page.tsx");
    expect(inspectPackContract([...packedFileAllowlist, "fixtures/neutral.json"])).toContain("unexpected packed contract file: fixtures/neutral.json");
    expect(inspectPackContract([...packedFileAllowlist, "src/neutral.ts"])).toContain("unexpected packed contract file: src/neutral.ts");
  });

  for (const [name, source, expectedReceipt] of [
    ["fetch", "fetch('https://example.invalid').catch(() => {})", "fetch"],
    ["http", "try { require('node:http').get('http://example.invalid') } catch {}", "http"],
    ["https", "try { require('node:https').get('https://example.invalid') } catch {}", "https"],
    ["callback-DNS", "try { require('node:dns').resolve('example.invalid', () => {}) } catch {}", "dns.resolve"],
    ["promise-DNS", "require('node:dns').promises.resolve('example.invalid').catch(() => {})", "dns.promises.resolve"],
    ["socket", "try { require('node:net').connect(443, 'example.invalid') } catch {}", "socket"],
    ["TLS", "try { require('node:tls').connect(443, 'example.invalid') } catch {}", "tls"],
  ]) {
    it(`records caught denied ${name} egress and fails the process`, async () => {
      const root = await mkdtemp(join(tmpdir(), "network-receipt-"));
      const receipt = join(root, "receipt");
      try {
        const result = spawnSync(process.execPath, ["--require", guardPath.pathname, "-e", source], {
          env: { ...process.env, APP_SMOKE_PORT: "1", APP_NETWORK_RECEIPT: receipt }, encoding: "utf8",
        });
        expect(result.status).not.toBe(0);
        expect(await readFile(receipt, "utf8")).toContain(expectedReceipt);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }

  it("allows the selected loopback smoke port", () => {
    const script = "const http=require('node:http'); const server=http.createServer((_,res)=>res.end('neutral marker')).listen(0,'127.0.0.1',()=>{const port=server.address().port; process.env.APP_SMOKE_PORT=String(port); require('./tools/release/no-network-guard.cjs'); http.get('http://127.0.0.1:'+port,res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{process.stdout.write(body);server.close()})})})";
    const result = spawnSync(process.execPath, ["-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("neutral marker");
  });
});
