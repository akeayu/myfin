import type { OutboxCommand, OutboxWorkerStore } from "./outbox.js";
import type { AsyncSqliteDatabase } from "../storage/capacitor.js";

export interface AsyncLeasedOutboxCommand<T = unknown> extends OutboxCommand<T> { readonly leaseExpiresAt: string; }
interface OutboxRow {
  command_id: string; idempotency_key: string; aggregate_id: string; aggregate_version: number;
  command_type: string; payload_json: string; created_at: string; status: OutboxCommand["status"];
  attempts: number; lease_expires_at: string | null;
}
function commandFromRow<T>(row: OutboxRow): OutboxCommand<T> {
  return Object.freeze({
    commandId: row.command_id, idempotencyKey: row.idempotency_key, aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version, commandType: row.command_type,
    payload: JSON.parse(row.payload_json) as T, createdAt: row.created_at, status: row.status, attempts: row.attempts
  });
}

/** Async, plugin-backed durable outbox with atomic leasing and at-least-once delivery. */
export class CapacitorOutboxStore implements OutboxWorkerStore {
  constructor(private readonly db: AsyncSqliteDatabase, private readonly leaseMilliseconds = 60_000) {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000) throw new Error("Outbox lease must be at least one second.");
  }

  async insertIfAbsent<T>(command: OutboxCommand<T>): Promise<"inserted" | "duplicate"> {
    return this.db.transaction(async tx => this.enqueueInCurrentTransaction(tx, command));
  }

  /** Must be called with the exact transaction connection that owns the ledger post. */
  async enqueueInCurrentTransaction<T>(tx: AsyncSqliteDatabase, command: OutboxCommand<T>): Promise<"inserted" | "duplicate"> {
    const payload = JSON.stringify(command.payload);
    const existing = await tx.query<Pick<OutboxRow, "command_id" | "aggregate_id" | "aggregate_version" | "command_type" | "payload_json">>(
      "SELECT command_id,aggregate_id,aggregate_version,command_type,payload_json FROM sync_outbox WHERE idempotency_key=?",
      [command.idempotencyKey]
    );
    if (existing[0]) {
      const row = existing[0];
      if (row.command_id !== command.commandId || row.aggregate_id !== command.aggregateId ||
          row.aggregate_version !== command.aggregateVersion || row.command_type !== command.commandType || row.payload_json !== payload) {
        throw new Error("Outbox idempotency key reused with a different command payload.");
      }
      return "duplicate";
    }
    await tx.run(
      "INSERT INTO sync_outbox(command_id,idempotency_key,aggregate_id,aggregate_version,command_type,payload_json,created_at,status,attempts) VALUES(?,?,?,?,?,?,?,'pending',0)",
      [command.commandId, command.idempotencyKey, command.aggregateId, command.aggregateVersion, command.commandType, payload, command.createdAt]
    );
    return "inserted";
  }

  async claimNext(now = new Date()): Promise<AsyncLeasedOutboxCommand | null> {
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMilliseconds).toISOString();
    return this.db.transaction(async tx => {
      const rows = await tx.query<OutboxRow>(
        "SELECT command_id,idempotency_key,aggregate_id,aggregate_version,command_type,payload_json,created_at,status,attempts,lease_expires_at FROM sync_outbox WHERE (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='in_flight' AND lease_expires_at<=?) ORDER BY created_at,command_id LIMIT 1",
        [nowIso, nowIso]
      );
      const candidate = rows[0];
      if (!candidate) return null;
      await tx.run("UPDATE sync_outbox SET status='in_flight',attempts=attempts+1,lease_expires_at=?,last_error_code=NULL WHERE command_id=?", [leaseExpiresAt, candidate.command_id]);
      return Object.freeze({ ...commandFromRow({ ...candidate, status: "in_flight", attempts: candidate.attempts + 1 }), leaseExpiresAt });
    });
  }

  async acknowledge(commandId: string, receipt: string): Promise<void> {
    if (!receipt.trim()) throw new Error("Server receipt is required.");
    const result = await this.db.run("UPDATE sync_outbox SET status='acknowledged',server_receipt=?,lease_expires_at=NULL,next_attempt_at=NULL WHERE command_id=? AND status='in_flight'", [receipt, commandId]);
    if (result.changes !== 1) throw new Error("Outbox acknowledgement requires an in-flight command.");
  }

  async reject(commandId: string, reasonCode: string): Promise<void> {
    if (!reasonCode.trim()) throw new Error("Rejection code is required.");
    const result = await this.db.run("UPDATE sync_outbox SET status='rejected',rejection_code=?,lease_expires_at=NULL WHERE command_id=? AND status='in_flight'", [reasonCode, commandId]);
    if (result.changes !== 1) throw new Error("Outbox rejection requires an in-flight command.");
  }

  async retry(commandId: string, nextAttemptAt: string): Promise<void> {
    if (Number.isNaN(Date.parse(nextAttemptAt))) throw new Error("Retry timestamp is invalid.");
    const result = await this.db.run("UPDATE sync_outbox SET status='pending',next_attempt_at=?,lease_expires_at=NULL,last_error_code='TRANSIENT_FAILURE' WHERE command_id=? AND status='in_flight'", [nextAttemptAt, commandId]);
    if (result.changes !== 1) throw new Error("Outbox retry requires an in-flight command.");
  }

  async getStatus(commandId: string): Promise<{ status: OutboxCommand["status"]; attempts: number } | null> {
    const rows = await this.db.query<{ status: OutboxCommand["status"]; attempts: number }>(
      "SELECT status,attempts FROM sync_outbox WHERE command_id=?", [commandId]
    );
    return rows[0] ?? null;
  }
}
