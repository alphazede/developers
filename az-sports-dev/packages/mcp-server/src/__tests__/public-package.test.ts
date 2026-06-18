import { describe, expect, it } from "vitest";
import { tools } from "../tools/index.js";
import { sportsAsNonEmptyTuple } from "../public-types.js";

describe("@azs/mcp-server public package", () => {
  it("publishes a non-empty MCP tool registry", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name)).toContain("find_game_markets");
  });

  it("publishes the public sport registry used by tool schemas", () => {
    expect(sportsAsNonEmptyTuple()).toContain("nba");
  });
});
