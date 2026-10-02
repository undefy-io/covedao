import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as bitcoin from "bitcoinjs-lib";
import { sql } from "drizzle-orm";
import type { Database } from "@crclaunch/db";
import * as core from "@crclaunch/crc20-protocol";
import type { Input } from "@crclaunch/crc20-protocol";
import {
  guardianPsbtTransaction,
  signGuardianPsbt,
  type GuardianSigningBackend,
} from "@crclaunch/crc20-adapters";
import {
  loadCrcCoreLedger,
  loadCrcRegistration,
  crcCoreStateRoot,
  claimCrcSignature,
  completeCrcSignature,
  releaseCrcSignature,
} from "@crclaunch/crc20-state";
import {
  buildRecoveryLeafForProfile,
  tapleafHash,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";
export interface GuardianChainProvider {
  getBlockchainInfo(): Promise<{ chain: string }>;
  getBlockHash(height: number): Promise<string>;
  getRawTransaction(txid: string): Promise<string>;
  getTxout(
    txid: string,
    vout: number,
    includeMempool: boolean,
  ): Promise<{ scriptPubKeyHex: string; valueSats: bigint; confirmations: number } | null>;
}
export interface CrcSignRequest {
  requestId: string;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  deploymentTxid: string;
  operation: "mint-buy" | "inventory-buy" | "sell";
  psbtBase64: string;
}
export type CrcSignResponse =
  | { ok: true; signedPsbtBase64: string; signatureHex: string; unsignedTxDigest: string }
  | { ok: false; reason: string; detail: string };
export class CrcGuardianSigningService {
  constructor(
    private readonly options: {
      db: Database;
      core: GuardianChainProvider;
      custodyBackend: GuardianSigningBackend;
      guardianXOnly: Buffer;
      recoveryProfile: VaultRecoveryProfile;
      network: CrcSignRequest["network"];
      protocolScript: Buffer;
      maxMinerFeeSats: bigint;
    },
  ) {}
  async probe(): Promise<void> {
    await this.options.db.execute(sql`select network from crc_signatures limit 1`);
    await this.options.db.execute(sql`select network from crc_registrations limit 1`);
    await this.options.db.execute(sql`select network from crc_records limit 1`);
  }
  async sign(raw: unknown): Promise<CrcSignResponse> {
    try {
      return await this.signChecked(raw);
    } catch (error) {
      return {
        ok: false,
        reason: "CRC_SIGN_REJECTED",
        detail: error instanceof Error ? error.message : "CRC signing unavailable",
      };
    }
  }
  private async signChecked(raw: unknown): Promise<CrcSignResponse> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid CRC signing request");
    const fields = raw as Record<string, unknown>;
    if (
      Object.keys(fields).some(
        (key) =>
          !["requestId", "network", "deploymentTxid", "operation", "psbtBase64"].includes(key),
      ) ||
      typeof fields.requestId !== "string" ||
      fields.requestId.length < 1 ||
      fields.requestId.length > 128 ||
      fields.network !== this.options.network ||
      typeof fields.deploymentTxid !== "string" ||
      !/^[0-9a-f]{64}$/.test(fields.deploymentTxid) ||
      !["mint-buy", "inventory-buy", "sell"].includes(String(fields.operation)) ||
      typeof fields.psbtBase64 !== "string" ||
      fields.psbtBase64.length > 750000
    )
      throw new Error("CRC request operation, network, asset, or PSBT is invalid");
    const request = fields as unknown as CrcSignRequest;
    const network = core.protocolNetwork(request.network);
    const expectedChain = {
      bitcoin: "main",
      signet: "signet",
      testnet: "test",
      regtest: "regtest",
    }[network];
    if ((await this.options.core.getBlockchainInfo()).chain !== expectedChain)
      throw new Error("Guardian Bitcoin network mismatch");
    const ledger = await loadCrcCoreLedger(this.options.db, network);
    const asset = ledger?.assets[request.deploymentTxid];
    const registration = await loadCrcRegistration(
      this.options.db,
      network,
      request.deploymentTxid,
    );
    if (
      !ledger?.tip ||
      !asset ||
      !registration ||
      !isDeepStrictEqual(asset.config, registration.config)
    )
      throw new Error("CRC trusted registration/state unavailable or mismatched");
    const custody = asset.config.guardianCustody;
    if (
      !custody ||
      custody.guardianPublicKeyHex !== this.options.guardianXOnly.toString("hex") ||
      !Buffer.from(await this.options.custodyBackend.xOnlyPubkey()).equals(
        this.options.guardianXOnly,
      ) ||
      custody.recoveryLeafHashHex !==
        tapleafHash(buildRecoveryLeafForProfile(this.options.recoveryProfile), 0xc0).toString(
          "hex",
        ) ||
      asset.config.protocolScriptHex !== this.options.protocolScript.toString("hex")
    )
      throw new Error(
        "CRC custody/recovery or protocol destination differs from configured authority",
      );
    core.validateGuardianCustody(asset.config.vaultScriptHex, custody);
    // Recheck the signed deployment against real archived parents using the same core.
    const deploy = core.parseRawTransaction(registration.signedRawHex);
    if (deploy.txid !== request.deploymentTxid)
      throw new Error("CRC registered raw deployment identity mismatch");
    const parents = new Map<string, string>();
    const prevouts: Input[] = [];
    for (const input of deploy.inputs) {
      let rawParent = parents.get(input.txid);
      if (!rawParent) {
        rawParent = await this.options.core.getRawTransaction(input.txid);
        parents.set(input.txid, rawParent);
      }
      const parent = core.parseRawTransaction(rawParent),
        output = parent.outputs[input.vout];
      if (parent.txid !== input.txid || !output)
        throw new Error("Guardian deployment parent mismatch");
      prevouts.push({ ...input, sats: output.sats, scriptHex: output.scriptHex });
    }
    const registered = core.applyBlock(core.emptyLedger(registration.config), {
      height: 1,
      hash: "1".repeat(64),
      parentHash: "0".repeat(64),
      transactions: [{ rawHex: registration.signedRawHex, prevouts }],
    });
    if (!registered.assets[request.deploymentTxid])
      throw new Error("CRC registration is not a core deployment");
    const psbt = bitcoin.Psbt.fromBase64(request.psbtBase64);
    const transaction = guardianPsbtTransaction(psbt);
    const transition = core.validateGuardianTransaction(ledger, transaction);
    const kind = { "mint-buy": "mint", "inventory-buy": "inventoryBuy", sell: "sell" }[
      request.operation
    ];
    if (
      transition.kind !== kind ||
      transition.plan.minerFeeSats > this.options.maxMinerFeeSats ||
      core.outpoint(transition.plan.inputs[0]!) !== core.outpoint(asset.vault)
    )
      throw new Error("Guardian operation, current vault or fee cap mismatch");
    const digest = createHash("sha256")
      .update(psbt.data.globalMap.unsignedTx.toBuffer())
      .digest("hex");
    const assertLive = async () => {
      if ((await this.options.core.getBlockHash(ledger.tip!.height)) !== ledger.tip!.hash)
        throw new Error("CRC indexer cursor diverged from Core");
      for (const input of transaction.prevouts) {
        const current = await this.options.core.getTxout(input.txid, input.vout, true);
        if (
          !current ||
          current.confirmations < 1 ||
          current.scriptPubKeyHex !== input.scriptHex ||
          current.valueSats !== core.sats(input.sats)
        )
          throw new Error("CRC input prevout is spent, unconfirmed or mismatched");
      }
    };
    await assertLive();
    const context = {
      network,
      deployTxid: request.deploymentTxid,
      unsignedDigest: digest,
      stateRoot: crcCoreStateRoot(ledger),
    };
    const claim = await claimCrcSignature(this.options.db, context);
    if (claim.signedPsbtBase64) {
      const saved = bitcoin.Psbt.fromBase64(claim.signedPsbtBase64);
      if (
        createHash("sha256").update(saved.data.globalMap.unsignedTx.toBuffer()).digest("hex") !==
        digest
      )
        throw new Error("CRC journal unsigned commitment mismatch");
      const completed = guardianPsbtTransaction(saved);
      core.validateFinalTransaction(transition.plan, completed, {
        ...ledger,
        config: asset.config,
      });
      const witness = core.parseRawTransaction(completed.rawHex).inputs[0]!.witness;
      return {
        ok: true,
        signedPsbtBase64: claim.signedPsbtBase64,
        signatureHex: Buffer.from(witness[0]!).toString("hex"),
        unsignedTxDigest: digest,
      };
    }
    try {
      await assertLive();
      const signed = await signGuardianPsbt(psbt.toBase64(), ledger, this.options.custodyBackend);
      await assertLive();
      await completeCrcSignature(this.options.db, claim.claimId, context, signed.psbtBase64);
      return {
        ok: true,
        signedPsbtBase64: signed.psbtBase64,
        signatureHex: signed.signatureHex,
        unsignedTxDigest: digest,
      };
    } catch (error) {
      await releaseCrcSignature(this.options.db, claim.claimId);
      throw error;
    }
  }
}
