import { loadRuntimeMode } from "./runtime-mode";

const reviewedDependencies = {
  "@dnd-kit/core": "6.3.1", "@js-temporal/polyfill": "0.5.1", "@tailwindcss/postcss": "4.3.3",
  echarts: "6.1.0", motion: "12.42.2", next: "16.2.10", react: "19.2.7", "react-dom": "19.2.7",
  tailwindcss: "4.3.3", zod: "4.4.3",
} as const;
const reviewedScripts = {
  build: "next build", check: "pnpm run public:check", dev: "next dev", judge: "node ./tools/release/judge.mjs", lint: "eslint .",
  "public:check": "node ./tools/release/public-check.mjs", "public:verify": "pnpm run verify", smoke: "node ./tools/release/startup-smoke.mjs",
  test: "vitest run", "test:e2e": "playwright test", typecheck: "tsc --noEmit", verify: "sh ./tools/ci/verify.sh",
} as const;
const reviewedFiles = [
  "src", "fixtures/jordan-lee", "fixtures/connectors/microsoft", "fixtures/connectors/strava", "fixtures/connectors/oura", "fixtures/connectors/ics",
  "tests/application", "tests/app", "tests/components", "tests/contracts", "tests/domain", "tests/release", "tests/runtime", "tests/server/oauth", "tests/server/security", "tests/storage", "tests/ui", "tests/adapters/fixtures", "tests/adapters/ics",
  "e2e", "tools", "next.config.ts", "playwright.config.ts", "postcss.config.mjs", "tsconfig.json", "vitest.config.ts", "eslint.config.mjs", "README.md", "LICENSE",
] as const;
type PackageManifest = { name?: string; version?: string; description?: string; private?: boolean; license?: string; files?: string[]; dependencies?: Record<string, string>; scripts?: Record<string, string> };
const exact = (actual: Record<string, string> | undefined, expected: Record<string, string>) =>
  !!actual && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name, value]) => actual[name] === value);
const exactFiles = (actual: string[] | undefined) => !!actual && actual.length === reviewedFiles.length && reviewedFiles.every((path) => actual.includes(path));

/** Release evidence only; it cannot deploy or publish. */
export const verifyPublic = (packageManifest: PackageManifest) =>
  packageManifest.name === "capacity-scheduling-prototype"
  && packageManifest.version === "0.0.0"
  && packageManifest.description === "Unpublished capacity-scheduling prototype using deterministic synthetic data."
  && packageManifest.private === true
  && packageManifest.license === "Apache-2.0"
  && exactFiles(packageManifest.files)
  && exact(packageManifest.dependencies, reviewedDependencies)
  && exact(packageManifest.scripts, reviewedScripts)
  && loadRuntimeMode({}) === "synthetic";

export const ReleaseBoundary = { verifyPublic };
