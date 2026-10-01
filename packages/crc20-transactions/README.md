# Cove CRC transaction builders

This package builds Cove CRC deployments, buys, sells, transfers, and market fills. The deployment marker identifies the Cove curve. Mint markers contain exactly `p`, `op`, and `tick`; transfer markers contain exactly `p`, `op`, `tick`, and `amt`.

A market fill pays the seller at output 0, writes the transfer marker at output 1, gives the buyer the token carrier at output 2, and pays the protocol fee at output 3. The seller's token carrier is mandatory input 0. Every input signs the complete transaction with `SIGHASH_ALL`, so a competing spend of that carrier prevents the fill from mining.

The PSBT builder checks exact funding, token input order, asset identity, dust limits, wallet change, and the miner fee. Curve buys and sells keep the vault and fee outputs in fixed positions. Token ownership and curve state are verified by the indexer and Guardian before broadcast.
