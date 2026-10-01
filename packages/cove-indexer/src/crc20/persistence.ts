export type CrcAsset = {
  ticker: string;
  deployTxid: string;
  deployHeight: number;
  deployBlockHash: string;
  launchSaltHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  protocolVersion: 3;
  burnedAtoms?: string;
};

export type CrcTokenUtxo = {
  scriptHex: string;
  atoms: string;
  createdHeight: number;
  createdBlockHash: string;
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
  tokenUtxos?: Record<string, Record<string, CrcTokenUtxo>>;
};

export type CrcUndo = {
  assets: Record<string, CrcAsset | null>;
  vaults: Record<string, CrcVault | null>;
  balances: Record<string, Record<string, string | null>>;
  tokenUtxos?: Record<string, Record<string, CrcTokenUtxo | null>>;
  hadTokenUtxos?: boolean;
};

const hex = /^[0-9a-f]+$/;
const txid = /^[0-9a-f]{64}$/;
const amount = /^(0|[1-9][0-9]*)$/;

function validate(projection: CrcProjection, network: string): void {
  const tokenOutpoints = new Set<string>();
  for (const [key, asset] of Object.entries(projection.assets)) {
    if (!txid.test(asset.deployTxid) || key !== `${network}:${asset.deployTxid}` ||
      !Number.isSafeInteger(asset.deployHeight) || asset.deployHeight < 0 ||
      !txid.test(asset.deployBlockHash) || !txid.test(asset.launchSaltHex) || !asset.ticker ||
      !hex.test(asset.creatorScriptHex) || !hex.test(asset.protocolScriptHex)) {
      throw new Error(`invalid CRC asset ${key}`);
    }
    if (!projection.vaults[key]) throw new Error(`CRC asset ${key} has no vault`);
    if (asset.protocolVersion !== 3) {
      throw new Error(`invalid CRC protocol version ${key}`);
    }
    if (!amount.test(asset.burnedAtoms ?? "") || !projection.tokenUtxos?.[key]) {
      throw new Error(`CRC token UTXO state is missing for ${key}`);
    }
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
  for (const [key, coins] of Object.entries(projection.tokenUtxos ?? {})) {
    const asset = projection.assets[key];
    const vault = projection.vaults[key];
    if (!asset || asset.protocolVersion !== 3 || !vault) throw new Error(`token UTXOs for unknown Cove CRC asset ${key}`);
    const derived: Record<string, bigint> = {};
    let liveAtoms = 0n;
    const vaultOutpoint = `${vault.txid}:${vault.vout}`;
    for (const [point, coin] of Object.entries(coins)) {
      if (!/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(point) ||
        !hex.test(coin.scriptHex) || coin.scriptHex.length % 2 ||
        !/^[1-9][0-9]*$/.test(coin.atoms) ||
        !Number.isSafeInteger(coin.createdHeight) || coin.createdHeight < 0 ||
        !txid.test(coin.createdBlockHash) || tokenOutpoints.has(point)) {
        throw new Error(`invalid or duplicate CRC token outpoint ${point}`);
      }
      tokenOutpoints.add(point);
      const atoms = BigInt(coin.atoms);
      liveAtoms += atoms;
      derived[coin.scriptHex] = (derived[coin.scriptHex] ?? 0n) + atoms;
      if (point === vaultOutpoint) {
        if (coin.scriptHex !== vault.scriptHex || atoms !== BigInt(vault.inventoryAtoms)) {
          throw new Error(`CRC vault token outpoint differs from inventory ${key}`);
        }
      }
    }
    if (vault.availability === "active" && BigInt(vault.inventoryAtoms) > 0n && !coins[vaultOutpoint]) {
      throw new Error(`CRC vault inventory has no live token outpoint ${key}`);
    }
    if (liveAtoms + BigInt(asset.burnedAtoms!) !== BigInt(vault.mintedAtoms)) {
      throw new Error(`CRC token UTXO supply does not reconcile ${key}`);
    }
    const holders = projection.balances[key] ?? {};
    if (Object.keys(derived).length !== Object.keys(holders).length ||
      Object.entries(derived).some(([script, atoms]) => holders[script] !== atoms.toString())) {
      throw new Error(`CRC balance is not derived from live token UTXOs ${key}`);
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
  const tokenUtxos: NonNullable<CrcUndo["tokenUtxos"]> = {};
  for (const asset of new Set([...Object.keys(before.balances), ...Object.keys(after.balances)])) {
    const delta = changed(before.balances[asset] ?? {}, after.balances[asset] ?? {});
    if (Object.keys(delta).length) balances[asset] = delta;
  }
  for (const asset of new Set([...Object.keys(before.tokenUtxos ?? {}), ...Object.keys(after.tokenUtxos ?? {})])) {
    const delta = changed(before.tokenUtxos?.[asset] ?? {}, after.tokenUtxos?.[asset] ?? {});
    if (Object.keys(delta).length) tokenUtxos[asset] = delta;
  }
  return {
    state: structuredClone(after),
    undo: { assets: changed(before.assets, after.assets), vaults: changed(before.vaults, after.vaults), balances,
      ...(Object.keys(tokenUtxos).length ? { tokenUtxos, hadTokenUtxos: before.tokenUtxos !== undefined } : {}),
    },
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
  for (const [asset, coins] of Object.entries(undo.tokenUtxos ?? {})) {
    const restoredCoins = restored.tokenUtxos?.[asset] ?? {};
    for (const [point, prior] of Object.entries(coins)) {
      if (prior === null) delete restoredCoins[point];
      else restoredCoins[point] = prior;
    }
    if (restored.assets[asset]?.protocolVersion === 3) (restored.tokenUtxos ??= {})[asset] = restoredCoins;
    else if (restored.tokenUtxos) delete restored.tokenUtxos[asset];
  }
  if (undo.hadTokenUtxos === false && restored.tokenUtxos && !Object.keys(restored.tokenUtxos).length) delete restored.tokenUtxos;
  return restored;
}
