# crc.garden client JavaScript inspection — 2026-09-30

## Capture

Playwright loaded `/`, `/activity`, `/market`, and `/wallet` on `https://crc.garden/`. It saved 20 unique JavaScript responses (5,395,692 bytes) under the local ignored directory `artifacts/crc-garden/site-js-2026-09-30/`. The tracked [manifest](site-js-manifest-2026-09-30.json) records each URL, SHA-256 digest, byte count, and page. Reproduce with `node scripts/research/capture-crc-site-js.mjs`; set `CRC_SITE_CHROMIUM` to a local Chromium executable if Playwright's bundled browser is unavailable. A checked source map for the site text bundle returned HTTP 404.

The large 3.96 MB bundle includes wallet and Bitcoin libraries; occurrences of generic terms such as `mintAmount`, `SIGHASH_SINGLE`, and `assetId` inside those libraries do not establish CRC-20 rules. The findings below refer to the smaller application bundles and archived Bitcoin transactions.

## Mint issuance

The client API module in [0frj_hjrp__cf.js](https://crc.garden/_next/static/chunks/0frj_hjrp__cf.js) calls `POST /api/mint/quote-budget` and `GET /api/mint/state`, `/config`, and `/wallet-assets`. The activity page in [1if8dzyixnvg7.js](https://crc.garden/_next/static/chunks/1if8dzyixnvg7.js) fetches event rows from `/api/crc20/events`; the wallet in [16qkmsxqu3-z3.js](https://crc.garden/_next/static/chunks/16qkmsxqu3-z3.js) fetches balances from `/api/balance`. The wallet error handling expects the mint service to provide a canonical CRC-20 mint payload. The captured application bundles contain a literal constructor for `op: "transfer"` and none for `op: "mint"`.

The [site text bundle](https://crc.garden/_next/static/chunks/06nxro7m_a2th.js) describes a Golden Curve marginal price and point equivalence in prose. It does not contain the coefficients, rounding, payment-specific conversion, ordering, or allocation algorithm needed to replay exact mint amounts. The live mint state API reports the full 1,000,000,000 LEAF supply already issued, so the current UI cannot provide a live nonzero quote. These observations point to server-side mint allocation logic; client bundles alone do not prove its exact rule. The archived raw mint markers still omit `amt`, including [17c4c6fa...](https://mempool.space/tx/17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4).

## Transfers and market

The [wallet bundle](https://crc.garden/_next/static/chunks/16qkmsxqu3-z3.js) constructs CRC-20 transfer JSON with `p`, `op`, `tick`, and `amt`; it also reads history and balances from the server. The [market bundle](https://crc.garden/_next/static/chunks/27cyrhn5oq69t.js) calls listing prepare/setup/activate and order prepare/finalize/broadcast APIs. The seller signs two listing inputs with `SIGHASH_SINGLE | ANYONECANPAY`; the buyer signs their funding inputs with `SIGHASH_ALL`. A [confirmed fill](https://mempool.space/tx/8012a907a93e1faedd9e7c89bd25306db7449a2370d1b1957dc0d79011415c2a) has exactly that signature split and a CRC-20 transfer marker with explicit amount, followed by the buyer recipient output. This validates the observed sale layout, not the earlier mint amounts or a general seller debit rule.

The live [market config](https://crc.garden/api/marketplace/config) currently allows only `LEAF`. The captured client code and this endpoint do not define how two deployments with the same ticker would be identified. The app's proposed asset key `network:deployTxid` is therefore our design choice until a general CRC-20 specification establishes a different rule.

## Boundary

These are public browser bundles. Next.js server routes, database code, and indexer rules are not shipped in them. The exact LEAF mint allocation rule, general deployment identity/ticker collision rule, and full transfer debit validity rule remain unproven. Historical LEAF mint amounts in the checkpoint are still externally sourced, and external-token trading remains gated on a trusted allocation decision or an independently reproducible rule.
