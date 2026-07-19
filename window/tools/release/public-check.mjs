import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

const forbiddenPath = /^(?:\.next|node_modules|coverage|tests|tools)(?:\/|$)|(?:^|\/)\.env|\.tgz$/;
export const packedFileAllowlist = [
  "LICENSE", "README.md", "fixtures/jordan-lee/commitments.json", "fixtures/jordan-lee/manifest.json", "fixtures/jordan-lee/observations.json", "fixtures/jordan-lee/recommendations.json", "fixtures/jordan-lee/state.json", "fixtures/jordan-lee/tasks.json", "next.config.ts", "package.json", "src/app/globals.css", "src/app/layout.tsx", "src/app/page.tsx", "src/contracts/v1.ts", "src/domain/focus-gate/index.ts", "src/domain/time/index.ts", "src/runtime/fixture-adapter.ts", "src/runtime/fixture-integrity.ts", "src/runtime/release-boundary.ts", "src/runtime/runtime-mode.ts", "src/server/security/crypto.ts", "src/server/security/session-guard.ts", "src/storage/local-store/local-store.ts",
];
const assignment = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([A-Za-z_$][A-Za-z0-9_$-]*))\s*([:=])\s*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|[^\s,;}\r\n]+)/g;
const placeholders = new Set(["string", "number", "boolean", "unknown", "undefined", "null", "never", "void"]);

const splitKey = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[\s_-]+/)
  .filter(Boolean)
  .map((word) => word.toLowerCase());

const credentialKey = (key) => {
  const words = splitKey(key);
  const last = words.at(-1);
  return last === "token" || last === "secret" || last === "password"
    || ((words.at(-2) === "api" || words.at(-2) === "data") && last === "key");
};

const plausibleBareValue = (value) => /^[A-Za-z0-9_./+@=-]{6,}$/.test(value)
  && !placeholders.has(value.toLowerCase())
  && (value === value.toLowerCase() || value === value.toUpperCase() || /[0-9_./+@=-]/.test(value));

const forbiddenCredential = (content) => {
  assignment.lastIndex = 0;
  for (const match of content.matchAll(assignment)) {
    const key = match[1] ?? match[2] ?? match[3] ?? match[4];
    const operator = match[5];
    const value = match[6];
    if (!credentialKey(key)) continue;
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.at(-1) === quote) {
      if (value.length > 2) return true;
    } else if (operator === "=" && plausibleBareValue(value)) return true;
  }
  return false;
};
const forbiddenContent = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\/(?:home|Users)\/|[A-Z]:\\Users\\|\b(?:AlphaZede|WNDW|Everest|WINDOW_[A-Z0-9_]*)\b|(?:implementation|private)[ -]?(?:plan|prompt)|\b(?:internal preview|private internal|internal prototype|private prototype)\b|(?:github\.com|gitlab\.com|bitbucket\.org|git@|api\.(?:github|linear|openai|google)\.com))/i;

export const inspectPackedFiles = async (root, files) => {
  const failures = [];
  for (const path of files) {
    if (forbiddenPath.test(path)) failures.push(`forbidden packed path: ${path}`);
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${resolve(root)}${sep}`) && absolute !== resolve(root)) failures.push(`unsafe packed path: ${path}`);
    else if (!failures.some((failure) => failure.endsWith(`: ${path}`))) {
      const content = await readFile(absolute, "utf8");
      if (forbiddenContent.test(content) || forbiddenCredential(content)) failures.push(`forbidden packed content: ${path}`);
    }
  }
  return failures;
};

export const packManifest = (root) => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "npm pack --dry-run failed");
  const packed = JSON.parse(result.stdout)[0];
  return packed.files.map((file) => file.path);
};

export const inspectPackContract = (files) => {
  const actual = new Set(files);
  const expected = new Set(packedFileAllowlist);
  return [
    ...packedFileAllowlist.filter((path) => !actual.has(path)).map((path) => `missing packed contract file: ${path}`),
    ...files.filter((path) => !expected.has(path)).map((path) => `unexpected packed contract file: ${path}`),
  ];
};

const main = async () => {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const files = packManifest(root);
  const failures = [...await inspectPackedFiles(root, files), ...inspectPackContract(files)];
  if (manifest.private !== true) failures.push("package must remain private");
  if (manifest.license !== "Apache-2.0") failures.push("package license must be Apache-2.0");
  if (!files.includes("LICENSE")) failures.push("packed package is missing LICENSE");
  if (!files.includes("README.md")) failures.push("packed package is missing README.md");
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`public boundary receipt: ${files.join(", ")}`);
};

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
