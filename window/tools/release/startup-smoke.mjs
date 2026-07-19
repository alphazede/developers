import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  server.on("error", reject);
});
const sentinel = "APP_SENTINEL_NEVER_EMIT";
const receiptDirectory = await mkdtemp(join(tmpdir(), "app-network-"));
const receipt = join(receiptDirectory, "receipt");
const environment = { ...process.env, APP_RUNTIME_MODE: "synthetic", APP_SMOKE_PORT: String(port), APP_NETWORK_RECEIPT: receipt, HTTP_PROXY: sentinel, HTTPS_PROXY: sentinel, ALL_PROXY: sentinel, GOOGLE_CLIENT_SECRET: sentinel, GITHUB_TOKEN: sentinel, LINEAR_API_KEY: sentinel };
const child = spawn(process.execPath, ["--require", "./tools/release/no-network-guard.cjs", "./node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (value) => { output += value; });
child.stderr.on("data", (value) => { output += value; });
const stop = async () => {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
};
try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output || "startup process exited");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const body = await response.text();
      if (response.ok && body.includes("deterministic synthetic data")) {
        if (output.includes(sentinel)) throw new Error("startup emitted a sentinel");
        console.log(`startup no-network receipt: loopback http://127.0.0.1:${port}/`);
        break;
      }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (attempt === 49) throw new Error("startup smoke did not receive the neutral marker");
  }
} finally {
  await stop();
  try {
    if ((await readFile(receipt, "utf8")).trim()) throw new Error("startup attempted outbound network access");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally {
    await rm(receiptDirectory, { recursive: true, force: true });
  }
}
