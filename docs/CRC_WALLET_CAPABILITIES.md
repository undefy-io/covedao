# CRC wallet capability evidence

The selected candidate remains **Xverse on signet**. Task `covedao-ag3.3` stays open: the automated browser has no actual Xverse provider, and neither extension nor mobile signatures have been obtained. This document separates transport tests, core cryptographic proofs and actual wallet evidence. It does not authorize a wallet spend or a network change.

## Selected signing contract

The shared core accepts native P2WPKH and BIP86 Taproot token sellers. A reusable seller signature uses `SINGLE|ANYONECANPAY` (`0x83`) at input 0, protecting seller payout output 0. The buyer signs its own funding inputs with `ALL` (`0x01`). Previously finalized seller and Guardian witnesses must survive the buyer request. Ordinary funding may also use P2SH-P2WPKH when its actual redeem script is proven; nested token sellers are rejected before listing preparation.

Bound offer terms use `offerMessage` and BIP322 simple witness authorization. The core binds chain, deployment, ticker, listed outpoint, atoms, carrier, owner script, price, expiry and compressed public key. Wallet response framing must be measured and decoded to the canonical serialized witness hex expected by `attachOfferAuthorization`. Applications never receive wallet private keys. The exact public-key format returned by the selected wallet still needs checking against the core's BIP86 owner binding.

## Capability matrix

| Capability | Current evidence | Actual Xverse extension/mobile evidence |
| --- | --- | --- |
| Native/Taproot cryptographic verification | Same core verifies independent BIP322 and seller witnesses; Docker Core mines native/Taproot fills. Production browser verifies both. | Missing |
| Input-specific seller `0x83` request | Mock RPC receives only named indexes; input PSBT sighash remains 131. | Missing: current `signPsbt` acceptance and returned witness flag must be measured. |
| Buyer `ALL` request | Mock RPC receives only named indexes; input PSBT sighash remains 1. | Missing |
| Preserve finalized input witnesses | Mock returned PSBT retains the existing finalized witness bytes. This mock does not sign or prove provider behavior. | Missing |
| Canonical bound-message request | Mock sends exact supplied terms once with protocol `BIP322`. Core independently verifies canonical terms. | Missing: signature framing, key/script association and exact terms need a provider response. |
| Rejection and cancellation | RPC errors 4001 and a cancellation message with -32000 become `WalletError.REJECTED`, without retry. Regression fixes prior reclassification as `FAILED`. | Missing: actual popup rejection/cancellation |
| Unsupported network/provider | Regtest rejects before a provider prompt; missing provider refuses signing; mainnet address during signet connection rejects. | Missing: provider network detection and testnet-versus-signet mismatch. Both use `tb` addresses, so address decoding alone cannot distinguish them. |
| Actual signet provider | Clean read-only browser probe reports neither `XverseProviders.BitcoinProvider` nor `BitcoinProvider`. | Unavailable in this automation session |
| Existing UI | Only wallet error-handling internals changed; components, layout, styles, routes and controls remain unchanged. | Existing connected baseline is a simulated read-only fixture, not capability proof. |

## Documentation evidence and its limits

Checked 2026-10-02. Xverse's [signMessage documentation](https://docs.xverse.app/sats-connect/bitcoin-methods/signmessage) documents explicit BIP322 for supported payment and ordinals addresses. Its [signPsbt documentation](https://docs.xverse.app/sats-connect/bitcoin-methods/signpsbt) documents base64 PSBTs, per-address input indexes and returning a signed PSBT without broadcast. The example uses `ALL`; this is insufficient evidence that the current direct RPC accepts this application's `0x83` input.

The separate [signMultipleTransactions documentation](https://docs.xverse.app/sats-connect/bitcoin-methods/signmultipletransactions) shows `SINGLE|ANYONECANPAY` with the older payload shape. That is evidence for a documented method, not proof of the application's chosen direct `signPsbt` method, selected wallet version or signet transport. No method fallback or seller-online replacement has been implemented.

## Reproducible artifacts

`artifacts/crc-core-integration/wallet-capabilities/tdd-xverse-cancellation-red.log` records the two cancellation failures before the implementation change. `mock-transport-green.log` records the passing wallet transport and address-resolution tests. `browser-provider-probe.log` records the actual provider absence in the automated read-only browser. The mock provider has no signing keys; its PSBT return is an unchanged fixture.

The scoped transport/address-resolution run passes 17 tests. The full web suite passes 203 tests with 27 existing environment-dependent skips; web TypeScript, lint and production build pass. No stack deployment was performed.

An actual installed Xverse extension or mobile provider on signet is needed to close this task. Evidence must include wallet/version/network, exact seller and buyer signing requests, returned signature flags and scripts, BIP322 response framing, finalized witness preservation, cancellation and network mismatch. Any actual user-wallet spend remains subject to the later explicit session authorization required by the plan. Do not close dependent adapter/integration gates from mock, documentation or private-key evidence.
