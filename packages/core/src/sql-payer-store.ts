import type { PayerSnapshot, PayerStore, PendingDebit } from "./payer.js";
import { migrate, type SqlDriver } from "./sql-store.js";

/**
 * PayerStore in the same (SQLCipher) database as the payment queue.
 *
 * Each save is ONE statement (an upsert of the single `payer_state` row, with
 * balances and pending debits as JSON). That makes it atomic without a
 * transaction, which matters because the queue shares the connection: a
 * BEGIN…COMMIT here could absorb, or roll back, a concurrent queue write.
 */
export class SqlPayerStore implements PayerStore {
  private constructor(private readonly db: SqlDriver) {}

  static async open(db: SqlDriver): Promise<SqlPayerStore> {
    await migrate(db);
    return new SqlPayerStore(db);
  }

  async load(): Promise<PayerSnapshot | undefined> {
    const { rows } = await this.db.execute("SELECT * FROM payer_state WHERE id = 1");
    const row = rows[0];
    if (!row) return undefined;
    return {
      publicKey: String(row.public_key),
      sequence: String(row.sequence),
      syncedAt: Number(row.synced_at),
      clockOffsetSeconds: Number(row.clock_offset),
      balances: JSON.parse(String(row.balances)) as Record<string, string>,
      pending: JSON.parse(String(row.pending)) as PendingDebit[],
    };
  }

  async save(snapshot: PayerSnapshot): Promise<void> {
    await this.db.execute(
      `INSERT INTO payer_state (id, public_key, sequence, synced_at, clock_offset, balances, pending)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         public_key = excluded.public_key, sequence = excluded.sequence, synced_at = excluded.synced_at,
         clock_offset = excluded.clock_offset, balances = excluded.balances, pending = excluded.pending`,
      [
        snapshot.publicKey,
        snapshot.sequence,
        snapshot.syncedAt,
        snapshot.clockOffsetSeconds,
        JSON.stringify(snapshot.balances),
        JSON.stringify(snapshot.pending),
      ],
    );
  }
}
