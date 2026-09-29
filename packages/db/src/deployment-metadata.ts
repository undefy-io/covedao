import { and, eq, inArray, getTableColumns } from "drizzle-orm";
import { schema, type Database, type DbTransaction } from "./client.js";

type Metadata = typeof schema.coveV3TokenMetadata.$inferInsert;
export async function saveDeploymentMetadata(db: Database | DbTransaction, fields: Metadata & { deployTxid: string }): Promise<void> {
  await db.insert(schema.coveV3TokenMetadata).values(fields).onConflictDoUpdate({
    target: [schema.coveV3TokenMetadata.network, schema.coveV3TokenMetadata.tokenId, schema.coveV3TokenMetadata.deployTxid],
    set: { displayName: fields.displayName, description: fields.description, websiteUrl: fields.websiteUrl,
      xUrl: fields.xUrl, imageUrl: fields.imageUrl, submittedByScript: fields.submittedByScript, updatedAt: new Date() },
  });
}

export async function canonicalDeploymentMetadata(db: Database, network: string, tokenIds: string[]) {
  if (!tokenIds.length) return [];
  const m = schema.coveV3TokenMetadata;
  const t = schema.coveV3Tokens;
  return db.select(getTableColumns(m)).from(m).innerJoin(t, and(eq(t.network, m.network),
    eq(t.tokenId, m.tokenId), eq(t.deployTxid, m.deployTxid), eq(t.canonical, true)))
    .where(and(eq(m.network, network), inArray(m.tokenId, tokenIds)));
}
