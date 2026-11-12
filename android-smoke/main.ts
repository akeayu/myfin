import { Capacitor } from "@capacitor/core";
import { SQLiteConnection, CapacitorSQLite } from "@capacitor-community/sqlite";
import { CapacitorSqliteDatabase } from "../src/storage/capacitor.js";

const status = document.querySelector<HTMLPreElement>("#status");
function report(message: string): void {
  if (status) status.textContent = message;
  console.log(message);
}
function fail(message: string): never {
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
  throw new Error(message);
}

async function run(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") fail("Expected native Android platform.");
  const plugin = new SQLiteConnection(CapacitorSQLite);
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const encryptionSecretProvider = {
    getOrCreateSecret: async (): Promise<string> => secret
  };

  const dbName = "myfin_android_smoke";
  let db = await CapacitorSqliteDatabase.open({
    database: dbName,
    encrypted: true,
    mode: "secret",
    encryptionSecretProvider
  });
  await db.execute("CREATE TABLE IF NOT EXISTS smoke_records (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  await db.run("INSERT OR REPLACE INTO smoke_records(id,value) VALUES(?,?)", ["committed", "MYFIN_ANDROID_SMOKE_SENTINEL"]);

  try {
    await db.transaction(async tx => {
      await tx.run("INSERT INTO smoke_records(id,value) VALUES(?,?)", ["rolled_back", "must-not-persist"]);
      throw new Error("intentional rollback probe");
    });
    fail("Rollback probe unexpectedly committed.");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "intentional rollback probe") throw error;
  }

  const inside = await db.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records ORDER BY id");
  if (inside.length !== 1 || inside[0]?.id !== "committed") fail("Transaction rollback did not preserve only the committed row.");
  await db.close();

  db = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true });
  const reopened = await db.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
  if (reopened.length !== 1 || reopened[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Encrypted database did not survive close/reopen.");
  await db.close();

  const encrypted = (await plugin.isDatabaseEncrypted(dbName)).result;
  if (!encrypted) fail("Native plugin reports database is not encrypted.");
  report("MYFIN_ANDROID_SMOKE:PASS encrypted-create-query-rollback-close-reopen");
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
});
