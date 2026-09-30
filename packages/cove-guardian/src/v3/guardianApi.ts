import type * as bitcoin from "bitcoinjs-lib";
import type { CoveCanonicalView } from "@crclaunch/cove-covenant";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import type { SignedTransitionResult, GuardianV3Network } from "./types.js";
import { decodeCoveOpReturn } from "./resolve.js";
import { OP_MINT, OP_REDEEM } from "@crclaunch/cove-wire";
import type { FundingInputChecker } from "./funding.js";
import { getRpcOperationSignal, operationSignal, readBoundedJson } from "@crclaunch/bitcoin";

/**
 * Guardian SERVICE protocol + transport abstraction (Phase 8.1 §19-§20, §24).
 * The remote client talks to the Guardian service through a narrow, typed,
 * authenticated protocol — ONLY `health` and `sign` (MINT/REDEEM). There is no
 * generic sign endpoint. The transport is pluggable: an HTTP transport for
 * production and an in-process transport for tests/fixtures.
 *
 * The application NEVER supplies the backing state, input values, fees, or
 * supply — it sends only the PSBT + operation + tokenId, and the service
 * reconstructs the canonical view from its own DB/Core.
 */

export interface GuardianSignRequestWire {
  requestId: string;
  operation: "MINT" | "REDEEM";
  network: GuardianV3Network;
  psbtBase64: string;
  tokenId: string; // 64-hex; the service cross-checks against the PSBT
}

export interface GuardianSignSuccess {
  ok: true;
  /** 64-byte BIP340 Schnorr signature (hex), for independent client verify. */
  sigHex: string;
  /** The PSBT with input 0 finalized (the client applies this witness). */
  signedPsbtBase64: string;
  profileHash: string;
  guardianXOnly: string;
  /** SignedTransitionResult, bigint-safe JSON (see stringifyBigint). */
  resultJson: string;
}

export interface GuardianSignFailure {
  ok: false;
  reason: string;
  detail: string;
}

export type GuardianSignResponseWire = GuardianSignSuccess | GuardianSignFailure;

export interface GuardianHealthWire {
  reachable: boolean;
  releaseId: string;
  profileHash: string;
  guardianXOnly: string;
  auditHeadHash: string;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  custodyBackendReady: boolean;
  signingEnabled: boolean;
}

export interface GuardianTransport {
  health(): Promise<GuardianHealthWire>;
  sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire>;
}

/** The minimal request surface the Guardian service signs (structural). */
export interface GuardianSignServiceRequest {
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  fundingChecker: FundingInputChecker;
}
export type GuardianSignServiceOutcome = SignedTransitionResult | { ok: false; reason: string; detail: string };
export interface GuardianSigningService {
  recoverSigned?(req: Pick<GuardianSignServiceRequest, "psbt" | "network">, operation: "MINT" | "REDEEM"): Promise<GuardianSignServiceOutcome | null>;
  signMint(req: GuardianSignServiceRequest): Promise<GuardianSignServiceOutcome>;
  signRedeem(req: GuardianSignServiceRequest): Promise<GuardianSignServiceOutcome>;
}

/** Bigint-safe JSON round-trip (bigint ↔ { __bigint: "…" } marker). */
export function stringifyBigint(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? { __bigint: val.toString() } : val));
}
export function parseBigint<T>(s: string): T {
  return JSON.parse(s, (_k, val) =>
    val && typeof val === "object" && typeof val.__bigint === "string" ? BigInt(val.__bigint) : val,
  ) as T;
}

/** Extract the 64-byte signature (first witness stack item) from a serialized witness. */
export function extractWitnessSig(witness: Buffer): Buffer {
  let off = 0;
  const readVarInt = (): number => {
    const b = witness[off]!;
    off += 1;
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = witness.readUInt16LE(off); off += 2; return v; }
    if (b === 0xfe) { const v = witness.readUInt32LE(off); off += 4; return v; }
    const v = Number(witness.readBigUInt64LE(off)); off += 8; return v;
  };
  const count = readVarInt();
  if (count < 1) throw new Error("empty witness");
  const len = readVarInt();
  return Buffer.from(witness.subarray(off, off + len));
}

export interface InProcessGuardianTransportOptions {
  signer: GuardianSigningService;
  profileHash: string;
  guardianXOnly: string;
  /** The SERVICE's configured network (never the client's claimed network). */
  network: "regtest" | "signet" | "testnet" | "mainnet";
  decode: (psbtBase64: string) => { psbt: bitcoin.Psbt };
  loadView: (tokenId: string, psbt: bitcoin.Psbt) => Promise<CoveCanonicalView>;
  loadTicker?: (tokenId: string) => Promise<string | undefined>;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  /** Protocol fee schedule (bps). Defaults to the development COVE_FEE_CONFIG. */
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  /** The SERVICE's own funding-input checks, from its own Core and DB. */
  fundingChecker: FundingInputChecker;
  /**
   * Real readiness for /health: custody key present and matching the profile,
   * audit and journal stores answering. Without it, health reports the
   * in-process fixture defaults (tests only).
   */
  healthProbe?: () => Promise<GuardianHealthProbe>;
}

export interface GuardianHealthProbe {
  releaseId: string;
  auditHeadHash: string;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  custodyBackendReady: boolean;
}

/** In-process transport (tests/fixtures): calls the signing service directly. */
export class InProcessGuardianTransport implements GuardianTransport {
  constructor(private readonly opts: InProcessGuardianTransportOptions) {}
  async health(): Promise<GuardianHealthWire> {
    const base = { reachable: true, profileHash: this.opts.profileHash, guardianXOnly: this.opts.guardianXOnly };
    if (!this.opts.healthProbe) {
      return {
        ...base,
        releaseId: "in-process-fixture",
        auditHeadHash: "0".repeat(64),
        auditHealthy: true,
        signingJournalHealthy: true,
        custodyBackendReady: true,
        signingEnabled: true,
      };
    }
    const p = await this.opts.healthProbe();
    // Signing is enabled only when every dependency of a signature is ready.
    return { ...base, ...p, signingEnabled: p.custodyBackendReady && p.auditHealthy && p.signingJournalHealthy };
  }
  async sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire> {
    getRpcOperationSignal()?.throwIfAborted();
    const { psbt } = this.opts.decode(req.psbtBase64);
    const envelope = decodeCoveOpReturn(psbt);
    if ((req.operation !== "MINT" && req.operation !== "REDEEM") ||
      envelope.op !== (req.operation === "MINT" ? OP_MINT : OP_REDEEM) ||
      !("tokenId" in envelope) || envelope.tokenId.toString("hex") !== req.tokenId) {
      return { ok: false, reason: "REQUEST_COMMITMENT_MISMATCH", detail: "operation or token does not match the transaction" };
    }
    const recovered = await this.opts.signer.recoverSigned?.({ psbt, network: this.opts.network }, req.operation);
    getRpcOperationSignal()?.throwIfAborted();
    const view = recovered ? null : await this.opts.loadView(req.tokenId, psbt);
    getRpcOperationSignal()?.throwIfAborted();
    const base = {
      // §C3: journal/validation must use the SERVICE's configured network, never
      // the client-supplied `req.network` (a caller-controlled field).
      network: this.opts.network,
      recoveryKeyXOnly: this.opts.recoveryKeyXOnly,
      recoveryProfile: this.opts.recoveryProfile,
      feeScript: this.opts.feeScript,
      maxMinerFeeSats: this.opts.maxMinerFeeSats,
      buyFeeBps: this.opts.buyFeeBps,
      redeemFeeBps: this.opts.redeemFeeBps,
      discoveryTicker: recovered ? undefined : await this.opts.loadTicker?.(req.tokenId),
      fundingChecker: this.opts.fundingChecker,
    };
    const outcome = recovered ?? (req.operation === "MINT"
      ? await this.opts.signer.signMint({ psbt, view: view!, ...base })
      : await this.opts.signer.signRedeem({ psbt, view: view!, ...base }));
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome.detail };
    const w = psbt.data.inputs[0]!.finalScriptWitness!;
    const sig = extractWitnessSig(w);
    return {
      ok: true,
      sigHex: sig.toString("hex"),
      signedPsbtBase64: psbt.toBase64(),
      profileHash: this.opts.profileHash,
      guardianXOnly: this.opts.guardianXOnly,
      resultJson: stringifyBigint(outcome),
    };
  }
}

/**
 * Production HTTP transport: calls the Guardian service over HTTP(S) with a
 * bearer token (mTLS/operator-auth terminates in front of the service in
 * production). Enforces a timeout and throws on non-2xx.
 */
export class HttpGuardianTransport implements GuardianTransport {
  private readonly endpoint: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  constructor(endpoint: string, authToken: string, timeoutMs = 10_000) {
    // §C15: enforce TLS in production. Local loopback is the only allowed
    // non-https exception (dev/integration).
    const url = new URL(endpoint);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    // Railway private networking: service-to-service traffic on
    // *.railway.internal stays inside the project's private network, which
    // does not offer TLS. The bearer token is still required.
    const railwayPrivate = url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
    if (url.protocol !== "https:" && !local && !railwayPrivate) {
      throw new Error("HttpGuardianTransport requires an https:// endpoint (or localhost, or http on *.railway.internal)");
    }
    if (!authToken) throw new Error("HttpGuardianTransport requires a bearer token");
    this.endpoint = endpoint;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }
  async health(): Promise<GuardianHealthWire> {
    return (await this.request("GET", "/health")) as GuardianHealthWire;
  }
  async sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire> {
    return (await this.request("POST", "/sign", req)) as GuardianSignResponseWire;
  }
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const signal = operationSignal(AbortSignal.timeout(this.timeoutMs));
    signal.throwIfAborted();
    const res = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`guardian ${method} ${path}: HTTP ${res.status}`);
    }
    return readBoundedJson(res, 2_000_000, signal);
  }
}
