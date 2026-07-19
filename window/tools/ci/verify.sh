#!/usr/bin/env sh
set -eu

pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm audit --audit-level moderate
pnpm run public:check
echo "verify: judge performs the production build and runs every Playwright judge/e2e spec with denied egress"
pnpm run judge
pnpm run smoke
