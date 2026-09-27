---
id: how-covenants-work
title: How the covenants work
sidebar_position: 4
---

Each vault is a Taproot output whose internal key is a NUMS point: a key with no known private key, so the key-path spend is impossible. The only way to spend it is one of its script leaves. The **mint** and **redeem** leaves each require a hash that commits to the token, its current state and the Simplicity program's identity (CMR), plus a signature from the covs Guardian.

Before it signs, the Guardian rebuilds the token's state from the chain and checks the actual transaction: the curve math, the vault's new value, the creator payout, and that every funding input is confirmed and carries no inscriptions, runes or tokens. The same rules are written as a Simplicity program, and the Guardian runs it and checks its CMR. Any mismatch means no signature.

Bitcoin mainnet cannot yet enforce rules like these on its own; proposals such as OP_CAT and OP_CTV are not active, and every Bitcoin token protocol today relies on an off-chain checker. What Bitcoin *does* enforce here is that the vault has no key, can only move through these leaves, and that recovery waits for its timelock. The Guardian is the one party to trust, and the timelocked recovery path is the escape if it ever goes away.
