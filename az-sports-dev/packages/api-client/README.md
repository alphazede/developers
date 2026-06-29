# AlphaZede Sports API Client

Typed TypeScript client for the public AlphaZede Sports API.

```ts
import { createAzsClient } from "@alphadezede/api-client";

const azs = createAzsClient({
  apiKey: process.env.API_KEY,
});

const games = await azs.listGamesBySportAndDate({
  path: { sport: "nba", date: "2026-04-01" },
});
```

The package is generated from the public OpenAPI contract and includes only
customer-facing REST helpers. It does not include private app adapters, browser
session flows, or internal implementation modules.
