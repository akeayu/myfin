import { SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { JournalEntryInput, PostedJournalEntry } from "../ledger/ledger.js";
import type { LedgerRepository, LedgerTransaction } from "../ledger/posting-service.js";

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlRunResult { readonly changes: number; readonly lastId?: number; }
export interface EncryptionSecretProvider { getOrCreateSecret(): Promise<string>; }

export interface AsyncSqliteDatabase {
  execute(sql: string): Promise<void>;
  run(sql: string, values?: readonly SqlValue[]): Promise<SqlRunResult>;
  query<T extends object>(sql: string, values?: readonly SqlValue[]): Promise<readonly T[]>;
  transaction<T>(work: (db: AsyncSqliteDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type PluginValue = string | number | null | Blob | ArrayBuffer;
function pluginValues(values: readonly SqlValue[] = []): PluginValue[] {
  return values.map(value => {
    if (typeof value === "bigint") {
      if (value < -9223372036854775808n || value > 9223372036854775807n) throw new Error("SQLite INTEGER binding exceeds the signed 64-bit range.");
      return value.toString();
    }
    return value instanceof Uint8Array ? value.slice().buffer as ArrayBuffer : value as PluginValue;
  });
}

/**
 * Asynchronous adapter for @capacitor-community/sqlite. One instance owns one
 * opened connection. Do not share it across independent app processes or workers.
 * All parameterized writes use the plugin's run() API; DDL/multi-statement SQL
 * uses execute(). Transactions use the plugin transaction methods, never SQL
 * BEGIN/COMMIT statements sent through the bridge.
 */
export class CapacitorSqliteDatabase implements AsyncSqliteDatabase {
  private transactionActive = false;
  private closed = false;

  private constructor(private readonly connection: SQLiteDBConnection) {}

  /** Injection seam for deterministic bridge-contract tests; production uses open(). */
  static fromConnection(connection: SQLiteDBConnection): CapacitorSqliteDatabase {
    return new CapacitorSqliteDatabase(connection);
  }

  static async open(options: {
    database: string;
    encrypted: boolean;
    mode?: "encryption" | "secret" | "newsecret";
    encryptionSecretProvider?: EncryptionSecretProvider;
    version?: number;
    readonly?: boolean;
  }): Promise<CapacitorSqliteDatabase> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.database)) throw new Error("Invalid MYFIN database name.");
    const sqlite = new SQLiteConnection((await import("@capacitor-community/sqlite")).CapacitorSQLite);
    const consistent = (await sqlite.checkConnectionsConsistency()).result;
    const exists = (await sqlite.isConnection(options.database, options.readonly ?? false)).result;
    if (options.encrypted) {
      if (!(await sqlite.isInConfigEncryption()).result) throw new Error("Capacitor SQLite encryption is disabled in capacitor.config.");
      const secretStored = (await sqlite.isSecretStored()).result;
      if (!secretStored) {
        if (!options.encryptionSecretProvider) throw new Error("Encrypted MYFIN storage requires an Android Keystore-backed encryption secret provider.");
        const secret = await options.encryptionSecretProvider.getOrCreateSecret();
        if (secret.length < 32) throw new Error("The encryption secret provider returned an insufficient secret.");
        await sqlite.setEncryptionSecret(secret);
        if (!(await sqlite.isSecretStored()).result) throw new Error("The SQLite plugin did not persist the provisioned encryption secret.");
      }
    }
    const connection = consistent && exists
      ? await sqlite.retrieveConnection(options.database, options.readonly ?? false)
      : await sqlite.createConnection(options.database, options.encrypted, options.mode ?? (options.encrypted ? "secret" : "no-encryption"), options.version ?? 1, options.readonly ?? false);
    await connection.open();
    if (options.encrypted && !(await sqlite.isDatabaseEncrypted(options.database)).result) {
      await connection.close();
      throw new Error("SQLCipher did not report the MYFIN database as encrypted.");
    }
    const adapter = new CapacitorSqliteDatabase(connection);
    await adapter.execute("PRAGMA foreign_keys = ON");
    return adapter;
  }

  async execute(sql: string): Promise<void> {
    this.assertOpen();
    const result = await this.connection.execute(sql, false);
    if ((result.changes?.changes ?? 0) < 0) throw new Error("Capacitor SQLite execute failed.");
  }

  async run(sql: string, values: readonly SqlValue[] = []): Promise<SqlRunResult> {
    this.assertOpen();
    const result = await this.connection.run(sql, pluginValues(values), false, "no");
    const changes = result.changes?.changes ?? 0;
    if (changes < 0) throw new Error("Capacitor SQLite run failed.");
    return { changes, ...(result.changes?.lastId === undefined ? {} : { lastId: result.changes.lastId }) };
  }

  async query<T extends object>(sql: string, values: readonly SqlValue[] = []): Promise<readonly T[]> {
    this.assertOpen();
    const result = await this.connection.query(sql, pluginValues(values));
    return (result.values ?? []) as T[];
  }

  async transaction<T>(work: (db: AsyncSqliteDatabase) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.transactionActive) throw new Error("Nested MYFIN SQLite transactions are not supported.");
    this.transactionActive = true;
    await this.connection.beginTransaction();
    try {
      const result = await work(this);
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      try { await this.connection.rollbackTransaction(); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.transactionActive) throw new Error("Cannot close MYFIN SQLite while a transaction is active.");
    await this.connection.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MYFIN SQLite connection is closed.");
  }
}

export interface AsyncSqlMigration { readonly id: string; readonly sql: string; }
export interface AppliedAsyncMigration { readonly id: string; readonly checksum: string; }

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Applies immutable migrations using asynchronous plugin operations. */
export async function applyAsyncMigrations(db: AsyncSqliteDatabase, migrations: readonly AsyncSqlMigration[]): Promise<AppliedAsyncMigration[]> {
  await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const migration of ordered) {
    if (!/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(migration.id) || seen.has(migration.id) || !migration.sql.trim()) {
      throw new Error("Invalid or duplicate migration: " + migration.id);
    }
    seen.add(migration.id);
    const checksum = await sha256(migration.sql);
    const existing = await db.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE id = ?", [migration.id]);
    if (existing.length) {
      if (existing[0]!.checksum !== checksum) throw new Error("Applied migration checksum mismatch: " + migration.id);
      continue;
    }
    await db.transaction(async tx => {
      await tx.execute(migration.sql);
      await tx.run("INSERT INTO schema_migrations(id, checksum, applied_at) VALUES(?,?,?)", [migration.id, checksum, new Date().toISOString()]);
    });
  }
  return [...await db.query<AppliedAsyncMigration>("SELECT id, checksum FROM schema_migrations ORDER BY id")];
}

interface EntryRow {
  id: string; entity_id: string; idempotency_key: string; effective_date: string; recorded_at: string;
  calendar_system: "ETHIOPIAN" | "GREGORIAN"; calendar_algorithm_version: string; source_reference: string;
  posted_at: string; content_hash: string;
}
interface LineRow { account_id: string; currency: string; debit_minor: number | string; credit_minor: number | string; memo: string | null; }

async function mapPosted(db: AsyncSqliteDatabase, entry: EntryRow): Promise<PostedJournalEntry> {
  const lines = await db.query<LineRow>("SELECT account_id,currency,debit_minor,credit_minor,memo FROM journal_lines WHERE journal_entry_id=? ORDER BY id", [entry.id]);
  return Object.freeze({
    id: entry.id, entityId: entry.entity_id, idempotencyKey: entry.idempotency_key, effectiveDate: entry.effective_date,
    recordedAt: entry.recorded_at, calendarSystem: entry.calendar_system, calendarAlgorithmVersion: entry.calendar_algorithm_version,
    sourceReference: entry.source_reference,
    lines: Object.freeze(lines.map(line => Object.freeze({
      accountId: line.account_id, currency: line.currency as PostedJournalEntry["lines"][number]["currency"],
      debitMinor: BigInt(line.debit_minor), creditMinor: BigInt(line.credit_minor),
      ...(line.memo === null ? {} : { memo: line.memo })
    }))),
    status: "posted", postedAt: entry.posted_at, contentHash: entry.content_hash
  });
}

/** Production ledger repository backed by the asynchronous Capacitor SQLite adapter. */
export class CapacitorLedgerRepository implements LedgerRepository {
  constructor(private readonly db: AsyncSqliteDatabase) {}

  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async connection => {
      const tx: LedgerTransaction = {
        findPostedByIdempotencyKey: async (entityId, key) => {
          const found = await connection.query<EntryRow>(
            "SELECT id,entity_id,idempotency_key,effective_date,recorded_at,calendar_system,calendar_algorithm_version,source_reference,posted_at,content_hash FROM journal_entries WHERE entity_id=? AND idempotency_key=? AND status='posted'",
            [entityId, key]
          );
          return found[0] ? mapPosted(connection, found[0]) : null;
        },
        assertAccountsBelongToEntity: async (entityId, accountLines) => {
          for (const item of accountLines) {
            const found = await connection.query<{ id: string }>(
              "SELECT id FROM accounts WHERE id=? AND entity_id=? AND currency=? AND is_active=1",
              [item.accountId, entityId, item.currency]
            );
            if (!found.length) throw new Error("Account is missing, inactive, wrong entity, or wrong currency: " + item.accountId);
          }
        },
        enqueueOutboxCommand: async command => {
          const payload = JSON.stringify(command.payload);
          const existing = await connection.query<{ command_id: string; aggregate_id: string; aggregate_version: number; command_type: string; payload_json: string }>(
            "SELECT command_id,aggregate_id,aggregate_version,command_type,payload_json FROM sync_outbox WHERE idempotency_key=?",
            [command.idempotencyKey]
          );
          if (existing[0]) {
            const row = existing[0];
            if (row.command_id !== command.commandId || row.aggregate_id !== command.aggregateId || row.aggregate_version !== command.aggregateVersion || row.command_type !== command.commandType || row.payload_json !== payload) throw new Error("Outbox idempotency key reused with a different command payload.");
            return "duplicate" as const;
          }
          await connection.run("INSERT INTO sync_outbox(command_id,idempotency_key,aggregate_id,aggregate_version,command_type,payload_json,created_at,status,attempts) VALUES(?,?,?,?,?,?,?,'pending',0)", [command.commandId, command.idempotencyKey, command.aggregateId, command.aggregateVersion, command.commandType, payload, command.createdAt]);
          return "inserted" as const;
        },
        insertPostedEntry: async entry => {
          await connection.run(
            "INSERT INTO journal_entries(id,entity_id,idempotency_key,effective_date,recorded_at,calendar_system,calendar_algorithm_version,source_reference,status,posted_at,content_hash) VALUES(?,?,?,?,?,?,?,?, 'draft',NULL,NULL)",
            [entry.id, entry.entityId, entry.idempotencyKey, entry.effectiveDate, entry.recordedAt, entry.calendarSystem, entry.calendarAlgorithmVersion, entry.sourceReference]
          );
          for (const [index, line] of entry.lines.entries()) {
            await connection.run(
              "INSERT INTO journal_lines(id,journal_entry_id,entity_id,account_id,currency,debit_minor,credit_minor,memo) VALUES(?,?,?,?,?,?,?,?)",
              [entry.id + ":" + index, entry.id, entry.entityId, line.accountId, line.currency, line.debitMinor, line.creditMinor, line.memo ?? null]
            );
          }
          const result = await connection.run(
            "UPDATE journal_entries SET status='posted',posted_at=?,content_hash=? WHERE id=? AND status='draft'",
            [entry.postedAt, entry.contentHash, entry.id]
          );
          if (result.changes !== 1) throw new Error("Journal posting did not update exactly one draft.");
        }
      };
      return work(tx);
    });
  }
}
