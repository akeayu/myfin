import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite } from "@capacitor-community/sqlite";
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
  const sqlite = CapacitorSQLite as unknown as SqliteBackupPort & {
    isDatabaseEncrypted(options: { database: string }): Promise<{ result: boolean }>;
    isDatabase(options: { database: string }): Promise<{ result: boolean }>;
    deleteDatabase(options: { database: string }): Promise<void>;
  };
  const keyVault = new AndroidKeystoreSecretProvider();
  const backupService = new MyfinEncryptedBackupService(sqlite, keyVault);
  const dbName = "myfin_android_smoke";
  const backupPassphrase = "synthetic-backup-passphrase-2026";
  const stagedBackup = await keyVault.readSmokeBackupFile();

  // Second-install path: app data and Android Keystore namespace are new. Only
  // the encrypted backup file is carried across the uninstall/reinstall boundary.
  if (stagedBackup) {
    const restored = await backupService.restoreBackup(stagedBackup, backupPassphrase);
    if (restored.database !== dbName) fail("Fresh-install restore returned an unexpected database name.");
    const restoredDb = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true, encryptionSecretProvider: keyVault });
    const rows = await restoredDb.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
    if (rows.length !== 1 || rows[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Separate-install recovery did not restore the synthetic record.");
    await restoredDb.close();
    if (!(await sqlite.isDatabaseEncrypted({ database: dbName })).result) fail("Restored separate-install database is not SQLCipher encrypted.");
    report("MYFIN_ANDROID_SMOKE:RESTORE_PASS separate-install-keystore-recovery-encrypted-import");
    return;
  }

  // First-install path: create synthetic data, verify rollback, rotate key, and
  // create the portable encrypted backup for the second installation.
  const originalSecret = await keyVault.getOrCreateSecret();
  const recoveryPassphrase = "synthetic-recovery-passphrase-2026";
  const recoveryEnvelope = await keyVault.exportRecoveryEnvelope(recoveryPassphrase);
  let wrongPassphraseRejected = false;
  try {
    await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, "incorrect-recovery-passphrase");
  } catch { wrongPassphraseRejected = true; }
  if (!wrongPassphraseRejected) fail("Recovery envelope accepted an incorrect passphrase.");
  await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, recoveryPassphrase);
  if (await keyVault.getOrCreateSecret() !== originalSecret) fail("Recovery envelope did not preserve the original database key.");

  let db = await CapacitorSqliteDatabase.open({
    database: dbName, encrypted: true, mode: "secret", encryptionSecretProvider: keyVault
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

  await rotateMyfinDatabaseKey(keyVault.sqliteRotationPort(), keyVault, dbName);
  const rotatedSecret = await keyVault.getOrCreateSecret();
  if (rotatedSecret === originalSecret) fail("Keystore database key did not change during rotation.");
  if (await keyVault.verifyDatabaseKey(dbName, originalSecret)) fail("Old SQLCipher key still opens the database after rotation.");
  if (!(await keyVault.verifyDatabaseKey(dbName, rotatedSecret))) fail("New SQLCipher key does not open and integrity-check the database after rotation.");
  db = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true, encryptionSecretProvider: keyVault });
  const reopened = await db.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
  if (reopened.length !== 1 || reopened[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Encrypted database did not survive SQLCipher rekey and reopen.");

  const backupText = await backupService.exportBackup(dbName, backupPassphrase);
  if (!backupText.includes("MYFIN-ENCRYPTED-BACKUP") || backupText.includes("MYFIN_ANDROID_SMOKE_SENTINEL")) {
    fail("Backup envelope is missing or exposes the synthetic plaintext marker.");
  }
  await keyVault.writeSmokeBackupFile(backupText);
  await db.close();
  report("MYFIN_ANDROID_SMOKE:BACKUP_READY encrypted-export-key-rotation-rollback");
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
});
