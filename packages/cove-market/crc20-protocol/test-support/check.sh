#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker image inspect bitcoin/bitcoin:30.0 >/dev/null
../node_modules/.bin/vitest run --config vitest.config.ts | tee verification.log
../node_modules/.bin/tsc --noEmit --incremental false --strict --skipLibCheck \
  --target ES2022 --module ESNext --moduleResolution bundler \
  --allowImportingTsExtensions --types node *.ts test-support/*.ts >typecheck.log 2>&1
../../../node_modules/.bin/eslint *.ts test-support/*.ts --no-warn-ignored >lint.log 2>&1
../../../node_modules/.bin/prettier --check *.ts test-support/*.ts README.md VERIFICATION.md >format.log 2>&1
