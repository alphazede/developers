#!/usr/bin/env sh
set -eu

pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm audit --prod --audit-level high
pnpm run public:check
pnpm run smoke
