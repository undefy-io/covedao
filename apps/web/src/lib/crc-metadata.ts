import { protocolNetwork } from "@crclaunch/crc20-protocol";
import { and, eq } from "drizzle-orm";
import { validateMetadata, type TokenMetadataInput } from "@crclaunch/cove-app";
import { schema, type Database } from "@crclaunch/db";

export type CrcLaunchMetadata = TokenMetadataInput;

export function parseCrcLaunchMetadata(value: unknown, ticker: string): CrcLaunchMetadata {
  if (value === undefined || value === null)
    return validateMetadata({ displayName: ticker, description: "" });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid launch metadata");
  const input = value as Record<string, unknown>;
  for (const key of ["displayName", "description", "websiteUrl", "xUrl", "imageUrl"]) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string")
      throw new Error(`Invalid ${key}`);
    if (
      typeof input[key] === "string" &&
      input[key].length > (key === "description" ? 2_000 : key === "displayName" ? 80 : 512)
    ) {
      throw new Error(`${key} is too long`);
    }
  }
  return validateMetadata({
    displayName: (input.displayName as string) ?? ticker,
    description: (input.description as string) ?? "",
    websiteUrl: input.websiteUrl as string | null | undefined,
    xUrl: input.xUrl as string | null | undefined,
    imageUrl: input.imageUrl as string | null | undefined,
  });
}

export async function saveCrcLaunchMetadata(
  db: Database,
  network: string,
  deployTxid: string,
  submittedByScript: string,
  metadata: CrcLaunchMetadata,
): Promise<void> {
  network = protocolNetwork(network);
  await db
    .insert(schema.crcMetadata)
    .values({ network, deployTxid, submittedByScript, ...metadata })
    .onConflictDoNothing({ target: [schema.crcMetadata.network, schema.crcMetadata.deployTxid] });
  const [saved] = await db
    .select()
    .from(schema.crcMetadata)
    .where(
      and(eq(schema.crcMetadata.network, network), eq(schema.crcMetadata.deployTxid, deployTxid)),
    )
    .limit(1);
  if (
    !saved ||
    saved.submittedByScript !== submittedByScript ||
    saved.displayName !== metadata.displayName ||
    saved.description !== metadata.description ||
    saved.websiteUrl !== (metadata.websiteUrl ?? null) ||
    saved.xUrl !== (metadata.xUrl ?? null) ||
    saved.imageUrl !== (metadata.imageUrl ?? null)
  ) {
    throw new Error("CRC launch metadata conflict");
  }
}
