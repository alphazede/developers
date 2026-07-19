import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guard = join(root, "tools/release/no-network-guard.cjs");
const next = join(root, "node_modules/next/dist/bin/next");
const playwright = join(root, "node_modules/@playwright/test/cli.js");
const config = join(root, "tools/release/judge-playwright.config.mjs");
const chromium = process.env.JUDGE_CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome";
const inheritedNames = ["CI", "FORCE_COLOR", "HOME", "LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USER"];

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePort(address.port));
  });
  server.on("error", reject);
});

const run = (command, args, environment) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${args.at(-1)} exited ${code ?? signal}`)));
});

const stop = (child) => new Promise((resolveStop) => {
  if (child.exitCode !== null) return resolveStop();
  const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000);
  child.once("exit", () => { clearTimeout(force); resolveStop(); });
  child.kill("SIGTERM");
});

await access(chromium, constants.X_OK);
const receiptDirectory = await mkdtemp(join(tmpdir(), "capacity-judge-"));
const serverReceipt = join(receiptDirectory, "server-denied-egress");
const browserReceipt = join(receiptDirectory, "browser-denied-egress");
const environment = Object.fromEntries(inheritedNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
Object.assign(environment, {
  APP_RUNTIME_MODE: "synthetic",
  APP_SMOKE_PORT: String(port),
  APP_NETWORK_RECEIPT: serverReceipt,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: `--require=${guard}`,
});
const buildEnvironment = { ...environment, APP_ALLOW_TURBOPACK_IPC: "1" };

let server;
const started = performance.now();
try {
  await run(process.execPath, [next, "build"], buildEnvironment);
  server = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env: environment, stdio: "inherit" });
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (server.exitCode !== null) throw new Error("judge server exited before readiness");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok && (await response.text()).includes("Personal rhythm")) break;
    } catch { /* production server is still starting */ }
    if (attempt === 1_199) throw new Error("judge server did not become ready");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  const browserEnvironment = {
    ...environment,
    JUDGE_BASE_URL: `http://127.0.0.1:${port}`,
    JUDGE_BROWSER_NETWORK_RECEIPT: browserReceipt,
    JUDGE_CHROMIUM_EXECUTABLE: chromium,
  };
  delete browserEnvironment.NODE_OPTIONS;
  delete browserEnvironment.APP_NETWORK_RECEIPT;
  await run(process.execPath, [playwright, "test", "--config", config], browserEnvironment);

  const status = await readFile(`/proc/${server.pid}/status`, "utf8");
  const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(rssKiB) || rssKiB >= 512 * 1_024) throw new Error(`judge server RSS exceeded limit: ${rssKiB} KiB`);
  const readDenied = async (path) => {
    try { return (await readFile(path, "utf8")).trim().split(/\r?\n/).filter(Boolean); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const serverDenied = await readDenied(serverReceipt);
  const browserDenied = await readDenied(browserReceipt);
  if (serverDenied.length > 0) throw new Error(`judge server denied egress: ${serverDenied.join(", ")}`);
  if (browserDenied.length === 0) throw new Error("judge browser egress guard produced no denial proof");
  console.log(`judge receipt: loopback=127.0.0.1:${port} server-denied-egress=${serverDenied.length} browser-denied-egress=${browserDenied.length} server-rss-mib=${(rssKiB / 1_024).toFixed(1)} elapsed-ms=${Math.round(performance.now() - started)}`);
} finally {
  if (server) await stop(server);
  await rm(receiptDirectory, { recursive: true, force: true });
}
