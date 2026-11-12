export interface SqliteKeyRotationPort {
  changeEncryptionSecret(options: { passphrase: string; oldpassphrase: string }): Promise<void>;
  verifyDatabaseKey(options: { database: string; secret: string }): Promise<{ valid: boolean }>;
}
export interface KeyVaultRotationPort {
  prepareDatabaseKeyRotation(): Promise<{ rotationId: string; oldSecret: string; newSecret: string }>;
  getPendingDatabaseKeyRotation(): Promise<{ pending: boolean; rotationId?: string; oldSecret?: string; newSecret?: string }>;
  commitDatabaseKeyRotation(rotationId: string): Promise<void>;
  abortDatabaseKeyRotation(rotationId: string): Promise<void>;
}
export type RotationOutcome = "ROTATED" | "RECONCILED_COMMIT" | "RECONCILED_ABORT" | "NO_PENDING_ROTATION";

async function isAccepted(sqlite: SqliteKeyRotationPort, database: string, secret: string): Promise<boolean> {
  try { return (await sqlite.verifyDatabaseKey({ database, secret })).valid === true; }
  catch { return false; }
}

/**
 * Rotation is a two-phase operation: persist a Keystore-wrapped pending key,
 * rekey through SQLCipher, verify that the candidate key opens and passes
 * cipher_integrity_check on the actual database file, then promote the key.
 * A crash leaves a journal that must be reconciled before database access.
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
    if (!(await isAccepted(sqlite, database, staged.newSecret))) {
      throw new Error("SQLCipher did not open and integrity-check the database with the proposed key.");
    }
    await vault.commitDatabaseKeyRotation(staged.rotationId);
    return "ROTATED";
  } catch (error) {
    // Resolve ambiguous bridge/process failures from the database's actual key.
    if (await isAccepted(sqlite, database, staged.newSecret)) {
      await vault.commitDatabaseKeyRotation(staged.rotationId);
      return "RECONCILED_COMMIT";
    }
    if (await isAccepted(sqlite, database, staged.oldSecret)) {
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
  if (await isAccepted(sqlite, database, pending.newSecret)) {
    await vault.commitDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_COMMIT";
  }
  if (await isAccepted(sqlite, database, pending.oldSecret)) {
    await vault.abortDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_ABORT";
  }
  throw new Error("Neither staged key can open and integrity-check the MYFIN database. Database access remains blocked.");
}
