# CRC-first transaction prototype

This package builds unsigned output layouts and exact-funded PSBTs for a proposed Cove curve extension. It is not connected to the production routes, indexer, or Guardian.

Deploy emits one CRC-20 JSON marker at vout 0, then the vault, creator, and protocol outputs. A new-mint buy emits a mint marker at vout 0 and its buyer recipient at vout 1. An inventory buy emits a transfer marker at vout 0 and its buyer recipient at vout 1. A sell emits a transfer marker at vout 0 and its vault recipient at vout 1, followed by seller payout and protocol fee. In the archived Garden transfer corpus, the recipient immediately followed the marker in every observed transfer; this package follows that topology.

The marker fields for Cove deploy and mint are candidates, not verified LEAF mint rules. In particular, the meaning of `max`, `type`, and mint `amt` to a general CRC-20 indexer remains open. The proposal uses one marker per transaction and does not claim that Garden would recognize these Cove launches.

The PSBT builder requires the current vault outpoint as input zero, exact input/output/miner-fee balance, and `SIGHASH_ALL` on every input. The seller signs the completed transaction while online. Tests prove that changing the marker, vault replacement, seller payout, protocol fee, recipient script, or input set invalidates the seller's signature. The prototype does not authorize a vault spend or prove token ownership; those are production Guardian and ledger responsibilities.

## Local Bitcoin Core policy check

On 2026-09-30, an isolated `bitcoin/bitcoin:30.0` Docker container ran Bitcoin Core `/Satoshi:30.0.0/` on regtest with default data-carrier policy, `-fallbackfee=0.00001`, and no published ports. A 105-byte deploy JSON marker was inserted with `createrawtransaction`, funded with a local wallet, signed, and submitted to `testmempoolaccept`. Core returned `allowed: true`, `vsize: 239`, fee `239 sats`, and minimum relay fee `1 sat/vB`. The container was stopped and removed. This proves acceptance under that local node policy only; public relay and mined acceptance require a separate mainnet canary.
