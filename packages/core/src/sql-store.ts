import type { PaymentState } from "./state.js";
import type { QueueStore } from "./store.js";
import type { PaymentRecord } from "./types.js";

export type SqlValue = string | number | null;

/**
 * Minimal async SQL interface. On device this wraps op-sqlite (opened with a
 * SQLCipher key); in tests it wraps node:sqlite. Kept tiny so any SQLite
 * binding can be adapted in a few lines.
 */
export interface SqlDriver {
  execute(sql: string, params?: SqlValue[]): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }>;
}

/**
 * Ordered schema migrations, tracked with PRAGMA user_version. Each entry is a
 * list of statements.
 * TODO(migrations): append new entries; never edit a shipped one.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE payments (
       hash        TEXT PRIMARY KEY NOT NULL,
       xdr         TEXT NOT NULL,
       request_id  TEXT NOT NULL,
       source      TEXT NOT NULL,
       destination TEXT NOT NULL,
       amount      TEXT NOT NULL,
       asset       TEXT NOT NULL,
       sequence    TEXT NOT NULL,
       max_time    INTEGER NOT NULL,
       state       TEXT NOT NULL,
       attempts    INTEGER NOT NULL,
       last_error  TEXT,
       ledger      INTEGER,
       created_at  INTEGER NOT NULL,
       updated_at  INTEGER NOT NULL
     )`,
    "CREATE INDEX payments_state ON payments(state)",
  ],
];

const COLUMNS = [
  "hash", "xdr", "request_id", "source", "destination", "amount", "asset", "sequence",
  "max_time", "state", "attempts", "last_error", "ledger", "created_at", "updated_at",
] as const;

export class SqlQueueStore implements QueueStore {
  private constructor(private readonly db: SqlDriver) {}

  /** Runs pending migrations and returns a ready store. */
  static async open(db: SqlDriver): Promise<SqlQueueStore> {
    const { rows } = await db.execute("PRAGMA user_version");
    const version = Number(rows[0]?.user_version ?? 0);
    for (let i = version; i < MIGRATIONS.length; i++) {
      for (const statement of MIGRATIONS[i]!) await db.execute(statement);
      await db.execute(`PRAGMA user_version = ${i + 1}`);
    }
    return new SqlQueueStore(db);
  }

  async insert(record: PaymentRecord): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `INSERT INTO payments (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT(hash) DO NOTHING`,
      toRow(record),
    );
    return rowsAffected === 1;
  }

  async get(hash: string): Promise<PaymentRecord | undefined> {
    const { rows } = await this.db.execute("SELECT * FROM payments WHERE hash = ?", [hash]);
    return rows[0] && fromRow(rows[0]);
  }

  async compareAndSet(record: PaymentRecord, expected: PaymentState): Promise<boolean> {
    const [hash, ...rest] = toRow(record);
    const { rowsAffected } = await this.db.execute(
      `UPDATE payments SET ${COLUMNS.slice(1).map((c) => `${c} = ?`).join(", ")}
       WHERE hash = ? AND state = ?`,
      [...rest, hash!, expected],
    );
    return rowsAffected === 1;
  }

  async list(states?: readonly PaymentState[]): Promise<PaymentRecord[]> {
    const where = states ? `WHERE state IN (${states.map(() => "?").join(", ")})` : "";
    const { rows } = await this.db.execute(
      `SELECT * FROM payments ${where} ORDER BY created_at, hash`,
      states ? [...states] : [],
    );
    return rows.map(fromRow);
  }
}

function toRow(r: PaymentRecord): SqlValue[] {
  return [
    r.hash, r.xdr, r.requestId, r.source, r.destination, r.amount, r.asset, r.sequence,
    r.maxTime, r.state, r.attempts, r.lastError, r.ledger, r.createdAt, r.updatedAt,
  ];
}

function fromRow(row: Record<string, unknown>): PaymentRecord {
  return {
    hash: String(row.hash),
    xdr: String(row.xdr),
    requestId: String(row.request_id),
    source: String(row.source),
    destination: String(row.destination),
    amount: String(row.amount),
    asset: String(row.asset),
    sequence: String(row.sequence),
    maxTime: Number(row.max_time),
    state: row.state as PaymentState,
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    ledger: row.ledger == null ? null : Number(row.ledger),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
