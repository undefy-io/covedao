# Guardian Custody Backend — Selection Guide

The Guardian service signs Cove backing-state transitions (MINT/REDEEM) only
through the `GuardianCustodyBackend` interface (`packages/cove-guardian/src/v3/custody.ts`):

```ts
interface GuardianCustodyBackend {
  xOnlyPubkey(): Promise<Buffer>;                 // 32-byte x-only key committed in the vault
  signTaprootScriptPath(p: {                      // 64-byte BIP340 Schnorr signature
    sighash: Buffer;                              //   over the exact BIP341 SIGHASH_DEFAULT sighash
    leafTapleafHash: Buffer;
  }): Promise<Buffer>;
}
```

There is **no `exportPrivateKey`**. The private key never leaves the custody
backend. The production backend is **not selected yet** — until one is configured,
the service fails closed with `CUSTODY_BACKEND_NOT_CONFIGURED`.

The interface is intentionally minimal so that any of the three options below
can be implemented **without rewriting application code**: the Guardian service
already loads the profile, validates (Simplicity + reference policy), durably
records `VALIDATED_TO_SIGN`, reserves the backing outpoint, and — only then —
requests this one Schnorr signature.

## How `guardianXOnly` is derived

`guardianXOnly` (the public key committed in the `MAINNET1` vault's execution
leaves and in the public profile) is the **x-only form of the custody key's
secp256k1 public point** — i.e. the 32-byte x-coordinate of the compressed
public key, with no parity byte (BIP340). It is NOT the WIF, NOT the full pubkey,
and NOT a hash. It must be:

1. Generated inside the custody device/KMS during setup (the private key never
   leaves it).
2. Exported from the device as a 32-byte hex x-only value.
3. Committed into `packages/cove-mainnet/src/committed-profile.ts` as `guardianXOnly` and
   into the vault leaves by the deploy tooling.

The BIP340 signer inside the device handles the even-y negation, so the x-only
key + the produced Schnorr signature always verify against each other.

## Option A — Dedicated hardware signer (HSM)

**What you buy / set up:** a dedicated hardware security module or signing card
that supports BIP340 Schnorr over a raw 32-byte message (e.g. a Bitcoin-oriented
HSM, a hardware wallet with an external-signer API, or an isolated signing
server with a TPM-sealed key).

**How the key stays off the app host:** the device generates and holds the key;
the Guardian service sends only the 32-byte sighash and receives a 64-byte
signature. The device is reachable only over a hardened, mTLS-authenticated link.

**Implementation:** wrap the device SDK in a `GuardianCustodyBackend`
(`xOnlyPubkey` reads the exported x-only key; `signTaprootScriptPath` calls the
device's BIP340-sign verb). No key material on disk.

**Failure mode mid-sign:** if the device is unreachable, `signTaprootScriptPath`
throws → the Guardian service aborts the signature (the `VALIDATED_TO_SIGN`
audit row is already durable and the outpoint is already reserved, so a later
retry of the **same** digest is idempotent and a **different** digest is refused).
The remote client surfaces `REMOTE_GUARDIAN_UNAVAILABLE`/`GUARDIAN_TIMEOUT`.
No half-signed witness is ever returned.

## Option B — Cloud KMS / managed HSM

**What you buy / set up:** a cloud key-management service that exposes asymmetric
**secp256k1 sign with a raw digest** (BIP340-compatible). Verify the vendor's
sign operation is pure Schnorr over the raw 32-byte sighash (some KMS only do
ECDSA or apply their own hashing — those are unsuitable).

**How the key stays off the app host:** the key lives in the KMS (HSM-backed);
the app authenticates to the KMS with a short-lived credential, sends the sighash,
and gets back the signature. `guardianXOnly` is the x-coordinate exported once
at key creation (or derived from the KMS's public-key blob).

**Implementation:** a thin `GuardianCustodyBackend` calling the KMS sign API.

**Failure mode mid-sign:** identical to Option A — unreachable/unauthorized KMS
throws, the signature is not produced, and the durable journal prevents a
conflicting successor.

## Option C — Remote custody service (dedicated signing service)

**What you buy / set up:** a separate operator-run signing service (can be the
same `apps/guardian` deployment but with the key isolated to a dedicated host +
process), reachable only over mTLS, that itself fronts a hardware/KMS backend.

**How the key stays off the app host:** the key exists only on the custody
service host; the web/worker `RemoteGuardianTransitionSigner` talks to it over
the narrow `health`/`sign` protocol and **independently re-verifies** the returned
signature against the committed `guardianXOnly` before accepting it.

**Implementation:** this is already the shape of `apps/guardian` + the
`GuardianCustodyBackend` seam; select the inner backend (A or B) as the last
piece.

**Failure mode mid-sign:** the custody service's own `writeBeforeSign`/journal
steps preserve immutable results for each valid candidate, and the client's independent verification
rejects a spoofed or wrong-key signature (`SIGNATURE_VERIFICATION_FAILED`).

## Decision checklist before ceremony

- [ ] Pick A, B, or C and confirm BIP340 raw-digest sign support.
- [ ] Generate the key inside the backend; export ONLY the 32-byte x-only pubkey.
- [ ] Commit `guardianXOnly` to the public profile and rebuild/deploy the vault
      leaves from it.
- [ ] Configure the Guardian service with the chosen backend (no `exportPrivateKey`).
- [ ] Confirm `/health` reports `custodyBackendReady: true` and the reported
      `guardianXOnly` equals the profile's value.

## What must NOT be done

- Do not put the custody private key, a WIF, or a KMS long-lived credential on
  the web/worker/app host.
- Do not add a generic `sign(anything)` verb to the backend — only the
  tapscript-path sighash is ever signed.
- Do not fall back to a local in-process key on mainnet (the service uses
  `UnconfiguredGuardianCustodyBackend` until a real backend is selected).
