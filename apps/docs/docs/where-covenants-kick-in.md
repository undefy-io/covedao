---
id: where-covenants-kick-in
title: Where the covenants kick in
sidebar_position: 3
---

The covenant guards **the BTC**. Every satoshi that buyers pay for a token goes into that token's vault, and every mint and every sell-back spends the vault and creates its successor in the same transaction. Those are the only moments the vault moves, and each one must follow the token's rules exactly: the right price for the right amount, the right fee, and the creator paid.

Launch fees, creator payouts and P2P trades do not touch the vault. P2P trades move tokens between holders, and the market checks them, but the vault's BTC stays where it is.

There is one more path: **recovery**. If covs ever stopped operating, a timelocked recovery path lets a fixed set of recovery keys move the vault. It opens only after a long delay, so it cannot be used to jump ahead of normal mints and sell-backs.
