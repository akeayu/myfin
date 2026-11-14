import type { SqliteBackupPort } from "../src/security/encrypted-backup.js";

type SmokeMarker = { emit(options: { message: string }): Promise<void> };
let smokeMarker: SmokeMarker | undefined;
console.log("MYFIN_ANDROID_SMOKE_JS_BOOTSTRAP_EXECUTED");
const status = document.querySelector<HTMLPreElement>("#status");
function report(message: string): void {
  if (status) status.textContent = message;
  console.log(message);
  if (smokeMarker) {
    void smokeMarker.emit({ message }).catch(error => {
      console.error("MYFIN native smoke marker bridge unavailable", error);
    });
  }
}
window.addEventListener("error", event => report("MYFIN_ANDROID_SMOKE:JS_WINDOW_ERROR " + (event.message || "unknown") + " " + (event.filename || "") + ":" + event.lineno));
window.addEventListener("unhandledrejection", event => report("MYFIN_ANDROID_SMOKE:JS_UNHANDLED_REJECTION " + String(event.reason)));
function checkpoint(name: string): void { report("MYFIN_ANDROID_SMOKE:CHECKPOINT " + name); }
function fail(message: string): never {
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
  throw new Error(message);
}

async function run(): Promise<void> {
  const { Capacitor, registerPlugin } = await import("@capacitor/core");
  smokeMarker = registerPlugin<SmokeMarker>("MyfinSmokeMarker");
  report("MYFIN_ANDROID_SMOKE:JS_ENTRY_EXECUTED");
  const { CapacitorSQLite } = await import("@capacitor-community/sqlite");
  const { CapacitorSqliteDatabase } = await import("../src/storage/capacitor.js");
  const { AndroidKeystoreSecretProvider } = await import("../src/security/android-keystore.js");
  const { MyfinEncryptedBackupService } = await import("../src/security/encrypted-backup.js");
  checkpoint("RUN_ENTERED");
  if (Capacitor.getPlatform() !== "android") fail("Expected native Android platform.");
  checkpoint("WEBVIEW_CAPACITOR_READY");
  await smokeMarker.emit({ message: "NATIVE_PLUGIN_BRIDGE_READY" });
  const sqlite = CapacitorSQLite as unknown as SqliteBackupPort & {
    isDatabaseEncrypted(options: { database: string }): Promise<{ result: boolean }>;
    isDatabase(options: { database: string }): Promise<{ result: boolean }>;
    deleteDatabase(options: { database: string }): Promise<void>;
  };
  checkpoint("KEYVAULT_PROVIDER_CONSTRUCT_BEGIN");
  const keyVault = new AndroidKeystoreSecretProvider();
  checkpoint("KEYVAULT_PROVIDER_CONSTRUCTED");
  const backupService = new MyfinEncryptedBackupService(sqlite, keyVault);
  const dbName = "myfin_android_smoke";
  const backupPassphrase = "synthetic-backup-passphrase-2026";
  checkpoint("BACKUP_FILE_READ_BEGIN");
  const stagedBackup = await keyVault.readSmokeBackupFile();
  checkpoint("BACKUP_FILE_READ_COMPLETE");

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
    let signalJournalReady: (() => void) | undefined;
    const journalReady = new Promise<void>(resolve => { signalJournalReady = resolve; });
    const journalHold = journalDb.transaction(async tx => {
      await tx.run("INSERT INTO sidecar_journal_probe(value) VALUES(?)", ["MYFIN_JOURNAL_SENTINEL"]);
      report("MYFIN_ANDROID_SMOKE:JOURNAL_READY");
      signalJournalReady?.();
      await new Promise(resolve => setTimeout(resolve, 25000));
    });
    await journalReady;
    report("MYFIN_ANDROID_SMOKE:SIDECAR_READY wal-temp-rollback-journal-open");
    await journalHold;
    await journalDb.close();
    await restoredDb.close();
    report("MYFIN_ANDROID_SMOKE:SIDECAR_PASS encrypted-wal-shm-journal-temp-private-files");
    report("MYFIN_ANDROID_SMOKE:RESTORE_PASS separate-install-keystore-recovery-encrypted-import");
    return;
  }


  checkpoint("PENDING_ROTATION_READ_BEGIN");
  const pending = await keyVault.getPendingDatabaseKeyRotation(dbName);
  checkpoint("PENDING_ROTATION_READ_COMPLETE");
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
  checkpoint("KEYSTORE_GET_OR_CREATE_BEGIN");
  const originalSecret = await keyVault.getOrCreateSecret(dbName);
  checkpoint("KEYSTORE_GET_OR_CREATE_COMPLETE");
  const recoveryPassphrase = "synthetic-recovery-passphrase-2026";
  checkpoint("RECOVERY_EXPORT_BEGIN");
  const recoveryEnvelope = await keyVault.exportRecoveryEnvelope(recoveryPassphrase, dbName);
  checkpoint("RECOVERY_EXPORT_COMPLETE");
  let wrongPassphraseRejected = false;
  try {
    await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, "incorrect-recovery-passphrase", dbName);
  } catch { wrongPassphraseRejected = true; }
  if (!wrongPassphraseRejected) fail("Recovery envelope accepted an incorrect passphrase.");
  checkpoint("RECOVERY_RESTORE_BEGIN");
  await keyVault.restoreRecoveryEnvelope(recoveryEnvelope, recoveryPassphrase, dbName);
  checkpoint("RECOVERY_RESTORE_COMPLETE");
  if (await keyVault.getOrCreateSecret(dbName) !== originalSecret) fail("Recovery envelope did not preserve the original database key.");

  checkpoint("SQLITE_OPEN_BEGIN");
  let db = await CapacitorSqliteDatabase.open({
    database: dbName, encrypted: true, mode: "secret", encryptionSecretProvider: keyVault
  });
  checkpoint("SQLITE_OPEN_COMPLETE");
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
  checkpoint("SQLITE_TRANSACTION_ROLLBACK_VERIFIED");
  await db.close();

  checkpoint("FAIL_CLOSED_CHECK_BEGIN");
  if (!(await keyVault.verifyMissingKeyFailsClosed(dbName))) fail("Missing active key was not rejected for an existing encrypted database.");
  checkpoint("FAIL_CLOSED_CHECK_COMPLETE");
  checkpoint("KEYSTORE_DIAGNOSTICS_BEGIN");
  const keystore = await keyVault.getKeystoreDiagnostics();
  report("MYFIN_ANDROID_SMOKE:KEYSTORE_DIAGNOSTICS " + JSON.stringify(keystore));

  checkpoint("KEY_ROTATION_PREPARE_BEGIN");
  const stagedRotation = await keyVault.prepareDatabaseKeyRotation(dbName);
  checkpoint("KEY_ROTATION_PREPARE_COMPLETE");
  checkpoint("SQLCIPHER_REKEY_BEGIN");
  await sqlite.changeEncryptionSecret({ passphrase: stagedRotation.newSecret, oldpassphrase: stagedRotation.oldSecret });
  checkpoint("SQLCIPHER_REKEY_COMPLETE");
  report("MYFIN_ANDROID_SMOKE:ROTATION_PENDING restart-required-before-keystore-promotion");
}

checkpoint("RUN_DISPATCHED");
run().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  report("MYFIN_ANDROID_SMOKE:FAIL " + message);
});
