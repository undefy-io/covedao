export type CrcAsset = {
  ticker: string;
  deployTxid: string;
  deployHeight: number;
  deployBlockHash: string;
  launchSaltHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
};

export type CrcVault = {
  txid: string;
  vout: number;
  scriptHex: string;
  btcSats: string;
  mintedAtoms: string;
  inventoryAtoms: string;
  availability: "active" | "unavailable";
};

export type CrcProjection = {
  assets: Record<string, CrcAsset>;
  vaults: Record<string, CrcVault>;
  balances: Record<string, Record<string, string>>;
};

export type CrcUndo = {
  assets: Record<string, CrcAsset | null>;
  vaults: Record<string, CrcVault | null>;
  balances: Record<string, Record<string, string | null>>;
};

const hex = /^[0-9a-f]+$/;
const txid = /^[0-9a-f]{64}$/;
const amount = /^(0|[1-9][0-9]*)$/;

function validate(projection: CrcProjection, network: string): void {
  for (const [key, asset] of Object.entries(projection.assets)) {
    if (!txid.test(asset.deployTxid) || key !== `${network}:${asset.deployTxid}` ||
      !Number.isSafeInteger(asset.deployHeight) || asset.deployHeight < 0 ||
      !txid.test(asset.deployBlockHash) || !txid.test(asset.launchSaltHex) || !asset.ticker ||
      !hex.test(asset.creatorScriptHex) || !hex.test(asset.protocolScriptHex)) {
      throw new Error(`invalid CRC asset ${key}`);
    }
    if (!projection.vaults[key]) throw new Error(`CRC asset ${key} has no vault`);
  }
  for (const [key, vault] of Object.entries(projection.vaults)) {
    if (!projection.assets[key] || !txid.test(vault.txid) ||
      !Number.isSafeInteger(vault.vout) || vault.vout < 0 ||
      !hex.test(vault.scriptHex) || !amount.test(vault.btcSats) ||
      !amount.test(vault.mintedAtoms) || !amount.test(vault.inventoryAtoms) ||
      BigInt(vault.inventoryAtoms) > BigInt(vault.mintedAtoms) ||
      (vault.availability !== "active" && vault.availability !== "unavailable")) {
      throw new Error(`invalid CRC vault ${key}`);
    }
  }
  for (const [key, holders] of Object.entries(projection.balances)) {
    if (!projection.assets[key]) throw new Error(`balance for unknown CRC asset ${key}`);
    for (const [script, atoms] of Object.entries(holders)) {
      if (!hex.test(script) || script.length % 2 || !amount.test(atoms) || atoms === "0") {
        throw new Error(`invalid CRC balance ${key}:${script}`);
      }
    }
  }
}

function changed<T>(before: Record<string, T>, after: Record<string, T>): Record<string, T | null> {
  const undo: Record<string, T | null> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const prior = before[key] ?? null;
    const next = after[key] ?? null;
    if (JSON.stringify(prior) !== JSON.stringify(next)) undo[key] = prior;
  }
  return undo;
}

export function applyCrcBlock(before: CrcProjection, after: CrcProjection, network: string): { state: CrcProjection; undo: CrcUndo } {
  validate(before, network);
  validate(after, network);
  const balances: CrcUndo["balances"] = {};
  for (const asset of new Set([...Object.keys(before.balances), ...Object.keys(after.balances)])) {
    const delta = changed(before.balances[asset] ?? {}, after.balances[asset] ?? {});
    if (Object.keys(delta).length) balances[asset] = delta;
  }
  return {
    state: structuredClone(after),
    undo: { assets: changed(before.assets, after.assets), vaults: changed(before.vaults, after.vaults), balances },
  };
}

export function rollbackCrcBlock(current: CrcProjection, undo: CrcUndo): CrcProjection {
  const restored = structuredClone(current);
  for (const [key, prior] of Object.entries(undo.assets)) {
    if (prior === null) delete restored.assets[key];
    else restored.assets[key] = prior;
  }
  for (const [key, prior] of Object.entries(undo.vaults)) {
    if (prior === null) delete restored.vaults[key];
    else restored.vaults[key] = prior;
  }
  for (const [asset, holders] of Object.entries(undo.balances)) {
    const account = restored.balances[asset] ?? {};
    for (const [script, prior] of Object.entries(holders)) {
      if (prior === null) delete account[script];
      else account[script] = prior;
    }
    if (Object.keys(account).length) restored.balances[asset] = account;
    else delete restored.balances[asset];
  }
  return restored;
}
