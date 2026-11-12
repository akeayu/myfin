import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, SqliteLedgerRepository, type SqliteDatabase } from "../src/storage/sqlite.js";
import { postJournalEntry } from "../src/ledger/posting-service.js";
import type { JournalEntryInput } from "../src/ledger/ledger.js";
import { createOutboxCommand } from "../src/offline/outbox.js";
import { OutboxWorker, PermanentOutboxError, SqliteOutboxStore } from "../src/offline/sqlite-outbox.js";

describe("SQLite persistence and migrations", () => {
  let native: DatabaseSync;
  let db: SqliteDatabase;
  const migrationFiles = ["001_finance_and_outbox.sql", "002_outbox_leases.sql"];
  beforeEach(async () => {
    native = new DatabaseSync(":memory:");
    db = native as unknown as SqliteDatabase;
    const migrations = await Promise.all(migrationFiles.map(async id => ({ id, sql: await readFile(new URL("../migrations/" + id, import.meta.url), "utf8") })));
    expect(applyMigrations(db, migrations)).toHaveLength(2);
  });
  afterEach(() => native.close());

  it("applies migrations once and rejects modified historical migrations", async () => {
    const sql = await readFile(new URL("../migrations/001_finance_and_outbox.sql", import.meta.url), "utf8");
    expect(() => applyMigrations(db, [{ id: "001_finance_and_outbox.sql", sql: sql + "\n-- drift" }])).toThrow(/checksum mismatch/i);
  });

  it("posts atomically, returns same idempotent result, and enforces immutability", async () => {
    db.prepare("INSERT INTO entities(id,display_name,base_currency,created_at) VALUES('personal','Personal','ETB','2026-11-12T00:00:00Z')").run();
    db.prepare("INSERT INTO accounts(id,entity_id,code,name,account_type,currency,created_at) VALUES('cash','personal','1000','Cash','asset','ETB','2026-11-12T00:00:00Z'),('income','personal','4000','Income','income','ETB','2026-11-12T00:00:00Z')").run();
    const input: JournalEntryInput = { id:"j1", entityId:"personal", idempotencyKey:"post-1", effectiveDate:"2026-11-12", recordedAt:"2026-11-12T10:00:00Z", calendarSystem:"GREGORIAN", calendarAlgorithmVersion:"ec-gc-1", sourceReference:"synthetic-test", lines:[
      {accountId:"cash",currency:"ETB" as never,debitMinor:1200n,creditMinor:0n},
      {accountId:"income",currency:"ETB" as never,debitMinor:0n,creditMinor:1200n}
    ]};
    const repo = new SqliteLedgerRepository(db);
    const first = await postJournalEntry(input, repo);
    const duplicate = await postJournalEntry(input, repo);
    expect(first.status).toBe("posted");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.entry.contentHash).toBe(first.entry.contentHash);
    expect(() => db.prepare("UPDATE journal_entries SET source_reference='tampered' WHERE id='j1'").run()).toThrow(/immutable/i);
    expect(() => db.prepare("DELETE FROM journal_lines WHERE journal_entry_id='j1'").run()).toThrow(/posted journal lines cannot be deleted/i);
  });

  it("rolls back a failed posting without leaving a partial journal", async () => {
    db.prepare("INSERT INTO entities(id,display_name,base_currency,created_at) VALUES('personal','Personal','ETB','2026-11-12T00:00:00Z')").run();
    db.prepare("INSERT INTO accounts(id,entity_id,code,name,account_type,currency,created_at) VALUES('cash','personal','1000','Cash','asset','ETB','2026-11-12T00:00:00Z')").run();
    const bad: JournalEntryInput = { id:"bad", entityId:"personal", idempotencyKey:"bad-1", effectiveDate:"2026-11-12", recordedAt:"2026-11-12T10:00:00Z", calendarSystem:"GREGORIAN", calendarAlgorithmVersion:"ec-gc-1", sourceReference:"synthetic-test", lines:[
      {accountId:"cash",currency:"ETB" as never,debitMinor:100n,creditMinor:0n},
      {accountId:"missing",currency:"ETB" as never,debitMinor:0n,creditMinor:100n}
    ]};
    await expect(postJournalEntry(bad, new SqliteLedgerRepository(db))).rejects.toThrow(/account is missing/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_entries").get()).toMatchObject({count:0});
  });
});

describe("durable SQLite outbox", () => {
  let native: DatabaseSync;
  let store: SqliteOutboxStore;
  beforeEach(async () => {
    native = new DatabaseSync(":memory:");
    const db = native as unknown as SqliteDatabase;
    const migrations = await Promise.all(["001_finance_and_outbox.sql","002_outbox_leases.sql"].map(async id => ({id,sql:await readFile(new URL("../migrations/"+id,import.meta.url),"utf8")})));
    applyMigrations(db,migrations);
    store = new SqliteOutboxStore(db, 5_000);
  });
  afterEach(() => native.close());

  const command = () => createOutboxCommand({commandId:"cmd-1",idempotencyKey:"idem-1",aggregateId:"journal-1",aggregateVersion:1,commandType:"journal.post",payload:{entryId:"journal-1",amountMinor:"1200"},createdAt:"2026-11-12T10:00:00Z"});

  it("deduplicates enqueue and rejects idempotency-key payload reuse", async () => {
    expect(await store.insertIfAbsent(command())).toBe("inserted");
    expect(await store.insertIfAbsent(command())).toBe("duplicate");
    const changed = createOutboxCommand({ ...command(), payload:{entryId:"journal-1",amountMinor:"9999"} });
    await expect(store.insertIfAbsent(changed)).rejects.toThrow(/different command payload/i);
  });

  it("supports outbox enqueue inside the caller's ledger transaction", async () => {
    const commandValue = command();
    native.exec("BEGIN IMMEDIATE");
    expect(store.enqueueInCurrentTransaction(commandValue)).toBe("inserted");
    native.exec("ROLLBACK");
    expect(await store.getStatus("cmd-1")).toBeNull();
    native.exec("BEGIN IMMEDIATE");
    expect(store.enqueueInCurrentTransaction(commandValue)).toBe("inserted");
    native.exec("COMMIT");
    expect(await store.getStatus("cmd-1")).toMatchObject({status:"pending",attempts:0});
  });

  it("claims atomically, acknowledges receipts, and stops redelivery", async () => {
    await store.insertIfAbsent(command());
    const claimed = await store.claimNext(new Date("2026-11-12T10:00:00Z"));
    expect(claimed?.attempts).toBe(1);
    await store.acknowledge("cmd-1","server-receipt-1");
    expect(await store.claimNext(new Date("2026-11-12T10:01:00Z"))).toBeNull();
    expect(await store.getStatus("cmd-1")).toMatchObject({status:"acknowledged",attempts:1});
  });

  it("recovers an expired in-flight lease after a process interruption", async () => {
    await store.insertIfAbsent(command());
    expect(await store.claimNext(new Date("2026-11-12T10:00:00Z"))).not.toBeNull();
    const recovered = await store.claimNext(new Date("2026-11-12T10:00:06Z"));
    expect(recovered?.attempts).toBe(2);
  });

  it("retries transient transport failures with backoff", async () => {
    await store.insertIfAbsent(command());
    const worker = new OutboxWorker(store,{send:async()=>{throw new Error("network down");}},()=>new Date("2026-11-12T10:00:00Z"));
    expect(await worker.processNext()).toMatchObject({status:"retry_scheduled",commandId:"cmd-1"});
    expect(await store.getStatus("cmd-1")).toMatchObject({status:"pending",attempts:1});
  });

  it("rejects permanent transport failures without retrying", async () => {
    await store.insertIfAbsent(command());
    const worker = new OutboxWorker(store,{send:async()=>{throw new PermanentOutboxError("POLICY_REJECTED");}},()=>new Date("2026-11-12T10:00:00Z"));
    expect(await worker.processNext()).toMatchObject({status:"rejected",commandId:"cmd-1"});
    expect(await store.getStatus("cmd-1")).toMatchObject({status:"rejected",attempts:1});
  });
});
