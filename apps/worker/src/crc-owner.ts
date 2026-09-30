import { Client } from "pg";

export async function acquireCrcOwner(databaseUrl: string, network: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      [`cove-crc-owner:${network}`],
    );
    if (!result.rows[0]?.acquired) throw new Error(`another CRC worker already owns ${network}`);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
