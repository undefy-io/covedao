import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "@crclaunch/db";

export async function migrateCrcTestDb(pool: Pool, db: Database): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('cove-crc-test-migrations'))");
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../db/drizzle", import.meta.url)) });
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('cove-crc-test-migrations'))");
    client.release();
  }
}
