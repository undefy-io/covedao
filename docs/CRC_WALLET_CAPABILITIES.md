# CRC wallet capability evidence

Selected wallet: **Xverse desktop extension 2.9.3 on Signet**. An isolated, fresh, unfunded wallet produced the signatures below. Its keys stayed inside the unmodified official extension. The application received public keys and signatures only. All transaction prevouts were synthetic and every PSBT signing request set `broadcast:false`. No wallet was funded and no transaction was broadcast. Mobile and live-network execution remain unverified release gates.

## Selected signing contract

The shared core accepts native P2WPKH and BIP86 Taproot sellers. Seller input 0 signs `SINGLE|ANYONECANPAY` (`0x83`), protecting payout output 0. Buyers sign only their funding indexes with `ALL` (`0x01`). Native, nested P2SH-P2WPKH and BIP86 funding were measured. Nested addresses are funding-only; the core rejects nested token sellers.

Offer authorization uses the exact canonical `offerMessage` with `signMessage` protocol `BIP322`. Xverse returns base64 serialized witness bytes, converted to canonical witness hex for `attachOfferAuthorization`. Native keys are compressed; the actual BIP86 key is 32-byte internal x-only. `canonicalOfferPublicKey` normalizes it to even compressed encoding and proves the owner script before prompting. Existing signed terms remain valid.

Use fresh `wallet_getNetwork` metadata before signing. Address prefixes cannot distinguish Signet from testnet. The isolated wallet reported `Signet` and `Regtest` after UI selection; the probe refused a Signet signing request while Regtest was selected, then restored Signet. This is capability evidence for the future production adapter, not evidence that current application internals already implement that guard.

## Capability matrix

| Capability | Actual desktop evidence | Limits |
| --- | --- | --- |
| Native/Taproot canonical BIP322 | Both real signatures verify in the core and Astra's independent bitcoinjs/secp256k1 calculation. | Synthetic offer; no on-chain allocation. |
| Seller input-specific `0x83` | Both returned seller witnesses verify with flag 131 against the exact payout. | Partial transaction deliberately has negative standalone fee; cannot broadcast alone. |
| Buyer input-specific `ALL` | Native, nested and Taproot funding signatures verify; only input 1 requested. Exact core purchase plan and 1,000-sat fee verified. | Synthetic funding; same account's different keys, not two distinct wallets. |
| Preserve finalized seller | Buyer PSBT retains input 0 witness byte-for-byte; unsigned transaction unchanged. | Both native and Taproot seller key paths. |
| Preserve finalized Guardian | Actual native buyer response retains the four-item finalized script-path witness; both signatures verify and fee equals 1,000 sats. | Known test Guardian key and OP_TRUE recovery fixture; no production recovery/custody claim. |
| Cancellation | Actual popup Cancel returns JSON-RPC -32000, `User rejected request to sign Psbt`. Transport regression preserves `WalletError.REJECTED`. | Message cancellation separately unmeasured. |
| Network mismatch | Actual `wallet_getNetwork` distinguishes Signet/Regtest; probe aborts before signPsbt on mismatch. | Production adapter implementation belongs to .4/.9. A separate wallet_connect network request produced no useful response; it is not capability evidence. |
| Mobile and live spend | Unverified. | Remain release gates; actual user-wallet spending needs later explicit authorization. |
| Existing frontend UI | No components, styles, routes, layout or controls changed. | Historical connected baseline remains simulated. |

## Reproducible evidence

All evidence is under `artifacts/crc-core-integration/wallet-capabilities/`. `extension-provenance.json` records the official Google CRX hash and version, unmodified unpacked distribution, isolated headed Chrome/Xvfb environment and fresh wallet. Store extension ID differs from the unpacked ID; this is not an existing user installation.

`xverse-real-connect.json` contains native/Taproot public metadata; `xverse-nested-connect.json` records the wallet's nested preference. `xverse-message-*`, `xverse-seller-*` and `xverse-buyer-*` contain exact requests, actual RPC responses and review screenshots. Offer fixtures reconstruct actual seller transactions. `xverse-guardian-*` records script-path preservation. `xverse-buyer-payment-cancel.log` records actual rejection. `xverse-network-{signet,regtest}.json` and `xverse-network-mismatch.log` record metadata and refusal.

`wallet-evidence.test.ts` verifies captured signatures and reconstructs final transaction bytes from actual returned PSBTs; it does not trust saved `coreVerified` flags. `wallet-key.test.ts` covers public-key normalization and mismatches. Test-only probe utilities in `test-support/` use the public core and bitcoinjs PSBT encoding; they are not exported or used as production adapters. `tdd-wallet-key-red.log` records the missing-helper failure before implementation. Earlier mock transport and missing-provider artifacts describe their own earlier environments, not the actual extension session.

Official [signMessage](https://docs.xverse.app/sats-connect/bitcoin-methods/signmessage) and [signPsbt](https://docs.xverse.app/sats-connect/bitcoin-methods/signpsbt) documentation informed the requests. Actual measured responses establish desktop behavior; documentation or mocks alone do not establish signing capability. No method fallback or seller-online replacement was added.
