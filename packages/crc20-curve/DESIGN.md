# Cove curve extension over CRC-20

This package specifies only Cove launches. An ordinary CRC-20 deployment has no
curve state and must continue through the base ledger without these rules.

## Status and open base questions

This is a pure state transition reference, not a transaction builder or a
Guardian implementation. The observed LEAF corpus establishes the JSON
`p/op/tick` marker and the following recipient output for transfers. It does
not establish general `max`, `lim`, `type`, mint quantity, sender provenance,
or burn rules. Those need separate replay and an explicit Cove launch policy.

Proposed Cove deployment marker:

```json
{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","cv":"cove-curve-v1"}
```

`cv` opts into this extension. `max` is shown as an atom-denominated candidate;
its base protocol interpretation must be verified before launch. A token
without `cv:"cove-curve-v1"` never enters this package. The exact JSON above
is 105 bytes, exceeding the existing V3 builder's 80-byte limit. LEAF's
confirmed 137-byte deploy proves the archive contains a larger real
transaction, but relay and local regtest policy still need a direct test for
our proposed marker. No V3 payload or separate OP_RETURN is assumed.

The deployment transaction defines the immutable curve version and identifies
the vault BTC output, creator payment script, and protocol payment script by
fixed output positions. The builder and independent indexer must agree on and
validate those positions. The vault starts with a spendable anchor amount;
this amount is *not* backing. Subsequent transactions spend exactly the
current vault outpoint and create exactly one replacement vault output. This
Bitcoin input conflict serializes competing curve trades; an indexer applies
only transactions in actual chain order. A signer must commit to the exact
outputs, including vault replacement, buyer/seller payment, and fees.

## Supply and reserve

The standard CRC operations remain deploy, mint, and transfer. A sell is a
`transfer` to the vault's token address. Tokens held there are inventory, not
burned. A buy transfers vault inventory to the buyer before any new mint.
One buy cannot cross the inventory-to-mint boundary; split it into two
transactions. This avoids two CRC markers in one Bitcoin transaction.

Let `M` be lifetime minted atoms, `V` be vault inventory atoms, and `C=M-V`
be circulating atoms. `M` is monotonic and never exceeds the 21,000,000-token
cap. Let `A` be the vault BTC anchor and `R(C)` be the existing integer
stairs210 reserve. The vault output must contain exactly `A+R(C)`. All token
amounts must be positive multiples of 1,000 display tokens (8 decimals).

For a buy of `q`, gross backing added is `R(C+q)-R(C)`; the protocol mint fee
and creator fee are extra outputs paid by the buyer. If `V>=q`, use a standard
CRC `transfer` from vault to buyer and leave `M` unchanged. If `V=0`, use a
CRC `mint` and increase `M` by `q`. A Cove mint marker must carry an `amt`
field so its quantity is visible on chain; the base indexer resolves token
identity from the deployment/vault chain rather than ticker alone. Every
transfer marker carries standard `amt`, with the next spendable output as
recipient. The launch builder must preserve this recipient topology.

For a sell of `q`, transfer tokens from seller to vault, decrease `C` by `q`,
increase `V` by `q`, and release `R(C)-R(C-q)` sats from backing. The protocol
redeem fee is paid separately. Small sells may need the seller's ordinary BTC
input to fund fee and a dust-safe payout; the economic BTC change remains
`gross-fee`. The miner fee and BTC carrier changes are separate from reserve
and fee accounting.

## Minimum transaction evidence for independent replay

- Deployment marker opts into the fixed `cove-curve-v1` policy. Its transaction
  identifies vault, creator, and protocol scripts and the initial vault
  outpoint/anchor. The token identity is network plus deployment txid.
- A curve trade spends the current vault outpoint and creates one replacement
  output to the same vault script. This selects a single predecessor state.
- A mint marker exposes exact `amt`, and the buyer's token recipient output is
  identifiable by the Cove launch layout. A vault-inventory buy uses the
  ordinary CRC transfer marker followed immediately by the buyer recipient.
- A sell uses the ordinary CRC transfer marker followed immediately by the
  vault recipient. The indexer must verify sender provenance and balance using
  the base CRC ledger; Bitcoin Core alone cannot prove token ownership.
- The indexer verifies exact vault BTC delta and fee outputs against the
  versioned integer policy. It rejects unknown versions, missing/duplicate
  markers, ambiguous outputs, stale vault outpoints, and forged fee receipts.
- Reorganizations roll back both base CRC balances and curve state together.

Guardian and builder work must settle the vault spending authorization and
prove that no signature can release more backing, redirect token inventory,
or redirect seller payout. These signatures are not modeled by this package.
