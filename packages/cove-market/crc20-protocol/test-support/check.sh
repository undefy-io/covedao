#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
docker image inspect bitcoin/bitcoin:30.0 >/dev/null
node_modules/.bin/vitest run --config vitest.config.ts | tee verification.log
pnpm --silent typecheck >typecheck.log 2>&1
pnpm --silent lint >lint.log 2>&1
../../../node_modules/.bin/prettier --check *.ts *.mjs package.json tsconfig.build.json test-support/*.ts README.md VERIFICATION.md >format.log 2>&1
