import { Capacitor } from "@capacitor/core";
import { SQLiteConnection, CapacitorSQLite } from "@capacitor-community/sqlite";
import { CapacitorSqliteDatabase } from "../src/storage/capacitor.js";
import { AndroidKeystoreSecretProvider } from "../src/security/android-keystore.js";
import { MyfinEncryptedBackupService, type SqliteBackupPort } from "../src/security/encrypted-backup.js";
import { rotateMyfinDatabaseKey } from "../src/security/key-rotation.js";

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
  const encryptionSecretProvider = new AndroidKeystoreSecretProvider();
  const originalSecret = await encryptionSecretProvider.getOrCreateSecret();
  const recoveryPassphrase = "synthetic-recovery-passphrase-2026";
  const recoveryEnvelope = await encryptionSecretProvider.exportRecoveryEnvelope(recoveryPassphrase);
  let wrongPassphraseRejected = false;
  try {
    await encryptionSecretProvider.restoreRecoveryEnvelope(recoveryEnvelope, "incorrect-recovery-passphrase");
  } catch {
    wrongPassphraseRejected = true;
  }
  if (!wrongPassphraseRejected) fail("Recovery envelope accepted an incorrect passphrase.");
  await encryptionSecretProvider.restoreRecoveryEnvelope(recoveryEnvelope, recoveryPassphrase);
  const restoredSecret = await encryptionSecretProvider.getOrCreateSecret();
  if (restoredSecret !== originalSecret) fail("Recovery envelope did not restore the same database key.");

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

  await rotateMyfinDatabaseKey(plugin as unknown as Parameters<typeof rotateMyfinDatabaseKey>[0], encryptionSecretProvider);
  const backupService = new MyfinEncryptedBackupService(
    CapacitorSQLite as unknown as SqliteBackupPort,
    encryptionSecretProvider
  );

  db = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true });
  const reopened = await db.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
  if (reopened.length !== 1 || reopened[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Encrypted database did not survive rekey and reopen.");

  const backupPassphrase = "synthetic-backup-passphrase-2026";
  const backupText = await backupService.exportBackup(dbName, backupPassphrase);
  if (!backupText.includes("MYFIN-ENCRYPTED-BACKUP")) fail("Encrypted backup envelope was not produced.");
  await db.close();
  await plugin.deleteDatabase({ database: dbName });
  if ((await plugin.isDatabase({ database: dbName })).result) fail("Synthetic database deletion before restore failed.");
  const restored = await backupService.restoreBackup(backupText, backupPassphrase);
  if (restored.database !== dbName) fail("Encrypted backup restored under an unexpected database name.");

  db = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true });
  const afterRestore = await db.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
  if (afterRestore.length !== 1 || afterRestore[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Encrypted backup restore did not preserve the synthetic record.");
  await db.close();

  const encrypted = (await plugin.isDatabaseEncrypted(dbName)).result;
  if (!encrypted) fail("Native plugin reports database is not encrypted.");
  report("MYFIN_ANDROID_SMOKE:PASS encrypted-create-query-rollback-close-reopen");
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
});
