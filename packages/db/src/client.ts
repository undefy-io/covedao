import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createDb(url: string): Database {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 });
  return drizzle(pool, { schema });
}

export { schema };
