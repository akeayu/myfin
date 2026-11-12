export interface SqliteKeyRotationPort {
  changeEncryptionSecret(options: { passphrase: string; oldpassphrase: string }): Promise<void>;
  checkEncryptionSecret(options: { passphrase: string }): Promise<{ result: boolean }>;
}
export interface KeyVaultRotationPort {
  prepareDatabaseKeyRotation(): Promise<{ rotationId: string; oldSecret: string; newSecret: string }>;
  getPendingDatabaseKeyRotation(): Promise<{ pending: boolean; rotationId?: string; oldSecret?: string; newSecret?: string }>;
  commitDatabaseKeyRotation(rotationId: string): Promise<void>;
  abortDatabaseKeyRotation(rotationId: string): Promise<void>;
}
export type RotationOutcome = "ROTATED" | "RECONCILED_COMMIT" | "RECONCILED_ABORT" | "NO_PENDING_ROTATION";

async function isAccepted(sqlite: SqliteKeyRotationPort, secret: string): Promise<boolean> {
  try { return (await sqlite.checkEncryptionSecret({ passphrase: secret })).result === true; }
  catch { return false; }
}

/**
 * Rotation is a two-phase operation: persist a Keystore-wrapped pending key,
 * rekey through SQLCipher, verify the new secret, then atomically promote the
 * pending key. A crash leaves a journal that must be reconciled before DB open.
 */
export async function rotateMyfinDatabaseKey(
  sqlite: SqliteKeyRotationPort,
  vault: KeyVaultRotationPort
): Promise<RotationOutcome> {
  const staged = await vault.prepareDatabaseKeyRotation();
  try {
    await sqlite.changeEncryptionSecret({ passphrase: staged.newSecret, oldpassphrase: staged.oldSecret });
    if (!(await isAccepted(sqlite, staged.newSecret))) {
      throw new Error("SQLCipher did not verify the proposed MYFIN database key after rotation.");
    }
    await vault.commitDatabaseKeyRotation(staged.rotationId);
    return "ROTATED";
  } catch (error) {
    // Resolve ambiguous bridge/process failures from the database's actual key.
    if (await isAccepted(sqlite, staged.newSecret)) {
      await vault.commitDatabaseKeyRotation(staged.rotationId);
      return "RECONCILED_COMMIT";
    }
    if (await isAccepted(sqlite, staged.oldSecret)) {
      await vault.abortDatabaseKeyRotation(staged.rotationId);
      throw error;
    }
    throw new Error("MYFIN key rotation is unresolved. The pending Keystore record was preserved; do not open or modify the database until recovery succeeds.", { cause: error });
  }
}

/** Must run before opening MYFIN SQLite whenever a pending rotation exists. */
export async function reconcilePendingMyfinKeyRotation(
  sqlite: SqliteKeyRotationPort,
  vault: KeyVaultRotationPort
): Promise<RotationOutcome> {
  const pending = await vault.getPendingDatabaseKeyRotation();
  if (!pending.pending) return "NO_PENDING_ROTATION";
  if (!pending.rotationId || !pending.oldSecret || !pending.newSecret) {
    throw new Error("Pending MYFIN key-rotation journal is incomplete. Database access remains blocked.");
  }
  if (await isAccepted(sqlite, pending.newSecret)) {
    await vault.commitDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_COMMIT";
  }
  if (await isAccepted(sqlite, pending.oldSecret)) {
    await vault.abortDatabaseKeyRotation(pending.rotationId);
    return "RECONCILED_ABORT";
  }
  throw new Error("Neither staged key can authenticate the MYFIN database. Database access remains blocked.");
}
