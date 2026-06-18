import { createAzsClient } from "@azs/api-client";

const apiKey = process.env.AZS_API_KEY;

if (!apiKey) {
  throw new Error("Set AZS_API_KEY before running the API client example.");
}

const azs = createAzsClient({ apiKey });

const health = await azs.getHealth();
console.log("Health:", health);

const games = await azs.listGamesBySportAndDate({
  path: {
    sport: "NBA",
    date: "2026-04-01",
  },
});
console.log("Games:", games);
