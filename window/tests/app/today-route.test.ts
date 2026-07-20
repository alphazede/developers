import { describe, expect, it } from "vitest";

import * as route from "../../src/app/api/v1/today/route";

describe("GET /api/v1/today", () => {
  it("returns deterministic versioned private JSON and exposes no mutation method", async () => {
    const first = await route.GET();
    const second = await route.GET();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("content-type")).toBe("application/vnd.capacity-scheduling.today.v1+json");
    expect(await first.text()).toBe(await second.text());
    expect("POST" in route).toBe(false);
  });
});
