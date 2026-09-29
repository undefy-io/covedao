import { saveDeploymentMetadata, canonicalDeploymentMetadata, type Database } from "@crclaunch/db";
import { AppError } from "./errors.js";

/**
 * Application token metadata, keyed by network+tokenId (§13/§14). Plain text
 * only, bounded length, https URLs only. Never rendered as raw HTML. Never
 * overrides chain truth (tokenId/ticker/supply/backing/version).
 */

export interface TokenMetadataInput {
  displayName: string;
  description: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  imageUrl?: string | null;
}

const MAX_NAME = 80;
const MAX_DESC = 2000;

function bounded(text: string, max: number): string {
  const s = text.trim();
  if (s.length === 0) throw new AppError("METADATA_INVALID", "text must not be empty");
  if (s.length > max) throw new AppError("METADATA_INVALID", `text exceeds ${max} characters`);
  if (Array.from(s).some((char) => { const code = char.charCodeAt(0); return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31); }))
    throw new AppError("METADATA_INVALID", "control characters not allowed");
  return s;
}

function httpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^https:\/\/[^\s]+$/i.test(s)) throw new AppError("METADATA_INVALID", "URL must be https");
  return s;
}

export function validateMetadata(input: TokenMetadataInput): TokenMetadataInput {
  return {
    displayName: bounded(input.displayName, MAX_NAME),
    // A description is optional: plenty of tokens launch with a name alone.
    description:
      (input.description ?? "").trim() === "" ? "" : bounded(input.description, MAX_DESC),
    websiteUrl: httpsUrl(input.websiteUrl),
    xUrl: httpsUrl(input.xUrl),
    imageUrl: httpsUrl(input.imageUrl),
  };
}

export async function upsertTokenMetadata(params: {
  db: Database;
  network: string;
  tokenId: string;
  submittedByScript: string;
  deployTxid: string | null;
  metadata: TokenMetadataInput;
}): Promise<void> {
  const m = validateMetadata(params.metadata);
  if (!params.deployTxid) throw new AppError("METADATA_INVALID", "deployment transaction is required");
  await saveDeploymentMetadata(params.db, { network: params.network, tokenId: params.tokenId,
    ...m, submittedByScript: params.submittedByScript, deployTxid: params.deployTxid });
}

export async function getTokenMetadata(db: Database, network: string, tokenId: string) {
  return (await canonicalDeploymentMetadata(db, network, [tokenId]))[0] ?? null;
}

export async function listTokenMetadataByTokenIds(db: Database, network: string, tokenIds: string[]) {
  return canonicalDeploymentMetadata(db, network, tokenIds);
}
