import { describe, it, expect, vi } from "vitest";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CapacitorSqliteDatabase, applyAsyncMigrations } from "../src/storage/capacitor.js";

function fakeConnection() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let active = false;
  let migrationChecksum: string | null = null;
  const connection = {
    execute: vi.fn(async (...args: unknown[]) => { calls.push({ method: "execute", args }); return { changes: { changes: 0 } }; }),
    run: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "run", args });
      if (String(args[0]).startsWith("INSERT INTO schema_migrations")) migrationChecksum = String((args[1] as unknown[])[1]);
      return { changes: { changes: 1, lastId: 9 } };
    }),
    query: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "query", args });
      const sql = String(args[0]);
      if (sql.startsWith("SELECT checksum FROM schema_migrations")) return { values: migrationChecksum ? [{ checksum: migrationChecksum }] : [] };
      if (sql.startsWith("SELECT id, checksum FROM schema_migrations")) return { values: migrationChecksum ? [{ id: "001_base.sql", checksum: migrationChecksum }] : [] };
      return { values: [{ id: "x" }] };
    }),
    beginTransaction: vi.fn(async () => { active = true; calls.push({ method: "begin", args: [] }); return { changes: { changes: 0 } }; }),
    commitTransaction: vi.fn(async () => { active = false; calls.push({ method: "commit", args: [] }); return { changes: { changes: 0 } }; }),
    rollbackTransaction: vi.fn(async () => { active = false; calls.push({ method: "rollback", args: [] }); return { changes: { changes: 0 } }; }),
    close: vi.fn(async () => { calls.push({ method: "close", args: [] }); }),
    isTransactionActive: vi.fn(async () => ({ result: active }))
  };
  return { connection: connection as unknown as SQLiteDBConnection, calls, native: connection };
}

describe("Capacitor SQLite async adapter contract", () => {
  it("uses asynchronous plugin run/query APIs and safely serializes bigint bind values", async () => {
    const fake = fakeConnection();
    const db = CapacitorSqliteDatabase.fromConnection(fake.connection);
    await expect(db.run("INSERT INTO amounts(value) VALUES(?)", [1234567890123456789n])).resolves.toMatchObject({ changes: 1, lastId: 9 });
    expect(fake.native.run).toHaveBeenCalledWith("INSERT INTO amounts(value) VALUES(?)", ["1234567890123456789"], false, "no");
    await expect(db.query("SELECT id FROM sample")).resolves.toEqual([{ id: "x" }]);
  });

  it("commits successful transactions and rolls back failed transactions", async () => {
    const fake = fakeConnection();
    const db = CapacitorSqliteDatabase.fromConnection(fake.connection);
    await db.transaction(async tx => { await tx.run("UPDATE sample SET value=?", ["ok"]); });
    expect(fake.native.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fake.native.commitTransaction).toHaveBeenCalledTimes(1);
    await expect(db.transaction(async () => { throw new Error("abort"); })).rejects.toThrow("abort");
    expect(fake.native.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects nested transactions and use after close", async () => {
    const fake = fakeConnection();
    const db = CapacitorSqliteDatabase.fromConnection(fake.connection);
    await expect(db.transaction(async tx => tx.transaction(async () => undefined))).rejects.toThrow(/nested/i);
    await db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow(/closed/i);
  });

  it("applies migrations asynchronously and detects immutable migration drift", async () => {
    const fake = fakeConnection();
    const db = CapacitorSqliteDatabase.fromConnection(fake.connection);
    const migrations = [{ id: "001_base.sql", sql: "CREATE TABLE sample(id TEXT PRIMARY KEY);" }];
    await expect(applyAsyncMigrations(db, migrations)).resolves.toHaveLength(1);
    expect(fake.native.beginTransaction).toHaveBeenCalledTimes(1);
    expect(fake.native.commitTransaction).toHaveBeenCalledTimes(1);
    await expect(applyAsyncMigrations(db, [{ id: "001_base.sql", sql: "CREATE TABLE changed(id TEXT);" }])).rejects.toThrow(/checksum mismatch/i);
  });
});
