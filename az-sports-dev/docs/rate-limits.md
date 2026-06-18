# Rate Limits

AlphaZede Sports applies request budgets by plan and credential. The API returns standard rate-limit headers so integrations can back off without guessing.

| Tier | Budget | Applies to |
|---|---:|---|
| Free | 100 requests/minute | Free-tier callers |
| Pro | 500 requests/minute | Pro subscriptions and pro-tier API keys |
| Enterprise | 2000 requests/minute | Enterprise subscriptions and enterprise-tier API keys |
| SSE connection cap | 3 concurrent sport streams | Per credential on `/api/v1/stream/{sport}` and `/api/v1/stream/forecasts/{sport}` |

## Headers

- `x-ratelimit-limit`: active per-minute request ceiling.
- `x-ratelimit-remaining`: remaining requests in the current window.
- `x-ratelimit-reset`: Unix timestamp for the next window.
- `retry-after`: seconds to wait before retrying when a `429` response is returned.

## Retry Guidance

- Treat `429` as back-pressure and wait for `retry-after` when present.
- Use exponential backoff for repeated `429`, `500`, or `503` responses.
- Keep streaming connections within the published connection cap.
- Do not retry non-idempotent requests automatically unless your application can deduplicate them.

See [Authentication](authentication.md) and the [OpenAPI contract](../api/openapi.json) for operation-level requirements.
