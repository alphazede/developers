# API Overview

The AlphaZede Sports public API exposes REST operations for sports slate discovery, game views, line movement, futures markets, forecasts, prop edges, alerts, fantasy tools, projections, and premium analysis workflows.

Public API base URL: `https://api.alphazedesports.com`
OpenAPI version: `3.1.0`
API version: `v1`
Contract version: `2026-04-01`

## Machine-Readable Contract

- [OpenAPI JSON](../api/openapi.json)
- [OpenAPI YAML](../api/openapi.yaml)

## Endpoint Families

| Family | Public operations | Description |
|---|---:|---|
| Health | 1 | Health public API operations. |
| Games | 3 | Games public API operations. |
| Movement | 1 | Movement public API operations. |
| Futures | 3 | Futures public API operations. |
| Alerts | 2 | Alerts public API operations. |
| ML | 1 | ML public API operations. |
| Fantasy | 15 | Fantasy public API operations. |
| Arbitrage | 1 | Arbitrage public API operations. |
| DFS | 1 | DFS public API operations. |
| SGP | 1 | SGP public API operations. |
| Streaming | 1 | Streaming public API operations. |
| Forecasts | 6 | Forecasts public API operations. |

## API Client

Use [@azs/api-client](../packages/api-client/README.md) for TypeScript integrations. The client is generated from the same public operation allowlist as the OpenAPI contract.

```ts
import { createAzsClient } from "@azs/api-client";

const azs = createAzsClient({ apiKey: process.env.AZS_API_KEY });
const health = await azs.getHealth();
console.log(health);
```

## Errors

Public errors use a JSON envelope with a stable error code, human-readable message, and trace identifier when available. See [Rate Limits](rate-limits.md) for `429` behavior.

## Boundaries

- Use only endpoints listed in the OpenAPI files.
- Treat response fields not listed in the public contract as unavailable.
- Use [Security Policy](../SECURITY.md) for vulnerability reporting.
