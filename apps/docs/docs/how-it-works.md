---
id: how-it-works
title: How it works
sidebar_position: 2
---

**Launch.** A creator pays a 7,000-sat launch fee and seeds the token's vault with 10,000 sats. The launch transaction records the creator's payout address; the token ID commits to it, so nobody can copy a launch and redirect the creator's earnings.

**Mint and sell back.** Buyers mint in lots of 1,000 tokens. The price climbs 210 even stairs from 27 sats per lot to 5,670 sats per lot, and the full curve puts 0.598 BTC in the vault. A mint pays the curve price into the vault, 50% on top to the creator, and a fee of 5,000 sats + 10 sats per lot + 7.5%. Selling back returns the curve price from the vault, minus 7.5%.

**Trade.** After mint-out, holders list tokens at their own price. The seller presigns a listing that pays them exactly that price; a buyer signs, and the trade settles atomically in one transaction with a 7.5% market fee paid by the buyer. Tokens live on 1,000-sat carrier outputs in your wallet (Xverse, Unisat and others), and covs never holds them.
