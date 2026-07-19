import { loadRuntimeMode } from "./runtime-mode";

const reviewedDependencies = {
  "@js-temporal/polyfill": "0.5.1", next: "16.2.10", react: "19.2.7", "react-dom": "19.2.7", zod: "4.4.3",
} as const;
const reviewedScripts = {
  build: "next build", check: "pnpm run public:check", dev: "next dev", lint: "eslint .", "public:check": "node ./tools/release/public-check.mjs",
  "public:verify": "pnpm run verify", smoke: "node ./tools/release/startup-smoke.mjs", test: "vitest run", typecheck: "tsc --noEmit", verify: "sh ./tools/ci/verify.sh",
} as const;
type PackageManifest = { private?: boolean; license?: string; dependencies?: Record<string, string>; scripts?: Record<string, string> };
const exact = (actual: Record<string, string> | undefined, expected: Record<string, string>) =>
  !!actual && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name, value]) => actual[name] === value);

/** Release evidence only; it cannot deploy or publish. */
export const verifyPublic = (packageManifest: PackageManifest) =>
  packageManifest.private === true
  && packageManifest.license === "Apache-2.0"
  && exact(packageManifest.dependencies, reviewedDependencies)
  && exact(packageManifest.scripts, reviewedScripts)
  && loadRuntimeMode({}) === "synthetic";

export const ReleaseBoundary = { verifyPublic };
