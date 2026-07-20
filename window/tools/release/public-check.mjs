import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

const forbiddenPath = /^(?:\.next|\.local|\.playwright-cli|node_modules|coverage|test-results|playwright-report)(?:\/|$)|(?:^|\/)\.env|(?:^|\/)DESIGN\.md$|\.tgz$/;
export const packedFileAllowlist = [
  "LICENSE",
  "README.md",
  "e2e/egress-guard.ts",
  "e2e/judge.spec.ts",
  "e2e/privacy.spec.ts",
  "e2e/rhythm.spec.ts",
  "e2e/today.spec.ts",
  "eslint.config.mjs",
  "fixtures/connectors/ics/malicious-control.ics",
  "fixtures/connectors/ics/valid.ics",
  "fixtures/connectors/microsoft/calendar.json",
  "fixtures/connectors/oura/readiness.json",
  "fixtures/connectors/strava/activity.json",
  "fixtures/jordan-lee/commitments.json",
  "fixtures/jordan-lee/manifest.json",
  "fixtures/jordan-lee/observations.json",
  "fixtures/jordan-lee/recommendations.json",
  "fixtures/jordan-lee/state.json",
  "fixtures/jordan-lee/tasks.json",
  "next.config.ts",
  "package.json",
  "playwright.config.ts",
  "postcss.config.mjs",
  "src/adapters/fixtures/index.ts",
  "src/adapters/github/index.ts",
  "src/adapters/google/index.ts",
  "src/adapters/ics/index.ts",
  "src/adapters/linear/index.ts",
  "src/adapters/shared/index.ts",
  "src/app/api/v1/connectors/bootstrap/route.ts",
  "src/app/api/v1/explanation/route.ts",
  "src/app/api/v1/ics/approve/route.ts",
  "src/app/api/v1/ics/export/route.ts",
  "src/app/api/v1/ics/preview/route.ts",
  "src/app/api/v1/oauth/github/callback/route.ts",
  "src/app/api/v1/oauth/github/start/route.ts",
  "src/app/api/v1/oauth/google/callback/route.ts",
  "src/app/api/v1/oauth/google/start/route.ts",
  "src/app/api/v1/oauth/linear/callback/route.ts",
  "src/app/api/v1/oauth/linear/start/route.ts",
  "src/app/api/v1/privacy/export/route.ts",
  "src/app/api/v1/privacy/transition/route.ts",
  "src/app/api/v1/request-boundary.ts",
  "src/app/api/v1/sources/github/revoke/route.ts",
  "src/app/api/v1/sources/github/sync/route.ts",
  "src/app/api/v1/sources/gmail/selected/route.ts",
  "src/app/api/v1/sources/google/revoke/route.ts",
  "src/app/api/v1/sources/google/sync/route.ts",
  "src/app/api/v1/sources/linear/revoke/route.ts",
  "src/app/api/v1/sources/linear/sync/route.ts",
  "src/app/api/v1/today/route.ts",
  "src/app/dashboard/page.tsx",
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/application/connectors/index.ts",
  "src/application/effects/index.ts",
  "src/application/explanation/index.ts",
  "src/application/imports/index.ts",
  "src/application/privacy/index.ts",
  "src/application/proposals/index.ts",
  "src/components/calendar/calendar-model.ts",
  "src/components/calendar/calendar-workspace.tsx",
  "src/components/evidence/evidence-drawer.tsx",
  "src/components/evidence/meeting-warning-panel.tsx",
  "src/components/privacy/explanation-panel.tsx",
  "src/components/rhythm/rhythm-chart.tsx",
  "src/components/rhythm/rhythm-fingerprint.tsx",
  "src/components/sources/source-model.ts",
  "src/components/sources/sources-privacy-section.tsx",
  "src/components/today/accessible-timeline.tsx",
  "src/components/today/optional-state-motion.tsx",
  "src/contracts/v1.ts",
  "src/domain/focus-gate/index.ts",
  "src/domain/meeting-load/index.ts",
  "src/domain/rhythm/index.ts",
  "src/domain/schedule/index.ts",
  "src/domain/time/index.ts",
  "src/runtime/fixture-adapter.ts",
  "src/runtime/fixture-integrity.ts",
  "src/runtime/release-boundary.ts",
  "src/runtime/runtime-mode.ts",
  "src/runtime/today-fixture.ts",
  "src/server/connectors/live-runtime.ts",
  "src/server/oauth/github-installation.ts",
  "src/server/oauth/index.ts",
  "src/server/oauth/one-time.ts",
  "src/server/security/crypto.ts",
  "src/server/security/session-guard.ts",
  "src/storage/local-store/local-store.ts",
  "src/ui/projections/index.ts",
  "tests/adapters/fixtures/deferred-fixtures.test.ts",
  "tests/adapters/ics/ics.test.ts",
  "tests/app/google-routes/google-routes.test.ts",
  "tests/app/ics-routes/ics-routes.test.ts",
  "tests/app/privacy-routes/privacy-routes.test.ts",
  "tests/app/task-source-routes/task-source-routes.test.ts",
  "tests/app/today-route.test.ts",
  "tests/application/connectors/connectors.test.ts",
  "tests/application/effects/effects.test.ts",
  "tests/application/explanation/explanation.test.ts",
  "tests/application/imports/ics-imports.test.ts",
  "tests/application/privacy/privacy.test.ts",
  "tests/application/proposals/proposals.test.ts",
  "tests/components/calendar/calendar-workspace.test.tsx",
  "tests/components/evidence/evidence-drawer.test.tsx",
  "tests/components/evidence/meeting-warning-panel.test.tsx",
  "tests/components/rhythm/optional-state-motion.test.tsx",
  "tests/components/rhythm/rhythm-fingerprint.test.tsx",
  "tests/components/sources/source-privacy.test.tsx",
  "tests/components/today/accessible-timeline.test.tsx",
  "tests/contracts/v1.test.ts",
  "tests/domain/focus-gate/focus-gate-policy.test.ts",
  "tests/domain/meeting-load/meeting-load.test.ts",
  "tests/domain/rhythm/personal-rhythm.test.ts",
  "tests/domain/schedule/scheduler.test.ts",
  "tests/domain/time/time-policy.test.ts",
  "tests/release/release-boundary.test.ts",
  "tests/runtime/today-fixture.test.ts",
  "tests/server/oauth/google-oauth.test.ts",
  "tests/server/oauth/shared-oauth.test.ts",
  "tests/server/security/crypto.test.ts",
  "tests/server/security/session-guard.test.ts",
  "tests/storage/local-store/local-store.test.ts",
  "tests/ui/projections/today-projection.test.ts",
  "tools/ci/verify.sh",
  "tools/release/judge-playwright.config.mjs",
  "tools/release/judge.mjs",
  "tools/release/no-network-guard.cjs",
  "tools/release/public-check.mjs",
  "tools/release/startup-smoke.mjs",
  "tsconfig.json",
  "vitest.config.ts",
];
const assignment = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([A-Za-z_$][A-Za-z0-9_$-]*))\s*([:=])\s*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|[^\s,;}\r\n]+)/g;
const placeholders = new Set(["string", "number", "boolean", "unknown", "undefined", "null", "never", "void"]);
const approvedUrls = new Map([
  ["LICENSE", new Set(["http://www.apache.org/licenses/", "http://www.apache.org/licenses/LICENSE-2.0"])],
  ["e2e/judge.spec.ts", new Set(["https://browser-egress.invalid/http-proof"])],
  ["src/app/layout.tsx", new Set(["http://www.w3.org/2000/svg"])],
  ["src/adapters/google/index.ts", new Set(["https://www.googleapis.com/auth/gmail.addons.current.message.readonly"])],
  ["src/server/connectors/live-runtime.ts", new Set(["https://www.googleapis.com/calendar/v3/calendars/primary/events", "https://oauth2.googleapis.com/revoke", "https://api.github.com", "https://api.linear.app/graphql"])],
  ["src/server/oauth/github-installation.ts", new Set(["http://127.0.0.1:3000/api/v1/oauth/github/callback", "https://github.com/apps/${this.appSlug}/installations/new?${new"])],
  ["src/server/oauth/index.ts", new Set(["https://www.googleapis.com/auth/gmail.addons.current.message.readonly", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token"])],
  ["src/server/oauth/one-time.ts", new Set(["https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://linear.app/oauth/authorize", "https://api.linear.app/oauth/token", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events", "http://127.0.0.1:3000${definition.redirectPath}", "http://127.0.0.1:3000"])],
  ["playwright.config.ts", new Set(["http://127.0.0.1:3100"])],
  ["tools/release/startup-smoke.mjs", new Set(["http://127.0.0.1:${port}/dashboard"])],
  ["tools/release/judge.mjs", new Set(["http://127.0.0.1:${port}/dashboard", "http://127.0.0.1:${port}"])],
  ["tests/app/google-routes/google-routes.test.ts", new Set(["https://accounts.google.com/o/oauth2/v2/auth?safe=1"])],
  ["tests/app/task-source-routes/task-source-routes.test.ts", new Set(["https://github.com/apps/capacity-scheduler/installations/new?safe=1", "https://linear.app/oauth/authorize?safe=1"])],
  ["tests/release/release-boundary.test.ts", new Set(["https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "https://linear.app/oauth/authorize", "https://api.linear.app/oauth/token", "https://api.linear.app/oauth/token?credential=literal", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/calendar/v3/calendars/primary/events", "https://oauth2.googleapis.com/revoke", "https://github.com/apps/${this.appSlug}/installations/new?${new", "https://api.github.com", "https://api.linear.app/graphql", "https://example.invalid/oauth/token", "https://example.invalid", "http://example.invalid", "http://127.0.0.1:"])],
  ["tests/server/oauth/google-oauth.test.ts", new Set(["https://www.googleapis.com/auth/gmail.readonly"])],
  ["tests/server/oauth/shared-oauth.test.ts", new Set(["https://api.linear.app/oauth/token", "https://hostile.example/token"])],
  ["tests/server/security/session-guard.test.ts", new Set(["https://local.test", "https://local.test/path", "https://local.test#fragment", "https://user:pass@local.test", "https://local.test/", "https://local.test:443", "https://local.test.evil", "https://local.test?query=true"])],
]);
const approvedCredentialValues = new Map([
  ["tests/app/google-routes/google-routes.test.ts", new Set(["private"])],
  ["tests/release/release-boundary.test.ts", new Set(["non-empty", "key-value", "ghp_1234567890", "data-key-value", "client-secret-value", "quoted-data-key", "client-value", "google-client-value", "linear-access-value", "service-api-value", "backup-password", "db-password-value", "service-token-value", "my-api-value"])],
  ["tests/server/oauth/google-oauth.test.ts", new Set(["server-secret", "access-private", "refresh-private", "secret"])],
  ["tests/server/oauth/shared-oauth.test.ts", new Set(["linear-secret", "linear-private", "secret", "github-private"])],
]);
const urlLiteral = /https?:\/\/[^\s"'`<>\\)]+/g;

const splitKey = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[\s_-]+/)
  .filter(Boolean)
  .map((word) => word.toLowerCase());

const credentialKey = (key) => {
  const words = splitKey(key);
  const last = words.at(-1);
  if (last === "token" && words.at(-2) === "page") return false;
  return last === "token" || last === "secret" || last === "password"
    || ((words.at(-2) === "api" || words.at(-2) === "data") && last === "key");
};

const plausibleBareValue = (value) => /^[A-Za-z0-9_./+@=-]{6,}$/.test(value)
  && !placeholders.has(value.toLowerCase())
  && (value === value.toLowerCase() || value === value.toUpperCase() || /[0-9_./+@=-]/.test(value));

const forbiddenCredential = (content, path) => {
  assignment.lastIndex = 0;
  for (const match of content.matchAll(assignment)) {
    const key = match[1] ?? match[2] ?? match[3] ?? match[4];
    const operator = match[5];
    const value = match[6];
    if (!credentialKey(key)) continue;
    const quote = value[0];
    const unquoted = (quote === '"' || quote === "'" || quote === "`") && value.at(-1) === quote ? value.slice(1, -1) : value;
    if (approvedCredentialValues.get(path)?.has(unquoted)) continue;
    if ((quote === '"' || quote === "'" || quote === "`") && value.at(-1) === quote) {
      if (value.length > 2) return true;
    } else if (operator === "=" && plausibleBareValue(value)) return true;
  }
  return false;
};
const forbiddenContent = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\/(?:home|Users)\/|[A-Z]:\\Users\\|(?:implementation|private)[ -]?(?:plan|prompt)|\b(?:internal[ -]preview|private[ -]internal|internal[ -]prototype|private[ -]prototype)\b|(?:git(?:lab\.com|\x40)|bit(?:bucket\.org)))/i;
const forbiddenOwnerName = new RegExp(`\\b(?:${["Alpha" + "Zede", "WN" + "DW", "Ever" + "est"].join("|")}|${"WIN" + "DOW_"}[A-Z0-9_]*)\\b`, "i");
const forbiddenCandidateName = new RegExp(`\\b${"Win" + "dow"}\\b`);
const localOnlyUrl = (value) => /^http:\/\/(?:127\.0\.0\.1|localhost|local)(?::(?:\d+|\$\{[A-Za-z]+\}))?(?:\/|\$\{|$)/.test(value);

export const inspectPackedFiles = async (root, files) => {
  const failures = [];
  for (const path of files) {
    if (forbiddenPath.test(path)) failures.push(`forbidden packed path: ${path}`);
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${resolve(root)}${sep}`) && absolute !== resolve(root)) failures.push(`unsafe packed path: ${path}`);
    else if (!failures.some((failure) => failure.endsWith(`: ${path}`))) {
      const content = await readFile(absolute, "utf8");
      const scannerDefinition = path === "tools/release/public-check.mjs";
      if (forbiddenContent.test(content) || forbiddenOwnerName.test(content) || forbiddenCandidateName.test(content) || (!scannerDefinition && forbiddenCredential(content, path))) failures.push(`forbidden packed content: ${path}`);
      const allowed = approvedUrls.get(path) ?? new Set();
      if (!scannerDefinition && [...content.matchAll(urlLiteral)].some((match) => !localOnlyUrl(match[0]) && !allowed.has(match[0]))) failures.push(`forbidden packed URL: ${path}`);
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
