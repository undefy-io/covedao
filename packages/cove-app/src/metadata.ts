import { eq, and, inArray } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
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
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
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
  await params.db
    .insert(schema.coveV3TokenMetadata)
    .values({
      network: params.network,
      tokenId: params.tokenId,
      displayName: m.displayName,
      description: m.description,
      websiteUrl: m.websiteUrl,
      xUrl: m.xUrl,
      imageUrl: m.imageUrl,
      submittedByScript: params.submittedByScript,
      deployTxid: params.deployTxid,
    })
    .onConflictDoUpdate({
      target: [schema.coveV3TokenMetadata.network, schema.coveV3TokenMetadata.tokenId],
      set: {
        displayName: m.displayName,
        description: m.description,
        websiteUrl: m.websiteUrl,
        xUrl: m.xUrl,
        imageUrl: m.imageUrl,
        submittedByScript: params.submittedByScript,
        deployTxid: params.deployTxid,
        updatedAt: new Date(),
      },
    });
}

export async function getTokenMetadata(db: Database, network: string, tokenId: string) {
  const rows = await db
    .select()
    .from(schema.coveV3TokenMetadata)
    .where(
      and(
        eq(schema.coveV3TokenMetadata.network, network),
        eq(schema.coveV3TokenMetadata.tokenId, tokenId),
      ),
    );
  return rows[0] ?? null;
}

export async function listTokenMetadataByTokenIds(
  db: Database,
  network: string,
  tokenIds: string[],
) {
  if (tokenIds.length === 0) return [];
  return db
    .select()
    .from(schema.coveV3TokenMetadata)
    .where(
      and(
        eq(schema.coveV3TokenMetadata.network, network),
        inArray(schema.coveV3TokenMetadata.tokenId, tokenIds),
      ),
    );
}
