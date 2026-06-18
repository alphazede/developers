import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { platform } from "node:os";
import {
  bearerAuthorizationHeader,
  isValidStoredMcpToken,
} from "../auth-token.js";
import { writeCliStderr, writeCliStdout } from "../output-sink-registry.js";
import { getTokenFile, writeToken } from "../token-store.js";
import { buildApiUrl, normalizeApiBaseUrl } from "../url-utils.js";
import { resolveMcpClientId } from "./client-id.js";

const SCOPES = "read read:arb read:sgp read:ml read:dfs";
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

interface McpToolsResponse {
  tier?: string;
  tier_display?: string;
  tools?: string[];
}

export async function runLogin(args: string[] = []): Promise<number> {
  let listener: Server | undefined;
  let exitCode = 0;
  let errorMessage: string | null = null;

  try {
    const apiUrl = resolveApiUrl(args);
    const clientId = resolveMcpClientId(args, { useDefault: true });
    const printAuthUrl = args.includes("--print-auth-url");
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(16));

    const callback = await createCallbackListener(state);
    listener = callback.listener;
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
    const authorizeUrl = buildAuthorizeUrl(
      apiUrl,
      redirectUri,
      state,
      challenge,
      clientId,
    );

    if (printAuthUrl) {
      writeCliStdout(
        `[WARN] state token visible - keep this URL private: ${authorizeUrl}\n`,
      );
    } else {
      writeCliStdout("Opening browser...\n");
      await openBrowser(authorizeUrl);
    }
    writeCliStdout("Waiting for authorization callback...\n");

    const code = await withTimeout(callback.code, callbackTimeoutMs());
    const token = await exchangeCode(
      apiUrl,
      code,
      redirectUri,
      verifier,
      clientId,
    );
    if (!isValidStoredMcpToken(token.access_token)) {
      throw new Error("Token exchange returned an invalid access token.");
    }
    writeToken(token.access_token, clientId);

    const tierDisplay = await fetchTierDisplay(apiUrl, token.access_token);
    if (tierDisplay) {
      writeCliStdout(
        `Logged in (${tierDisplay} tier). Token stored at ${getTokenFile()}.\n`,
      );
    } else {
      writeCliStdout(`Logged in. Token stored at ${getTokenFile()}.\n`);
    }
  } catch (error) {
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  await closeListener(listener);
  if (errorMessage) {
    writeCliStderr(`${errorMessage}\n`);
  }
  return exitCode;
}

function resolveApiUrl(args: string[]): string {
  const flag = args.find((arg) => arg.startsWith("--api-url="));
  const value = flag?.slice("--api-url=".length) || process.env.AZS_API_URL;
  return normalizeApiBaseUrl(value || "https://api.alphazedesports.com");
}

function buildAuthorizeUrl(
  apiUrl: string,
  redirectUri: string,
  state: string,
  challenge: string,
  clientId: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${apiUrl}/api/v1/oauth/authorize?${params.toString()}`;
}

function createCallbackListener(state: string): Promise<{
  listener: Server;
  port: number;
  code: Promise<string>;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  // Consumed flag: explicit state-replay guard. Prevents a second callback with the
  // same state from being accepted during the token-exchange window. JavaScript
  // Promise resolve is idempotent, so additional resolveCode calls are no-ops, but
  // the flag makes the intent unambiguous and returns 400 immediately on replay.
  let consumed = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const listener = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/callback") {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end("Not found");
      return;
    }

    // State-replay guard: reject any callback after the first successful code delivery.
    if (consumed) {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end("Authorization code already consumed");
      return;
    }

    const returnedState = requestUrl.searchParams.get("state") ?? "";
    if (!constantTimeEqual(returnedState, state)) {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end("Invalid state");
      rejectCode(new Error("Authorization callback state mismatch."));
      return;
    }

    const authError = requestUrl.searchParams.get("error");
    if (authError) {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end("Authorization failed");
      rejectCode(new Error(`Authorization failed: ${authError}`));
      return;
    }

    const returnedCode = requestUrl.searchParams.get("code");
    if (!returnedCode) {
      response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        Connection: "close",
      });
      response.end("Missing code");
      rejectCode(new Error("Authorization callback missing code."));
      return;
    }

    // Mark consumed before responding so concurrent requests see it immediately
    consumed = true;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      Connection: "close",
    });
    response.end(`<!DOCTYPE html>
<html><body>
  <h1>Authentication successful</h1>
  <p>You can close this tab and return to your terminal.</p>
</body></html>`);
    resolveCode(returnedCode);
  });

  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not bind loopback callback listener."));
        return;
      }
      resolve({ listener, port: address.port, code });
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  const command = browserCommand(url);
  if (!command) {
    throw new Error(
      "Browser open failed. Run 'azs-mcp-server login --print-auth-url' to see the URL.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    const finish = (opened: boolean) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (!opened) {
        reject(
          new Error(
            "Browser open failed. Run 'azs-mcp-server login --print-auth-url' to see the URL.",
          ),
        );
        return;
      }
      resolve();
    };

    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.unref();
  });
}

function browserCommand(
  url: string,
): { command: string; args: string[] } | null {
  switch (platform()) {
    case "darwin":
      return { command: "open", args: [url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    case "win32":
      return {
        command: "rundll32",
        args: ["url.dll,FileProtocolHandler", url],
      };
    default:
      return null;
  }
}

async function exchangeCode(
  apiUrl: string,
  code: string,
  redirectUri: string,
  verifier: string,
  clientId: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const response = await fetch(buildApiUrl(apiUrl, "/api/v1/oauth/token"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with HTTP ${response.status}.`);
  }

  const token = (await response.json()) as TokenResponse;
  if (!token.access_token || token.token_type?.toLowerCase() !== "bearer") {
    throw new Error("Token exchange returned an invalid response.");
  }
  return token;
}

async function fetchTierDisplay(
  apiUrl: string,
  accessToken: string,
): Promise<string | null> {
  try {
    if (!isValidStoredMcpToken(accessToken)) {
      return null;
    }
    const response = await fetch(buildApiUrl(apiUrl, "/api/v1/me/mcp-tools"), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: bearerAuthorizationHeader(accessToken),
      },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as McpToolsResponse;
    return body.tier_display || null;
  } catch {
    return null;
  }
}

async function closeListener(listener: Server | undefined): Promise<void> {
  if (!listener?.listening) {
    return;
  }
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function callbackTimeoutMs(): number {
  const configured = Number(process.env.AZS_MCP_LOGIN_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_CALLBACK_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          "No authorization callback received. Run `azs-mcp-server login` again to retry.",
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
