---
id: the-vault
title: The vault
sidebar_position: 5
---

Every token has exactly one live vault output, holding a 10,000-sat anchor plus all the BTC its curve has taken in. The vault's address commits to the token's state, so each mint or sell-back moves the BTC to a new address that reflects the new supply. You can follow a token's backing on any block explorer, one transaction at a time.

The vault has three spending paths. **Mint** adds BTC and issues tokens; **redeem** burns tokens and pays out BTC; both need the Guardian's signature over a transaction that obeys the curve. **Recovery** is a 2-of-3 (or 1-of-1) multisig of offline keys behind a relative timelock, fixed in the committed mainnet profile.

The vault never pays anyone except through those rules. Its balance is always exactly what the curve says the issued supply is worth, which is why a sell-back is always possible, for every holder, at the price the curve shows.
