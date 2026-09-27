# Mainnet Recovery Key Ceremony

TOOLING READY ≠ CEREMONY COMPLETE. This document describes the required
procedure; it does not claim a ceremony happened.

## Design

The simple MAINNET1 option is 1-of-1 recovery: one separate offline recovery
key, alongside the Guardian's online signing key. Private recovery material
never enters git/app/worker/Guardian/database. The code also supports 2-of-3.

## Procedure

1. Generate the one recovery key offline with
   `pnpm cove:ceremony-keys --recovery-keys 1 --out <offline-volume>/keys`.
   This also generates the separate Guardian key.
2. Keep the recovery key offline and separate from the Guardian service; back
   it up securely. Losing this one key removes the emergency recovery path.
3. Verify the public x-only keys out-of-band (compare hashes over an independent
   channel).
4. Commit ONLY the public x-only keys into the immutable mainnet profile.
5. Back up the recovery key independently of the Guardian key.
6. Test restoration of the recovery key on a fresh offline machine.
7. Destroy temporary plaintext copies.
8. After public keys are committed, rebuild the vault and verify the golden
   scriptPubKey/merkle-root/output-key vectors match.
9. Run the recovery consensus matrix (regtest): before-CSV reject, one-key
   after-CSV accept, malformed reject, destination/fee mutation rejected by tooling.

## Hard rules

- No private recovery key in any online process (mainnet rejects
  `COVE_RECOVERY_PRIVATE_KEY_HEX`).
- Recovery is an explicit emergency ceremony, never an automatic background job.
