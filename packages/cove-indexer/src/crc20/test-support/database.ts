import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "@crclaunch/db";
import { migrateCrcTestDb } from "../test-migration.js";
/** Own disposable database; never connects to a configured application database. */
export async function isolatedDatabase() {
  const name = `crc-core-db-${randomUUID()}`;
  let pool: Pool | undefined;
  try {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--publish",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_DB=crc_core_test",
        "-e",
        "POSTGRES_USER=crc_test",
        "-e",
        "POSTGRES_PASSWORD=crc_test",
        "postgres:16-alpine",
      ],
      { stdio: "pipe" },
    );
    const ports = JSON.parse(
      execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name], {
        encoding: "utf8",
      }),
    );
    pool = new Pool({
      host: "127.0.0.1",
      port: Number(ports["5432/tcp"][0].HostPort),
      database: "crc_core_test",
      user: "crc_test",
      password: "crc_test",
      max: 4,
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
    });
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        await pool.query("select 1");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const db = drizzle(pool, { schema });
    await migrateCrcTestDb(pool, db);
    const close = async () => {
      await pool!.end();
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "pipe" });
    };
    return { db, pool, close };
  } catch (error) {
    if (pool) await pool.end();
    try {
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "pipe" });
    } catch {
      /* Container startup may have failed. */
    }
    throw error;
  }
}
