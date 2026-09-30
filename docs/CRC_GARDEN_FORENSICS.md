# CRC.garden / PRECOP — Forensic Reference Freeze

> This is a historical three-transaction research freeze. A public activity API
> was subsequently found and all 1,950 events in the 2026-09-30 snapshot were
> matched to full mainnet transactions. See the [current corpus comparison](../artifacts/crc-garden/COMPATIBILITY.md)
> for observed mint and transfer layouts. The limited-corpus statements below
> should not be read as current completeness claims.

> This document records what is **actually verifiable** from primary evidence
> (on-chain data, source repositories, whitepaper/yellowpaper), not what is
> claimed in prose. Every conclusion is tagged with exactly one evidence class:
> **ON_CHAIN_VERIFIED**, **SOURCE_VERIFIED**, **DOCUMENTATION_CLAIM_ONLY**, or
> **INFERENCE**.

---

## 1. Pinned source revisions

| Source | Revision (exact) | Evidence class |
| --- | --- | --- |
| `BitcoinWorldTrustFoundation/precop` (main) | `c26ceca30f01b713bc0a4e97b6d499ffe191f523` | SOURCE_VERIFIED |
| `Laz1mov/L1-AGENT-WALLET` (main) | `db8af45c25250d4314f7bf7ee53f1448bb7ed91f` | SOURCE_VERIFIED |
| `BlockstreamResearch/simplicity-unchained` (main) | `b87ee158e37fdf43752670ab8ebdf9ba7e9620c9` | SOURCE_VERIFIED |
| PRECOP whitepaper (`precop_whitepaper.pdf`, in `precop`) | `v0.0.2` (paper) | DOCUMENTATION_CLAIM_ONLY |
| PRECOP yellowpaper (`precop_yellowpaper.pdf`, in `precop`) | `v0.0.2` (paper) / compiler tag `v1.9.2` | DOCUMENTATION_CLAIM_ONLY |
| PRECOP lightpaper (`lighpaper.md`, in `precop`) | self-certified alpha | DOCUMENTATION_CLAIM_ONLY |
| Delving Bitcoin — "TEE-Hardened Autonomous Agent Wallet with Simplicity Pre-Execution" | <https://delvingbitcoin.org/t/tee-hardened-autonomous-agent-wallet-with-simplicity-pre-execution/2377> | SOURCE_VERIFIED (post exists) |

The README references `github.com/BitcoinWorldTrustfoundation/simplicity-unchained`
(note lowercase "foundation"). That repository **does not exist** (GitHub 404).
The only public `simplicity-unchained` is `BlockstreamResearch/simplicity-unchained`
(a separate demo oracle). **INFERENCE**: the PRECOP README link is stale/broken.

---

## 2. On-chain transaction corpus

The three known txids decode as follows (all **ON_CHAIN_VERIFIED**, fetched from
the Blockstream mainnet API and re-decoded from raw hex).

### 2.1 CRC deploy — `546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67`

- mainnet, block `967485`, version 2, nLockTime 0, 299 B / 992 WU.
- **1 input** (key-path P2TR, single 64-byte Schnorr witness, seq `0xffffffff`):
  - prevout script `5120bf39cfdfc985043dd4f95dd2403167d3d26874dc06ab15e7e09bf4415791c79f`
  - value `210,000` sats.
- **2 outputs**:
  0. value `0`, `OP_RETURN` (`6a4c89` = OP_RETURN + PUSHDATA1 137 bytes):
     `{"p":"crc-20","op":"deploy","tick":"LEAF","type":"bonding","max":"100000000","lim":"2100000000","leaf":"1","ordi":"286","btc":"3333333"}`
  1. value `208,760`, P2WPKH `0014fd77d6ea663562bf179e775ae05d7c7dcd4ac208`.
- **fee** = `210000 − 208760` = `1,240` sats.

### 2.2 Observed CRC transfer+mint — `394bdb537c5c1e7a11fe95230cafda2394911b86a054ca1c974bcfed5b7c8feb`

- mainnet, block `967930`, version 2, nLockTime 0, 404 B / 1412 WU.
- **1 input** (key-path P2TR, single 64-byte Schnorr witness, seq `0xfffffffd`):
  - prevout script `5120f0022aead7461bcf371b7456772d7abe3d0494716c9196411926fcbef0eaa335`
  - value `859,755` sats.
- **6 outputs** (exact order):
  0. `0`, `OP_RETURN` (`6a3c`): `{"p":"ico-20","op":"transfer","tick":"LEAF","amt":"163000"}`
  1. `546`, P2PKH `76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac` (dust recipient)
  2. `0`, `OP_RETURN` (`6a28`): `{"p":"crc-20","op":"mint","tick":"LEAF"}`
  3. `330`, P2TR `5120099029af780e975a93f4fadf3b4d2d74c4dd9b6a548085f0a61619dbf9783ee0` (creator dust)
  4. `10,000`, P2TR `5120bf39cfdfc985043dd4f95dd2403167d3d26874dc06ab15e7e09bf4415791c79f` (reserve/vault anchor)
  5. `847,994`, P2TR `5120f0022aead7461bcf371b7456772d7abe3d0494716c9196411926fcbef0eaa335` (change = same as input)
- **fee** = `859755 − (546 + 330 + 10000 + 847994)` = `885` sats.

Note: output 4 (`5120bf39…c79f`) is the same script as the **deploy tx's input**.
**INFERENCE**: `5120bf39…c79f` is the persistent CRC protocol reserve anchor; the
spending key rotates (`f002…aa335` here, `bf39…c79f` at deploy).

### 2.3 PRECOP vault funding — `85985bcab81766c6cfa03e271483222e8a1bf5f4b1b0cdb44dbf224dc3d8a123`

- mainnet, block `941476`, version 2, nLockTime 0, 205 B / 616 WU.
- **1 input** (key-path P2TR, single 64-byte Schnorr witness, seq `0xffffffff`):
  - prevout script `512057655ae52edc2ebd79693271228d5389e0ae3d022f5fb5717b1da499cc72e5cc`
  - value `5,991` sats.
- **2 outputs**:
  0. value `3,000`, P2TR `512016ffa0483c67b21d36360c1480b1eedc1cef7128d279becfd5c9605f25ae8619`
     address `bc1pzml6qjpuv7ep6d3kps2gpv0wmsww7ufg6fuman74e9s97fdwscvsu8q0hs` (**vault**)
  1. value `2,841`, P2TR `512057655ae52edc2ebd79693271228d5389e0ae3d022f5fb5717b1da499cc72e5cc` (change)
- **fee** = `5991 − 3000 − 2841` = `150` sats.
- **Vault output 0 is UNSPENT** (Blockstream outspend API: `spent: false`).
  Change output 1 is spent.

### 2.4 Corpus size

The protocol discriminants observed are `"p":"crc-20"` and `"p":"ico-20"` (OP_RETURN
JSON). No public CRC.garden activity-ledger API could be located via search, so a
**complete corpus count cannot be independently enumerated** from available public
APIs. **ON_CHAIN_VERIFIED** = the three txids above. Corpus count is otherwise
**DOCUMENTATION_CLAIM_ONLY**.

---

## 3. Documented PRECOP architecture (whitepaper/yellowpaper)

All of the following is **DOCUMENTATION_CLAIM_ONLY** unless a second source
verifies it.

- **Taproot output key**: `Qₜ = P + ℋ(P ‖ Mₜ)·G` (standard BIP341 tweak over a
  MAST root `Mₜ`).
- **MAST**: described as a **5-leaf** MAST (`brc20_cdp`, `univ_dex`, `bid_dex`,
  `brc20_std`, `stake_enf`) with **truncated** (first-16-hex) CMR + tapleaf
  hashes only — the full 256-bit values are **not** published in the papers.
- **Emergency refund leaf** (yellowpaper §4.3):
  `ℓ_refund = <144> OP_CHECKSEQUENCEVERIFY OP_2DROP <borrower_pk> OP_CHECKSIG`
  — a **144-block relative timelock** refund. This is the only place `144`/OP_CSV
  appears.
- **Command-First output topology** (whitepaper §5): Output 0 = OP_RETURN
  metadata, Output 1 = primary target/vault, Output 2 = relay/change, Output 3 =
  treasury fee.
- **State**: `Sₜ = (idₜ, φₜ, Cₜ, Dₜ, hₜ)` (vault id, phase byte, collateral, debt,
  height). Phases: MINT=3, REPAY=4, LIQUIDATE=5, FREEZE=7.
- **Internal key `P`**: the papers do **not** specify a NUMS point; `P` is a
  generic symbol. The "NUMS internal key / no key-path key" claim is **NOT**
  stated in the papers.

**The user-stated target "NUMS internal key + dual-leaf MAST + 144-block OP_CSV
recovery" is NOT what the papers document.** The papers document a **5-leaf** MAST
with a generic internal key and a 144-CSV refund leaf as **one** leaf among several.

---

## 4. What the implementation actually does (L1-AGENT-WALLET)

**SOURCE_VERIFIED** (read from `enclave-signer/src/`):

- `signer.rs`: the internal key is `keypair.x_only_public_key()` from a **BIP-86
  HD key** (`m/86'/0'/0'/0/index`) held by the enclave. There **is** a usable
  key-path private key; spends use `keypair.tap_tweak(...)` (key-path).
- `signer.rs` `get_taproot_info()` (hardened mode) builds a **3-leaf** tree:
  `[recovery (depth 1)] | [allowance (depth 2) | governance (depth 2)]`.
- `policy.rs`: recovery policy is `SingleSig { pubkey: master_pubkey }` → tapscript
  `<master_xonly_pubkey> OP_CHECKSIG` — **no OP_CSV**.
- `simplicity_engine.rs`: the "Simplicity" leaves are tapscripts that merely
  `push_slice(b"simplicity_allowance_v1")` / `push_slice(b"simplicity_governance_v1")`
  — **string labels, not compiled Simplicity commitments**. The "Bit Machine"
  execution is a **Rust `if`/loop** over `psbt.unsigned_tx.output` computing an
  allowance (`total_spend ≤ limit`) and a 50,000-sat protocol-fee cap.

**Conclusion:** the reference implementation is **key-path Taproot with an HD
internal key**, a committed-but-inert MAST (string-label leaves), and a Rust
policy loop. It is **not** a NUMS/dual-leaf/144-CSV vault.

---

## 5. Part B — can the on-chain vault be reconstructed?

Target: reconstruct `Q = P + H_TapTweak(P ‖ M)·G` for the vault output
`512016ffa0483c67b21d36360c1480b1eedc1cef7128d279becfd5c9605f25ae8619`.

- The funding tx reveals **only the output key Q** (34-byte P2TR script).
- The papers publish **truncated** CMR/tapleaf hashes (first 16 hex chars), not
  full 256-bit values, so the exact MAST root `M` **cannot be reconstructed**.
- The papers do **not** publish a specific NUMS `P`; the implementation uses an
  HD key.
- The vault output is **unspent**, so no script/control block has been revealed.

**Verdict (honest):** the locally-derived P2TR **cannot** be made to match the
on-chain vault output from public evidence. The hidden leaves **cannot be
independently proven from the funding transaction alone**. The
"NUMS + dual-leaf + 144-CSV" description of *this specific tx* is
**DOCUMENTATION_CLAIM_ONLY**.

---

## 6. Part C — is the "Simplicity" real?

- **Which fork/commit?** `enclave-signer/Cargo.toml` depends on `simplicity = "0.1"`
  (crates.io). `BlockstreamResearch/simplicity-unchained` @ `b87ee158…` is the
  real "Simplicity Unchained" oracle (executes real Simplicity programs with
  `bip340_verify`, `CheckSigVerify`, `Sha256*` jets; co-signs 2-of-2 P2WSH).
- **Is Simplicity source compiled / what artifact executes?** In L1-AGENT-WALLET,
  the `.simf`/internal contract is read as **text** and matched by `String::contains`
  (`"jet::le_64"`, `"jet::bip340_verify"`). No compiled Simplicity artifact is
  loaded; no CMR is verified at runtime. → **NOT a real Simplicity execution.**
- **CMR / IMR / AMR / SWHASH committed?** The committed tapleaves are ASCII string
  labels (`simplicity_allowance_v1`), **not** CMR/SWHASH. The CMRs in the
  lightpaper/yellowpaper are **DOCUMENTATION_CLAIM_ONLY** (and truncated).
- **Does the enclave execute the Simplicity Bit Machine, or does Rust emulate?**
  Rust emulates (hand-written loop). The `println!("[BIT MACHINE] …")` lines are
  cosmetic. → **Rust `if` statement, not Simplicity.**
- **Exact predicate evaluated before the Bitcoin signature?** (SOURCE_VERIFIED)
  allowance: `Σ external-output sats (excluding OP_RETURN, change, whitelisted fee) ≤ allowance_limit`,
  plus a 50,000-sat protocol-fee cap and a "Rune tx must pay fee" rule.

**Verdict (honest):** whether production runs *actual* Simplicity is
**NOT PUBLICLY VERIFIABLE** from the L1-AGENT-WALLET code — the evidence shows a
Rust emulation with string-label tapleaves. The real `simplicity-unchained` exists
(BlockstreamResearch) but is a separate demo oracle, not obviously wired into the
on-chain vault.

### 6.1 The SHA256-preimage → BIP-66 ECDSA primitive

- The yellowpaper "Lineage" lists **"Hash-As-Signature (sha2-ecdsa, Linus 2024)"**
  as Layer 2 (**DOCUMENTATION_CLAIM_ONLY**).
- The mechanism is the Robin Linus "hash-as-signature": an ECDSA signature (BIP-66
  DER) over the transaction whose private key is a SHA-256 preimage, verified by
  Bitcoin's `OP_CHECKSIG` semantics (Simplicity `Core::CheckSigVerify` jet). It
  forces the witness to reveal a committed SHA-256 preimage inside a covenant.
- In `simplicity-unchained` (Blockstream), `CheckSigVerify` and `Sha256*` jets are
  present (**SOURCE_VERIFIED**). In L1-AGENT-WALLET's Rust engine, **no** such
  primitive is implemented (**SOURCE_VERIFIED**: absent).

---

## 7. Classification summary

| Claim | Class |
| --- | --- |
| CRC uses `crc-20`/`ico-20` OP_RETURN JSON envelopes (deploy/mint/transfer) | ON_CHAIN_VERIFIED |
| CRC deploy/mint/transfer are key-path P2TR spends | ON_CHAIN_VERIFIED |
| PRECOP vault funding output `16ffa048…8619` (3,000 sats, unspent) | ON_CHAIN_VERIFIED |
| Yellowpaper documents `<144> OP_CSV OP_2DROP <pk> OP_CHECKSIG` refund leaf | DOCUMENTATION_CLAIM_ONLY |
| Yellowpaper documents a **5-leaf** MAST | DOCUMENTATION_CLAIM_ONLY |
| "NUMS internal key, no key-path key" | **contradicted by source** (HD key) |
| "Dual-leaf MAST" | **contradicted by source** (3-leaf hardened mode) |
| Implementation uses key-path Taproot with HD internal key | SOURCE_VERIFIED |
| Implementation recovery leaf is single-sig (no CSV) | SOURCE_VERIFIED |
| Implementation "Simplicity" is a Rust loop over string-label leaves | SOURCE_VERIFIED |
| Full CMR/tapleaf values are published | **false** — truncated only |
| `simplicity-unchained` (BlockstreamResearch) is a real Simplicity oracle | SOURCE_VERIFIED |

**Primary takeaway:** the live CRC.garden product uses **key-path P2TR + OP_RETURN
JSON envelopes**, and the PRECOP "vault" as implemented uses an **HD internal key +
3-leaf MAST (string-label leaves) + Rust policy**. The NUMS/dual-leaf/144-CSV
architecture exists only as **documentation**, and is not what the on-chain funding
tx or the reference implementation demonstrates.
