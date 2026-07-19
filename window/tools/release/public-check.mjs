import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

const forbiddenPath = /^(?:\.next|node_modules|coverage|tests|tools)(?:\/|$)|(?:^|\/)\.env|\.tgz$/;
export const packedFileAllowlist = [
  "LICENSE", "README.md", "fixtures/jordan-lee/commitments.json", "fixtures/jordan-lee/manifest.json", "fixtures/jordan-lee/observations.json", "fixtures/jordan-lee/recommendations.json", "fixtures/jordan-lee/state.json", "fixtures/jordan-lee/tasks.json", "next.config.ts", "package.json", "src/app/globals.css", "src/app/layout.tsx", "src/app/page.tsx", "src/contracts/v1.ts", "src/runtime/fixture-adapter.ts", "src/runtime/fixture-integrity.ts", "src/runtime/release-boundary.ts", "src/runtime/runtime-mode.ts",
];
const forbiddenContent = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s"']+|\/(?:home|Users)\/|[A-Z]:\\Users\\|\b(?:AlphaZede|WNDW|Everest|WINDOW_[A-Z0-9_]*)\b|(?:implementation|private)[ -]?(?:plan|prompt)|\b(?:internal preview|private internal|internal prototype|private prototype)\b|(?:github\.com|gitlab\.com|bitbucket\.org|git@|api\.(?:github|linear|openai|google)\.com))/i;

export const inspectPackedFiles = async (root, files) => {
  const failures = [];
  for (const path of files) {
    if (forbiddenPath.test(path)) failures.push(`forbidden packed path: ${path}`);
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${resolve(root)}${sep}`) && absolute !== resolve(root)) failures.push(`unsafe packed path: ${path}`);
    else if (!failures.some((failure) => failure.endsWith(`: ${path}`))) {
      const content = await readFile(absolute, "utf8");
      if (forbiddenContent.test(content)) failures.push(`forbidden packed content: ${path}`);
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
