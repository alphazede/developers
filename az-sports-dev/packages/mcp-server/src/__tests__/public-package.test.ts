import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../middleware.js";
import { tools } from "../tools/index.js";
import { sportsAsNonEmptyTuple } from "../public-types.js";

const { readTokenMock } = vi.hoisted(() => ({
  readTokenMock: vi.fn<() => string | null>(),
}));

vi.mock("../token-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../token-store.js")>();
  return {
    ...actual,
    readToken: readTokenMock,
  };
});

describe("@alphadezede/mcp-server public package", () => {
  beforeEach(() => {
    readTokenMock.mockReset();
    readTokenMock.mockReturnValue(null);
  });

  it("publishes a non-empty MCP tool registry", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name)).toContain("find_game_markets");
  });

  it("publishes the public sport registry used by tool schemas", () => {
    expect(sportsAsNonEmptyTuple()).toContain("nba");
  });

  it("accepts a generic host-injected API key environment variable", () => {
    readTokenMock.mockReturnValue("azs_at_stored");
    withEnv({ API_KEY: "azs_primary", AZS_API_KEY: "azs_legacy" }, () => {
      expect(resolveIdentity()).toEqual({
        kind: "api_key",
        token: "azs_primary",
      });
    });
  });

  it("falls back to stored OAuth when a generic ambient API_KEY is unrelated", () => {
    readTokenMock.mockReturnValue("azs_at_stored");
    withEnv({ API_KEY: "not-an-azs-token" }, () => {
      expect(resolveIdentity()).toEqual({
        kind: "oauth",
        token: "azs_at_stored",
      });
    });
  });

  it("keeps generic system tokens explicit to dev mode", () => {
    withEnv({ API_KEY: "system-token", AZS_MCP_DEV_MODE: "1" }, () => {
      expect(resolveIdentity()).toEqual({
        kind: "system",
        token: "system-token",
      });
    });
  });

  it("keeps the legacy API key environment variable as a compatibility fallback", () => {
    withEnv({ AZS_API_KEY: "azs_legacy" }, () => {
      expect(resolveIdentity()).toEqual({
        kind: "api_key",
        token: "azs_legacy",
      });
    });
  });
});

function withEnv(env: Record<string, string>, testBody: () => void): void {
  const keys = ["API_KEY", "AZS_API_KEY", "AZS_MCP_DEV_MODE"] as const;
  const previous = new Map<string, string | undefined>();

  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  Object.assign(process.env, env);

  try {
    testBody();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
