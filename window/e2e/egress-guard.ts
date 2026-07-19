import { appendFile } from "node:fs/promises";
import { expect, test as base } from "@playwright/test";

export type BrowserEgressGuard = Readonly<{
  deniedAttempts: readonly string[];
  expectDenials: (...attempts: string[]) => void;
}>;

const appOrigin = (baseURL: string | undefined) => {
  const url = new URL(baseURL ?? "http://127.0.0.1:3100");
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname)) {
    throw new Error(`Playwright base URL must be loopback, received ${url.origin}`);
  }
  return url.origin;
};

const publicPath = (url: URL) => `${url.origin}${url.pathname}`;
const websocketHttpOrigin = (url: URL) => `${url.protocol === "ws:" ? "http:" : "https:"}//${url.host}`;

export const test = base.extend<{ egressGuard: BrowserEgressGuard }>({
  egressGuard: [async ({ context, baseURL }, use) => {
    const allowedOrigin = appOrigin(baseURL);
    const denied: string[] = [];
    let expected: string[] = [];

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol) || url.origin === allowedOrigin) return route.continue();
      denied.push(`HTTP ${request.method()} ${publicPath(url)}`);
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (socket) => {
      const url = new URL(socket.url());
      if (["ws:", "wss:"].includes(url.protocol) && websocketHttpOrigin(url) === allowedOrigin) {
        socket.connectToServer();
        return;
      }
      denied.push(`WEBSOCKET ${publicPath(url)}`);
      await socket.close({ code: 1008, reason: "Browser egress denied" });
    });

    const guard: BrowserEgressGuard = {
      get deniedAttempts() { return [...denied].sort(); },
      expectDenials: (...attempts) => { expected = [...attempts].sort(); },
    };
    await use(guard);

    const actual = [...denied].sort();
    const receipt = process.env.JUDGE_BROWSER_NETWORK_RECEIPT;
    if (receipt && actual.length > 0) await appendFile(receipt, `${actual.join("\n")}\n`, "utf8");
    expect(actual, "unexpected browser network attempts").toEqual(expected);
  }, { auto: true }],
});

export { expect } from "@playwright/test";
