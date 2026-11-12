export interface SqliteKeyRotationPort {
  changeEncryptionSecret(options: { passphrase: string; oldpassphrase: string }): Promise<void>;
  verifyDatabaseKey(options: { database: string; secret: string }): Promise<{ valid: boolean }>;
  checkEncryptionSecret(options: { passphrase: string }): Promise<{ result: boolean }>;
  clearEncryptionSecret(): Promise<void>;
  setEncryptionSecret(options: { passphrase: string }): Promise<void>;
}
export interface KeyVaultRotationPort {
  prepareDatabaseKeyRotation(): Promise<{ rotationId: string; oldSecret: string; newSecret: string }>;
  getPendingDatabaseKeyRotation(): Promise<{ pending: boolean; rotationId?: string; oldSecret?: string; newSecret?: string }>;
  commitDatabaseKeyRotation(rotationId: string): Promise<void>;
  abortDatabaseKeyRotation(rotationId: string): Promise<void>;
}
export type RotationOutcome = "ROTATED" | "RECONCILED_COMMIT" | "RECONCILED_ABORT" | "NO_PENDING_ROTATION";

async function isDatabaseKeyAccepted(sqlite: SqliteKeyRotationPort, database: string, secret: string): Promise<boolean> {
  try { return (await sqlite.verifyDatabaseKey({ database, secret })).valid === true; }
  catch { return false; }
}

/** Repair the plugin's stored passphrase only after the candidate opens the real SQLCipher file. */
async function synchronizePluginSecret(sqlite: SqliteKeyRotationPort, secret: string): Promise<void> {
  if ((await sqlite.checkEncryptionSecret({ passphrase: secret })).result) return;
  await sqlite.clearEncryptionSecret();
  await sqlite.setEncryptionSecret({ passphrase: secret });
  if (!(await sqlite.checkEncryptionSecret({ passphrase: secret })).result) {
    throw new Error("Capacitor SQLite did not persist the reconciled encryption secret.");
  }
}

/**
 * Two-phase rotation: stage a Keystore-wrapped key, rekey SQLCipher, verify the
 * real database with cipher_integrity_check, synchronize the plugin secret,
 * then promote the staged key. A crash leaves a journal for startup recovery.
 */
export async function rotateMyfinDatabaseKey(
  sqlite: SqliteKeyRotationPort,
  vault: KeyVaultRotationPort,
  database: string
): Promise<RotationOutcome> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(database)) throw new Error("Invalid MYFIN database name.");
  const staged = await vault.prepareDatabaseKeyRotation();
  try {
    await sqlite.changeEncryptionSecret({ passphrase: staged.newSecret, oldpassphrase: staged.oldSecret });
    if (!(await isDatabaseKeyAccepted(sqlite, database, staged.newSecret))) {
      throw new Error("SQLCipher did not open and integrity-check the database with the proposed key.");
    }
    await synchronizePluginSecret(sqlite, staged.newSecret);
    if (!(await isDatabaseKeyAccepted(sqlite, database, staged.newSecret))) {
      throw new Error("SQLCipher verification failed after synchronizing the plugin secret.");
    }
    await vault.commitDatabaseKeyRotation(staged.rotationId);
    return "ROTATED";
  } catch (error) {
    if (await isDatabaseKeyAccepted(sqlite, database, staged.newSecret)) {
      await synchronizePluginSecret(sqlite, staged.newSecret);
      if (!(await isDatabaseKeyAccepted(sqlite, database, staged.newSecret))) {
        throw new Error("New SQLCipher key is valid but plugin-secret reconciliation failed; pending rotation was preserved.", { cause: error });
      }
      await vault.commitDatabaseKeyRotation(staged.rotationId);
      return "RECONCILED_COMMIT";
    }
    if (await isDatabaseKeyAccepted(sqlite, database, staged.oldSecret)) {
      await synchronizePluginSecret(sqlite, staged.oldSecret);
      await vault.abortDatabaseKeyRotation(staged.rotationId);
      throw error;
    }
    throw new Error("MYFIN key rotation is unresolved. The pending Keystore record was preserved; do not open or modify the database until recovery succeeds.", { cause: error });
  }
}

/** Must run before opening MYFIN SQLite whenever a pending rotation exists. */
export async function reconcilePendingMyfinKeyRotation(
  sqlite: SqliteKeyRotationPort,
  vault: KeyVaultRotationPort,
  database: string
): Promise<RotationOutcome> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(database)) throw new Error("Invalid MYFIN database name.");
  const pending = await vault.getPendingDatabaseKeyRotation();
  if (!pending.pending) return "NO_PENDING_ROTATION";
  if (!pending.rotationId || !pending.oldSecret || !pending.newSecret) {
    throw new Error("Pending MYFIN key-rotation journal is incomplete. Database access remains blocked.");
  }
  if (await isDatabaseKeyAccepted(sqlite, database, pending.newSecret)) {
    await synchronizePluginSecret(sqlite, pending.newSecret);
    if (!(await isDatabaseKeyAccepted(sqlite, database, pending.newSecret))) {
      throw new Error("New key is valid but plugin-secret reconciliation did not restore database access.");
    }
    await vault.commitDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_COMMIT";
  }
  if (await isDatabaseKeyAccepted(sqlite, database, pending.oldSecret)) {
    await synchronizePluginSecret(sqlite, pending.oldSecret);
    await vault.abortDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_ABORT";
  }
  throw new Error("Neither staged key can open and integrity-check the MYFIN database. Database access remains blocked.");
}
