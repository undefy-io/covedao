import process from "node:process";
import { Client } from "pg";
const db = new Client({
  connectionString: process.env.COVE_DATABASE_URL || process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
  statement_timeout: 3000,
});
try {
  await db.connect();
  const result = await db.query(
    `select r.core_reachable and not c.rebuilding
    and r.core_height-c.height between 0 and 2
    and r.chain_observed_at > clock_timestamp()-interval '30 seconds'
    and r.pending_observed_at > clock_timestamp()-interval '15 seconds' as healthy
    from cove_v3_runtime r join cove_v3_cursor c on c.network=r.network where r.network=$1`,
    [process.env.COVE_NETWORK],
  );
  process.exitCode = result.rows[0]?.healthy === true ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await db.end();
}
