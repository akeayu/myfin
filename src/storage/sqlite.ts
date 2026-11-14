import { createHash } from "node:crypto";
import type { JournalEntryInput, PostedJournalEntry } from "../ledger/ledger.js";
import type { LedgerRepository, LedgerTransaction } from "../ledger/posting-service.js";

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlStatement {
  run(...values: SqlValue[]): { changes: number | bigint };
  get(...values: SqlValue[]): unknown;
  all(...values: SqlValue[]): unknown[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export interface SqlMigration { readonly id: string; readonly sql: string; }
export interface AppliedMigration { readonly id: string; readonly checksum: string; }

function rows<T>(value: unknown): T[] { return value as T[]; }
function row<T>(value: unknown): T | undefined { return value as T | undefined; }
function changed(value: number | bigint): number { return Number(value); }
function checksum(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }

/** Applies ordered, immutable migrations. A changed historical migration fails closed. */
export function applyMigrations(db: SqliteDatabase, migrations: readonly SqlMigration[]): AppliedMigration[] {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const migration of ordered) {
    if (!/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(migration.id) || seen.has(migration.id)) throw new Error("Invalid or duplicate migration id: " + migration.id);
    seen.add(migration.id);
    if (!migration.sql.trim()) throw new Error("Migration SQL cannot be empty: " + migration.id);
    const digest = checksum(migration.sql);
    const existing = row<{ checksum: string }>(db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(migration.id));
    if (existing) {
      if (existing.checksum !== digest) throw new Error("Applied migration checksum mismatch: " + migration.id);
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(id, checksum, applied_at) VALUES(?, ?, ?)").run(migration.id, digest, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* retain original migration error */ }
      throw error;
    }
  }
  return rows<AppliedMigration>(db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all());
}

interface EntryRow {
  id: string; entity_id: string; idempotency_key: string; effective_date: string; recorded_at: string;
  calendar_system: "ETHIOPIAN" | "GREGORIAN"; calendar_algorithm_version: string; source_reference: string;
  posted_at: string; content_hash: string;
}
interface LineRow { account_id: string; currency: string; debit_minor: number | bigint; credit_minor: number | bigint; memo: string | null; }

function mapPosted(db: SqliteDatabase, r: EntryRow): PostedJournalEntry {
  const lines = rows<LineRow>(db.prepare("SELECT account_id, currency, debit_minor, credit_minor, memo FROM journal_lines WHERE journal_entry_id = ? ORDER BY id").all(r.id));
  return Object.freeze({
    id: r.id, entityId: r.entity_id, idempotencyKey: r.idempotency_key, effectiveDate: r.effective_date,
    recordedAt: r.recorded_at, calendarSystem: r.calendar_system, calendarAlgorithmVersion: r.calendar_algorithm_version,
    sourceReference: r.source_reference,
    lines: Object.freeze(lines.map(l => Object.freeze({
      accountId: l.account_id, currency: l.currency as PostedJournalEntry["lines"][number]["currency"],
      debitMinor: BigInt(l.debit_minor), creditMinor: BigInt(l.credit_minor), ...(l.memo === null ? {} : { memo: l.memo })
    }))),
    status: "posted", postedAt: r.posted_at, contentHash: r.content_hash
  });
}

/**
 * SQLite-backed LedgerRepository. The supplied connection must be private to the
 * application process and configured with foreign_keys=ON. Callbacks are serialized
 * by BEGIN IMMEDIATE; nested transactions are intentionally rejected.
 */
export class SqliteLedgerRepository implements LedgerRepository {
  private inTransaction = false;
  constructor(private readonly db: SqliteDatabase) {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error("Nested ledger transactions are not supported.");
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    const tx: LedgerTransaction = {
      findPostedByIdempotencyKey: async (entityId, key) => {
        const found = row<EntryRow>(this.db.prepare("SELECT id, entity_id, idempotency_key, effective_date, recorded_at, calendar_system, calendar_algorithm_version, source_reference, posted_at, content_hash FROM journal_entries WHERE entity_id = ? AND idempotency_key = ? AND status = 'posted'").get(entityId, key));
        return found ? mapPosted(this.db, found) : null;
      },
      assertAccountsBelongToEntity: async (entityId, accountLines) => {
        for (const item of accountLines) {
          const found = row<{ id: string }>(this.db.prepare("SELECT id FROM accounts WHERE id = ? AND entity_id = ? AND currency = ? AND is_active = 1").get(item.accountId, entityId, item.currency));
          if (!found) throw new Error("Account is missing, inactive, wrong entity, or wrong currency: " + item.accountId);
        }
      },
      insertPostedEntry: async entry => {
        this.db.prepare("INSERT INTO journal_entries(id, entity_id, idempotency_key, effective_date, recorded_at, calendar_system, calendar_algorithm_version, source_reference, status, posted_at, content_hash) VALUES(?,?,?,?,?,?,?,?, 'draft', NULL, NULL)")
          .run(entry.id, entry.entityId, entry.idempotencyKey, entry.effectiveDate, entry.recordedAt, entry.calendarSystem, entry.calendarAlgorithmVersion, entry.sourceReference);
        const insert = this.db.prepare("INSERT INTO journal_lines(id, journal_entry_id, entity_id, account_id, currency, debit_minor, credit_minor, memo) VALUES(?,?,?,?,?,?,?,?)");
        entry.lines.forEach((line, index) => insert.run(entry.id + ":" + index, entry.id, entry.entityId, line.accountId, line.currency, line.debitMinor, line.creditMinor, line.memo ?? null));
        const result = this.db.prepare("UPDATE journal_entries SET status = 'posted', posted_at = ?, content_hash = ? WHERE id = ? AND status = 'draft'").run(entry.postedAt, entry.contentHash, entry.id);
        if (changed(result.changes) !== 1) throw new Error("Journal posting did not update exactly one draft.");
      }
    };
    try {
      const result = await work(tx);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain original transaction error */ }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}
