# Xverse pre-prompt permission failure

The user reported “Xverse request was cancelled” after clicking **Sign and broadcast launch**, with no wallet popup. Three failing regressions reproduce the identical message when the pre-sign `wallet_getNetwork` request returns `-32002 / Access denied`; no `signPsbt` request is sent. The broad shared wallet error classifier had mistaken denied access for user cancellation.

Xverse connection now calls `wallet_connect` requesting payment/ordinals addresses and the selected network. It checks the actual returned network, selects accounts by their purpose, and passes them into the existing account resolver. This connection establishes the account read permission required by the live network check. There is no legacy connection fallback and no skipped network observation.

Returned and thrown Xverse RPC errors preserve permission failure versus actual rejection. Missing permission reports a disconnect/reconnect instruction in English and Chinese. Code 4001 remains a rejection, even when its message mentions a permission prompt; it never triggers another signing request. Existing ALL/0x83, BIP322, finalized-witness, named-input, network-mismatch and disconnect guards remain intact. No protocol rules, fee logic, layout or controls changed.

## Verification and limits

All 18 Xverse adapter tests and all 217 web tests pass, alongside typecheck/lint and the production image build. A fresh Astra review confirmed the fix direction and caught an error-code precedence issue; its new failing regression was fixed and the final recheck has no actionable findings.

The permission-grant sequence test is a transport simulation. The stored real extension response validates the connection shape, but also records a previous network-access denial. Neither proves recovery in the user's actual extension. **Real reconnect and popup recovery remain pending the user's retry**, so task `covedao-ag3.12.3` remains in progress. No user-wallet transaction was signed or broadcast.

After the replacement frontend is deployed, refresh the page, disconnect/reconnect Xverse on Signet, approve the connection request if shown, then retry **Sign and broadcast launch**. The actual funded two-account canary remains open.

The API contract follows [Xverse wallet connection documentation](https://docs.xverse.app/sats-connect/connecting-to-the-wallet/connect-to-xverse-wallet) and [network read permissions](https://docs.xverse.app/sats-connect/wallet-methods/wallet_getnetwork).
