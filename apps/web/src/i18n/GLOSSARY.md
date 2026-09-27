# covs.trade — Chinese (zh-CN) glossary

Mainland Simplified Chinese, in the voice of Chinese crypto Twitter and the
BTC inscription / rune / CRC-20 communities. Short, native, confident — never
stiff machine translation. Every new string must use these terms.

Keep in English/Latin: covs, covs.trade, BTC, CRC-20, Taproot, Simplicity,
PSBT, ord, tickers, addresses, txids, numbers, wallet names (Xverse, Unisat …).
"sats" as a unit label may stay `sats`; in prose prefer 聪 (e.g. 5,000 聪).

| English | 中文 |
| --- | --- |
| Launch (a token) | 发射（代币）/ 发币；按钮「发射代币」 |
| Mint | 铸造（口语宣传语可用「打」） |
| Redeem / sell back to the vault | 卖回金库 |
| Vault | 金库 |
| Covenant | 契约 |
| Covenant vault | 契约金库 |
| Covenant-powered CRC launchpad | 契约驱动的 CRC 发射台 |
| Bonding curve | 联合曲线 |
| Fair launch | 公平发射 |
| Mint-out | 铸造完成 / 打满 |
| List (for sale) / Listing | 挂单 |
| Floor | 地板价 |
| Buy / Sell | 买入 / 卖出 |
| Market | 市场 |
| Wallet | 钱包 |
| Connect wallet | 连接钱包 |
| Creator / creator earnings | 创建者 / 创建者收益 |
| Holders | 持有人 |
| Supply | 供应量 |
| Market fee | 市场手续费 |
| Network fee | 矿工费 |
| Guardian | 守护者（Guardian） |
| Indexer | 索引器 |
| Transfer | 转账 |
| Activity | 动态 |
| Explore | 发现 |
| Docs | 文档 |
| Stair (curve stage) | 台阶 |
| Backing | 储备 |
| Ask (sell order) | 卖单 |

## How strings work

- `src/i18n/en.ts` is the source; `src/i18n/zh-CN.ts` must have exactly the
  same keys (the TypeScript type and `i18n.test.ts` both enforce it).
- Use `const t = useT()` in components and `t("key", { n })` for `{n}`
  placeholders. Outside React (helpers such as `errorText`), use `tr()`.
- Server error codes are translated through the `err.<CODE>` keys; an unknown
  code falls back to the server's English text.
