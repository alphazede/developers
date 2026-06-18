import assert from "node:assert/strict";
import test from "node:test";

import { AzsApiError, createAzsClient } from "../index.js";

test("builds authenticated requests with path and query parameters", async () => {
  const requests: Request[] = [];
  const client = createAzsClient({
    apiKey: "azs_test_key",
    baseUrl: "https://api.example.test/base",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true });
    },
  });

  const response = await client.listGamesBySportAndDate({
    path: { sport: "nba", date: "2026-04-01" },
    query: { include_props: true },
  });

  assert.deepEqual(response, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.example.test/api/v1/games/nba/2026-04-01?include_props=true",
  );
  assert.equal(requests[0].headers.get("authorization"), "Bearer azs_test_key");
  assert.equal(requests[0].headers.get("accept"), "application/json");
});

test("serializes JSON request bodies", async () => {
  let request: Request | undefined;
  const client = createAzsClient({
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ recommendation: "review" });
    },
  });

  await client.evaluateSgp({
    body: {
      game_id: "NBA_2026-04-01_BOS_NYK",
      legs: [],
      sportsbook_parlay_odds: 4.75,
      sport: "NBA",
    },
  });

  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(await request.json(), {
    game_id: "NBA_2026-04-01_BOS_NYK",
    legs: [],
    sportsbook_parlay_odds: 4.75,
    sport: "NBA",
  });
});

test("throws structured errors for non-2xx responses", async () => {
  const client = createAzsClient({
    fetch: async () => Response.json({ code: "BAD_REQUEST" }, { status: 400 }),
  });

  await assert.rejects(
    client.getHealth(),
    (error) =>
      error instanceof AzsApiError &&
      error.operationId === "getHealth" &&
      error.status === 400,
  );
});
