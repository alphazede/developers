import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(ReleaseBoundary.verifyPublic({ ...manifest, name: "Win" + "dow" })).toBe(false);
    expect(ReleaseBoundary.verifyPublic({ ...manifest, files: [...manifest.files, "DESIGN.md"] })).toBe(false);
    expect(ReleaseBoundary.verifyPublic({ ...manifest, dependencies: { ...manifest.dependencies, zod: "latest" } })).toBe(false);
    expect(loadRuntimeMode({ APP_RUNTIME_MODE: "live" })).toBe("live");
  });

  it("rejects forbidden packed paths, public content, and credential values", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-"));
    try {
      const leaks = [
        "Alpha" + "Zede", "WN" + "DW", "Ever" + "est", "Win" + "dow", "WINDOW" + "_RUNTIME_MODE", "/" + "home/example", "private " + "plan", "internal " + "preview",
        "token=credential", "secret = 'non-empty'", '"api_key": "key-value"', "password=hunter2",
        'GITHUB_TOKEN="ghp_1234567890"', "APP_DATA_KEY='data-key-value'", "client_secret=`client-secret-value`",
        "access-token=bareAccess123", '"data-key": "quoted-data-key"', "clientSecret='client-value'",
        'googleClientSecret="google-client-value"', "linearAccessToken='linear-access-value'", "someServiceApiKey=`service-api-value`",
        "googleRefreshToken=bareRefresh123", "oauthAccessToken=bareOauth123", 'backupServicePassword="backup-password"', "storageServiceDataKey=bareDataKey123",
      ];
      await Promise.all([
        writeFile(join(root, "safe.txt"), "daily focus windows"),
        ...leaks.map((content, index) => writeFile(join(root, `leak-${index}.txt`), content)),
      ]);
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      const failures = await inspectPackedFiles(root, ["safe.txt", ".next/hidden.ts", ".local/owner.json", "playwright-report/index.html", ...leaks.map((_, index) => `leak-${index}.txt`)]);
      expect(failures).toEqual(expect.arrayContaining([
        "forbidden packed path: .next/hidden.ts", "forbidden packed path: .local/owner.json", "forbidden packed path: playwright-report/index.html",
        ...leaks.map((_, index) => `forbidden packed content: leak-${index}.txt`),
      ]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows credential type declarations, identifiers, empty values, and error codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-safe-"));
    try {
      const safe = [
        "type Envelope = { token: string; apiKey?: string; password: string; GITHUB_TOKEN: string; APP_DATA_KEY?: Buffer; client_secret: CustomSecret; accessToken: TokenValue; dataKey: Buffer }",
        "const equalSecret = constantTimeEqual",
        'const codes = ["invalid-token", "missing-client_secret", "bad-access-token"]',
        'const token = ""; const GITHUB_TOKEN = ""; const APP_DATA_KEY = \'\'; const client_secret = ``',
        "const accessToken = undefined; const dataKey = null",
        "type CamelCredentials = { googleClientSecret: string; linearAccessToken: AccessToken; someServiceApiKey?: string; googleRefreshToken: TokenValue; oauthAccessToken: string; backupServicePassword: string; storageServiceDataKey: Buffer }",
        'const googleClientSecret = ""; const linearAccessToken = \'\'; const someServiceApiKey = ``',
        'const someServiceEndpoint = "public"; const customerApiKeyStatus = "missing"; const credentialHelper = "safe"',
        '{"nextPageToken":"synthetic-page-2"}',
      ];
      await Promise.all(safe.map((content, index) => writeFile(join(root, `safe-${index}.txt`), content)));
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      expect(await inspectPackedFiles(root, safe.map((_, index) => `safe-${index}.txt`))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows only reviewed URL values in their exact packed source paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-urls-"));
    const approved = {
      "src/server/oauth/one-time.ts": [
        "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token",
        "https://linear.app/oauth/authorize", "https://api.linear.app/oauth/token",
        "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events",
      ],
      "src/server/oauth/github-installation.ts": ["https://github.com/apps/${this.appSlug}/installations/new?${new"],
      "src/server/connectors/live-runtime.ts": [
        "https://www.googleapis.com/calendar/v3/calendars/primary/events", "https://oauth2.googleapis.com/revoke",
        "https://api.github.com", "https://api.linear.app/graphql",
      ],
    } as const;
    try {
      for (const [path, values] of Object.entries(approved)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), values.map((value) => `\"${value}\"`).join("\n"));
      }
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      expect(await inspectPackedFiles(root, Object.keys(approved))).toEqual([]);
      await writeFile(join(root, "src/server/oauth/one-time.ts"), '"https://example.invalid/oauth/token"');
      expect(await inspectPackedFiles(root, ["src/server/oauth/one-time.ts"])).toEqual(["forbidden packed URL: src/server/oauth/one-time.ts"]);
      await writeFile(join(root, "src/server/oauth/one-time.ts"), '"https://api.linear.app/oauth/token?credential=literal"');
      expect(await inspectPackedFiles(root, ["src/server/oauth/one-time.ts"])).toEqual(["forbidden packed URL: src/server/oauth/one-time.ts"]);
      await writeFile(join(root, "wrong.ts"), '"https://api.linear.app/oauth/token"');
      expect(await inspectPackedFiles(root, ["wrong.ts"])).toEqual(["forbidden packed URL: wrong.ts"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies credential keys across case styles, acronyms, and value forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-credential-table-"));
    const cases = [
      ["upper snake", 'GITHUB_TOKEN="ghp_1234567890"'],
      ["upper multiword snake", "APP_DATA_KEY='data-key-value'"],
      ["lower snake template", "client_secret=`client-secret-value`"],
      ["kebab bare", "access-token=bareAccess123"],
      ["short camel password", 'dbPassword="db-password-value"'],
      ["short camel token", "serviceToken='service-token-value'"],
      ["camel API key", "myApiKey=`my-api-value`"],
      ["camel acronym token", "githubOAuthAccessToken=bareOauth123"],
      ["multiword camel secret", 'googleClientSecret="google-client-value"'],
      ["multiword camel access", "linearAccessToken='linear-access-value'"],
      ["multiword camel API", "someServiceApiKey=`service-api-value`"],
      ["multiword camel refresh", "googleRefreshToken=bareRefresh123"],
      ["OAuth camel access", "oauthAccessToken=bareOauth456"],
    ] as const;
    try {
      await Promise.all(cases.map(([, content], index) => writeFile(join(root, `case-${index}.txt`), content)));
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      const failures = await inspectPackedFiles(root, cases.map((_, index) => `case-${index}.txt`));
      expect(failures).toEqual(cases.map((_, index) => `forbidden packed content: case-${index}.txt`));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps declarations, function identifiers, errors, placeholders, and unrelated camel case safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "packed-credential-negatives-"));
    const cases = [
      "type Values = { token: string; tokenEnvelope: SomeCredentialType; serviceToken: SomeCredentialType; myApiKey?: string; githubOAuthAccessToken: AccessToken }",
      "const equalSecret = constantTimeEqual; const compareClientSecret = constantTimeEqual",
      'const codes = ["invalid-token", "missing-client_secret", "bad-access-token"]',
      'const token = ""; const dbPassword = \'\'; const myApiKey = ``',
      'const someServiceEndpoint = "public"; const customerApiKeyStatus = "missing"; const credentialHelper = "safe"',
    ] as const;
    try {
      await Promise.all(cases.map((content, index) => writeFile(join(root, `case-${index}.txt`), content)));
      const { inspectPackedFiles } = await import(publicCheckPath.href);
      expect(await inspectPackedFiles(root, cases.map((_, index) => `case-${index}.txt`))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the packed runtime file contract exact", async () => {
    const { inspectPackContract, packManifest, packedFileAllowlist } = await import(publicCheckPath.href);
    expect(packedFileAllowlist).toEqual([...packedFileAllowlist].sort());
    expect(packedFileAllowlist).toHaveLength(133);
    expect(packedFileAllowlist).toContain("e2e/egress-guard.ts");
    expect(packedFileAllowlist).toContain("src/app/dashboard/page.tsx");
    expect(packedFileAllowlist.some((path: string) => path.startsWith(".local/"))).toBe(false);
    expect(packedFileAllowlist).not.toContain("DESIGN.md");
    expect(packManifest(new URL("../..", import.meta.url).pathname)).toEqual(packedFileAllowlist);
    expect(inspectPackContract(packedFileAllowlist)).toEqual([]);
    expect(inspectPackContract(packedFileAllowlist.filter((path: string) => path !== "src/app/page.tsx"))).toContain("missing packed contract file: src/app/page.tsx");
    expect(inspectPackContract([...packedFileAllowlist, "fixtures/neutral.json"])).toContain("unexpected packed contract file: fixtures/neutral.json");
    expect(inspectPackContract([...packedFileAllowlist, "src/neutral.ts"])).toContain("unexpected packed contract file: src/neutral.ts");
  });

  it("keeps owner-only local state out of git and the package files contract", async () => {
    const root = new URL("../..", import.meta.url);
    expect((await readFile(new URL(".gitignore", root), "utf8")).split(/\r?\n/)).toContain(".local/");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { files: string[] };
    expect(manifest.files).not.toContain(".");
    expect(manifest.files.some((path) => path === ".local" || path.startsWith(".local/"))).toBe(false);
    const { packManifest } = await import(publicCheckPath.href);
    expect(packManifest(root.pathname).some((path: string) => path.startsWith(".local/"))).toBe(false);
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

  it("preserves selected-loopback fetch options", () => {
    const script = "const http=require('node:http'); const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>res.end(req.method+' '+req.headers['x-test']+' '+body))}).listen(0,'127.0.0.1',async()=>{const port=server.address().port;process.env.APP_SMOKE_PORT=String(port);require('./tools/release/no-network-guard.cjs');const response=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{'x-test':'kept'},body:'payload'});process.stdout.write(await response.text());server.close()})";
    const result = spawnSync(process.execPath, ["-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("POST kept payload");
  });

  it("allows only the declared Turbopack build-child IPC port", () => {
    const script = "const net=require('node:net');const server=net.createServer(socket=>socket.end('ipc')).listen(0,'127.0.0.1',()=>{const port=server.address().port;process.env.APP_ALLOW_TURBOPACK_IPC='1';process.argv[2]=String(port);require('./tools/release/no-network-guard.cjs');const socket=net.connect(port,'127.0.0.1');socket.on('data',value=>process.stdout.write(value));socket.on('end',()=>server.close())})";
    const result = spawnSync(process.execPath, ["-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ipc");
  });
});
