# Cove CRC-20 curve

The Cove-only transaction format, asset registration rule, output layout, and replay requirements are specified in [COVE_CRC20_V1.md](../../docs/COVE_CRC20_V1.md).

This package implements the pure `cove-curve-v1` reserve and supply transitions. It does not prove Bitcoin transaction confirmation, sender authorization, fee destinations, or registration. The transaction validator and indexer must apply those checks before using these transitions. External CRC tokens are outside Cove indexing scope.
