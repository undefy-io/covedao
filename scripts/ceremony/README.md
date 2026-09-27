# Key-generation ceremony

The offline key-generation tool lives at
`packages/cove-vault/src/ceremony-keys.ts` and is invoked from the repo root as:

```bash
pnpm cove:ceremony-keys --recovery-keys 1 --out /Volumes/ceremony/keys
```

## What it does

- Generates **1 Guardian + 1 recovery** keypair with the command above. Use
  `--recovery-keys 3` only if you choose the 2-of-3 recovery profile.
- Derives and prints only the **x-only BIP340 public keys** (32-byte x-coordinate,
  **no parity byte**) for the `guardianXOnly` + `recovery.pubkeys` profile fields.
- Writes each private key (hex) to a **separate** file
  (`guardian.key`, `recovery-1.key`) under
  `--out`, with **mode 0600**.
- **Never** writes a private key to the repo tree or to `stdout`; it refuses to
  overwrite an existing key file.

## Storage checklist

- [ ] `guardian.key` → the Guardian service ONLY, as `GUARDIAN_KEY_HEX` (its
      64 hex characters). It is a hot key: the Guardian signs every mint and
      redeem automatically. Never on the web or worker. The service refuses
      to start if it does not match the profile's `guardianXOnly`. Keep the
      offline file as the backup.
- [ ] `recovery-1.key` → offline signer 1 (separate physical location).
- [ ] Confirm each file is `0600` and gitignored (the `--out` dir should be
      `.ceremony/` or an encrypted volume — never the repo).
- [ ] Verify the printed x-only pubkeys before funding or deploying anything.

The private-key files are for the operator's own offline storage only; the
**public** x-only values are what go into
`packages/cove-mainnet/src/committed-profile.ts`. For 1-of-1 recovery, use
one recovery key and `threshold: 1` (the current mainnet template).
