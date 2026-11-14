import type { OutboxCommand, OutboxStore, OutboxWorkerStore } from "./outbox.js";
import type { SqliteDatabase } from "../storage/sqlite.js";

export interface LeasedOutboxCommand<T = unknown> extends OutboxCommand<T> { readonly leaseExpiresAt: string; }
interface StoredRow {
  command_id: string; idempotency_key: string; aggregate_id: string; aggregate_version: number;
  command_type: string; payload_json: string; created_at: string; status: OutboxCommand["status"];
  attempts: number; lease_expires_at: string | null;
}
function asCommand<T>(r: StoredRow): OutboxCommand<T> {
  return Object.freeze({ commandId: r.command_id, idempotencyKey: r.idempotency_key, aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version, commandType: r.command_type, payload: JSON.parse(r.payload_json) as T,
    createdAt: r.created_at, status: r.status, attempts: r.attempts });
}
function begin(db: SqliteDatabase): void { db.exec("BEGIN IMMEDIATE"); }
function rollback(db: SqliteDatabase): void { try { db.exec("ROLLBACK"); } catch { /* preserve original error */ } }

/** Durable SQLite outbox with atomic leasing and at-least-once delivery semantics. */
export class SqliteOutboxStore implements OutboxStore {
  constructor(private readonly db: SqliteDatabase, private readonly leaseMilliseconds = 60_000) {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000) throw new Error("Outbox lease must be at least one second.");
  }
  /** Enqueues inside a caller-owned SQLite transaction, e.g. the same transaction as a ledger posting. */
  enqueueInCurrentTransaction<T>(command: OutboxCommand<T>): "inserted" | "duplicate" {
    const payload = JSON.stringify(command.payload);
    const existing = this.db.prepare("SELECT command_id, aggregate_id, aggregate_version, command_type, payload_json FROM sync_outbox WHERE idempotency_key = ?").get(command.idempotencyKey) as {command_id:string;aggregate_id:string;aggregate_version:number;command_type:string;payload_json:string}|undefined;
    if (existing) {
      if (existing.command_id !== command.commandId || existing.aggregate_id !== command.aggregateId ||
          existing.aggregate_version !== command.aggregateVersion || existing.command_type !== command.commandType || existing.payload_json !== payload) {
        throw new Error("Outbox idempotency key reused with a different command payload.");
      }
      return "duplicate";
    }
    this.db.prepare("INSERT INTO sync_outbox(command_id,idempotency_key,aggregate_id,aggregate_version,command_type,payload_json,created_at,status,attempts) VALUES(?,?,?,?,?,?,?,'pending',0)")
      .run(command.commandId, command.idempotencyKey, command.aggregateId, command.aggregateVersion, command.commandType, payload, command.createdAt);
    return "inserted";
  }
  async insertIfAbsent<T>(command: OutboxCommand<T>): Promise<"inserted" | "duplicate"> {
    begin(this.db);
    try {
      const result = this.enqueueInCurrentTransaction(command);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { rollback(this.db); throw error; }
  }
  async claimNext(now = new Date()): Promise<LeasedOutboxCommand | null> {
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMilliseconds).toISOString();
    begin(this.db);
    try {
      const candidate = this.db.prepare("SELECT command_id,idempotency_key,aggregate_id,aggregate_version,command_type,payload_json,created_at,status,attempts,lease_expires_at FROM sync_outbox WHERE (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status='in_flight' AND lease_expires_at <= ?) ORDER BY created_at, command_id LIMIT 1").get(nowIso, nowIso) as StoredRow | undefined;
      if (!candidate) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE sync_outbox SET status='in_flight', attempts=attempts+1, lease_expires_at=?, last_error_code=NULL WHERE command_id=?").run(leaseExpiresAt, candidate.command_id);
      this.db.exec("COMMIT");
      return Object.freeze({ ...asCommand({ ...candidate, status: "in_flight", attempts: candidate.attempts + 1 }), leaseExpiresAt });
    } catch (error) { rollback(this.db); throw error; }
  }
  async acknowledge(commandId: string, receipt: string): Promise<void> {
    if (!receipt.trim()) throw new Error("Server receipt is required.");
    const result = this.db.prepare("UPDATE sync_outbox SET status='acknowledged', server_receipt=?, lease_expires_at=NULL, next_attempt_at=NULL WHERE command_id=? AND status='in_flight'").run(receipt, commandId);
    if (Number(result.changes) !== 1) throw new Error("Outbox acknowledgement requires an in-flight command.");
  }
  async reject(commandId: string, reasonCode: string): Promise<void> {
    if (!reasonCode.trim()) throw new Error("Rejection code is required.");
    const result = this.db.prepare("UPDATE sync_outbox SET status='rejected', rejection_code=?, lease_expires_at=NULL WHERE command_id=? AND status='in_flight'").run(reasonCode, commandId);
    if (Number(result.changes) !== 1) throw new Error("Outbox rejection requires an in-flight command.");
  }
  async retry(commandId: string, nextAttemptAt: string): Promise<void> {
    if (Number.isNaN(Date.parse(nextAttemptAt))) throw new Error("Retry timestamp is invalid.");
    const result = this.db.prepare("UPDATE sync_outbox SET status='pending', next_attempt_at=?, lease_expires_at=NULL, last_error_code='TRANSIENT_FAILURE' WHERE command_id=? AND status='in_flight'").run(nextAttemptAt, commandId);
    if (Number(result.changes) !== 1) throw new Error("Outbox retry requires an in-flight command.");
  }
  async getStatus(commandId: string): Promise<{status: OutboxCommand["status"]; attempts: number} | null> {
    const result = this.db.prepare("SELECT status, attempts FROM sync_outbox WHERE command_id=?").get(commandId) as {status:OutboxCommand["status"];attempts:number}|undefined;
    return result ?? null;
  }
}

export class PermanentOutboxError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "PermanentOutboxError"; }
}
export interface OutboxTransport {
  send(command: OutboxCommand): Promise<{ readonly receipt: string }>;
}
export interface OutboxWorkerResult { readonly status: "idle" | "acknowledged" | "rejected" | "retry_scheduled"; readonly commandId?: string; }

/** One-command worker. Server must deduplicate by idempotencyKey; local delivery is at-least-once. */
export class OutboxWorker {
  constructor(private readonly store: OutboxWorkerStore, private readonly transport: OutboxTransport,
    private readonly now: () => Date = () => new Date(), private readonly maxBackoffMs = 60 * 60 * 1000) {}
  async processNext(): Promise<OutboxWorkerResult> {
    const claimed = await this.store.claimNext(this.now());
    if (!claimed) return { status: "idle" };
    try {
      const result = await this.transport.send(claimed);
      await this.store.acknowledge(claimed.commandId, result.receipt);
      return { status: "acknowledged", commandId: claimed.commandId };
    } catch (error) {
      if (error instanceof PermanentOutboxError) {
        await this.store.reject(claimed.commandId, error.code);
        return { status: "rejected", commandId: claimed.commandId };
      }
      const delay = Math.min(this.maxBackoffMs, 1_000 * (2 ** Math.min(claimed.attempts - 1, 16)));
      await this.store.retry(claimed.commandId, new Date(this.now().getTime() + delay).toISOString());
      return { status: "retry_scheduled", commandId: claimed.commandId };
    }
  }
}
