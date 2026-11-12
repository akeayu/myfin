import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite } from "@capacitor-community/sqlite";
import { CapacitorSqliteDatabase } from "../src/storage/capacitor.js";
import { AndroidKeystoreSecretProvider } from "../src/security/android-keystore.js";
import { MyfinEncryptedBackupService, type SqliteBackupPort } from "../src/security/encrypted-backup.js";

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
    if (!(await sqlite.isDatabaseEncrypted({ database: dbName })).result) fail("Restored separate-install database is not SQLCipher encrypted.");

    // Keep the restored SQLCipher database open with a live WAL and a file-backed
    // TEMP database so the host can inspect all app-private files for plaintext.
    await restoredDb.execute("PRAGMA journal_mode=WAL");
    await restoredDb.execute("PRAGMA wal_autocheckpoint=0");
    const journalMode = await restoredDb.query<{ journal_mode: string }>("PRAGMA journal_mode");
    if (journalMode[0]?.journal_mode?.toLowerCase() !== "wal") fail("SQLite did not enter WAL mode for sidecar verification.");
    await restoredDb.execute("CREATE TABLE IF NOT EXISTS sidecar_wal_probe(value TEXT NOT NULL)");
    await restoredDb.run("INSERT INTO sidecar_wal_probe(value) VALUES(?)", ["MYFIN_WAL_SENTINEL"]);
    await restoredDb.execute("PRAGMA temp_store=FILE");
    const tempStore = await restoredDb.query<{ temp_store: number }>("PRAGMA temp_store");
    if (Number(tempStore[0]?.temp_store) !== 1) fail("SQLite did not enable file-backed temporary storage.");
    await restoredDb.execute("CREATE TEMP TABLE sidecar_temp_probe(value TEXT NOT NULL)");
    for (let i = 0; i < 256; i++) {
      await restoredDb.run("INSERT INTO sidecar_temp_probe(value) VALUES(?)", ["MYFIN_TEMP_SENTINEL_" + i + "_" + "x".repeat(4096)]);
    }

    const journalDbName = "myfin_journal_smoke";
    const journalDb = await CapacitorSqliteDatabase.open({ database: journalDbName, encrypted: true, mode: "secret", encryptionSecretProvider: keyVault });
    await journalDb.execute("PRAGMA journal_mode=DELETE");
    await journalDb.execute("CREATE TABLE IF NOT EXISTS sidecar_journal_probe(value TEXT NOT NULL)");
    const journalHold = journalDb.transaction(async tx => {
      await tx.run("INSERT INTO sidecar_journal_probe(value) VALUES(?)", ["MYFIN_JOURNAL_SENTINEL"]);
      report("MYFIN_ANDROID_SMOKE:JOURNAL_READY");
      await new Promise(resolve => setTimeout(resolve, 20000));
    });
    report("MYFIN_ANDROID_SMOKE:SIDECAR_READY wal-temp-rollback-journal-open");
    await journalHold;
    await journalDb.close();
    await restoredDb.close();
    report("MYFIN_ANDROID_SMOKE:SIDECAR_PASS encrypted-wal-shm-journal-temp-private-files");
    report("MYFIN_ANDROID_SMOKE:RESTORE_PASS separate-install-keystore-recovery-encrypted-import");
    return;
  }


  const pending = await keyVault.getPendingDatabaseKeyRotation(dbName);
  if (pending.pending) {
    if (!pending.oldSecret || !pending.newSecret) fail("Pending rotation record is incomplete.");
    const recoveredDb = await CapacitorSqliteDatabase.open({ database: dbName, encrypted: true, encryptionSecretProvider: keyVault });
    const recoveredRows = await recoveredDb.query<{ id: string; value: string }>("SELECT id,value FROM smoke_records");
    if (recoveredRows.length !== 1 || recoveredRows[0]?.value !== "MYFIN_ANDROID_SMOKE_SENTINEL") fail("Database did not survive interrupted key rotation.");
    if (await keyVault.verifyDatabaseKey(dbName, pending.oldSecret)) fail("Old SQLCipher key still opens after recovery.");
    if (!(await keyVault.verifyDatabaseKey(dbName, pending.newSecret))) fail("Recovered SQLCipher key failed integrity verification.");
    if ((await keyVault.getPendingDatabaseKeyRotation(dbName)).pending) fail("Startup did not reconcile the pending rotation.");
    const recoveredBackup = await backupService.exportBackup(dbName, backupPassphrase);
    if (!recoveredBackup.includes("MYFIN-ENCRYPTED-BACKUP") || recoveredBackup.includes("MYFIN_ANDROID_SMOKE_SENTINEL")) fail("Encrypted backup is missing or exposes plaintext.");
    await keyVault.writeSmokeBackupFile(recoveredBackup);
    await recoveredDb.close();
    report("MYFIN_ANDROID_SMOKE:BACKUP_READY rotation-reconciled-encrypted-export");
    return;
  }

  // First-install path: create synthetic data, verify rollback, rotate key, and
  // create the portable encrypted backup for the second installation.
  const originalSecret = await keyVault.getOrCreateSecret(dbName);
  const recoveryPassphrase = "synthetic-recovery-passphrase-2026";
  const recoveryEnvelope = await keyVault.exportRecoveryEnvelope(recoveryPassphrase, dbName);
  let wrongPassphraseRejected = false;
  try {
    await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, "incorrect-recovery-passphrase", dbName);
  } catch { wrongPassphraseRejected = true; }
  if (!wrongPassphraseRejected) fail("Recovery envelope accepted an incorrect passphrase.");
  await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, recoveryPassphrase, dbName);
  if (await keyVault.getOrCreateSecret(dbName) !== originalSecret) fail("Recovery envelope did not preserve the original database key.");

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

  const stagedRotation = await keyVault.prepareDatabaseKeyRotation(dbName);
  await sqlite.changeEncryptionSecret({ passphrase: stagedRotation.newSecret, oldpassphrase: stagedRotation.oldSecret });
  report("MYFIN_ANDROID_SMOKE:ROTATION_PENDING restart-required-before-keystore-promotion");
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
});
