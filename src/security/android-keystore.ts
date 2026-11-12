import { registerPlugin } from "@capacitor/core";
import { CapacitorSQLite } from "@capacitor-community/sqlite";
import { reconcilePendingMyfinKeyRotation, type SqliteKeyRotationPort } from "./key-rotation.js";
import type { EncryptionSecretProvider } from "../storage/capacitor.js";

export interface RecoveryEnvelopeV1 {
  readonly version: 1;
  readonly kdf: "PBKDF2-HMAC-SHA256";
  readonly iterations: 600000;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

interface NativeKeyVault {
  getOrCreateDatabaseKey(options: { database: string }): Promise<{ secret: string }>;
  exportRecoveryEnvelope(options: { passphrase: string; database: string }): Promise<RecoveryEnvelopeV1>;
  restoreRecoveryEnvelope(options: RecoveryEnvelopeV1 & { passphrase: string; database: string }): Promise<void>;
  prepareDatabaseKeyRotation(options: { database: string }): Promise<{ rotationId: string; oldSecret: string; newSecret: string }>;
  getPendingDatabaseKeyRotation(options: { database: string }): Promise<{ pending: boolean; rotationId?: string; oldSecret?: string; newSecret?: string }>;
  commitDatabaseKeyRotation(options: { rotationId: string }): Promise<void>;
  abortDatabaseKeyRotation(options: { rotationId: string }): Promise<void>;
  writeSmokeBackupFile(options: { content: string }): Promise<{ saved: boolean }>;
  readSmokeBackupFile(): Promise<{ content: string | null }>;
  verifyDatabaseKey(options: { database: string; secret: string }): Promise<{ valid: boolean }>;
}

const nativeVault = registerPlugin<NativeKeyVault>("MyfinKeyVault");

function requireAndroid(): void {
  if (!/android/i.test(globalThis.navigator?.userAgent ?? "")) {
    throw new Error("MYFIN database key lifecycle requires the native Android Keystore provider.");
  }
}

/** Native Android Keystore-backed key provider. Never replace with browser/localStorage storage. */
export class AndroidKeystoreSecretProvider implements EncryptionSecretProvider {
  async prepareForDatabaseOpen(database: string): Promise<void> {
    requireAndroid();
    await reconcilePendingMyfinKeyRotation(this.sqliteRotationPort(), { ...this, getPendingDatabaseKeyRotation: () => this.getPendingDatabaseKeyRotation(database) }, database);
  }

  sqliteRotationPort(): SqliteKeyRotationPort {
    return {
      changeEncryptionSecret: options => CapacitorSQLite.changeEncryptionSecret(options),
      verifyDatabaseKey: async options => ({ valid: await this.verifyDatabaseKey(options.database, options.secret) }),
      checkEncryptionSecret: async options => ({ result: (await CapacitorSQLite.checkEncryptionSecret(options)).result === true }),
      clearEncryptionSecret: () => CapacitorSQLite.clearEncryptionSecret(),
      setEncryptionSecret: options => CapacitorSQLite.setEncryptionSecret(options)
    };
  }

  async getOrCreateSecret(database: string): Promise<string> {
    requireAndroid();
    const pending = await nativeVault.getPendingDatabaseKeyRotation({ database });
    if (pending.pending) throw new Error("A MYFIN database-key rotation is pending. Reconcile it before opening the encrypted database.");
    const result = await nativeVault.getOrCreateDatabaseKey({ database });
    if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(result.secret)) {
      throw new Error("Android Keystore returned an invalid database key encoding.");
    }
    return result.secret;
  }

  async exportRecoveryEnvelope(passphrase: string, database: string): Promise<RecoveryEnvelopeV1> {
    requireAndroid();
    if (passphrase.length < 12) throw new Error("Use a recovery passphrase of at least 12 characters.");
    return nativeVault.exportRecoveryEnvelope({ passphrase, database });
  }

  async verifyDatabaseKey(database: string, secret: string): Promise<boolean> {
    requireAndroid();
    try {
      const result = await nativeVault.verifyDatabaseKey({ database, secret });
      return result.valid === true;
    } catch {
      return false;
    }
  }

  async writeSmokeBackupFile(content: string): Promise<void> {
    requireAndroid();
    const result = await nativeVault.writeSmokeBackupFile({ content });
    if (!result.saved) throw new Error("Android did not persist the encrypted MYFIN smoke backup.");
  }

  async readSmokeBackupFile(): Promise<string | null> {
    requireAndroid();
    return (await nativeVault.readSmokeBackupFile()).content;
  }

  async prepareDatabaseKeyRotation(database: string): Promise<{ rotationId: string; oldSecret: string; newSecret: string }> {
    requireAndroid();
    return nativeVault.prepareDatabaseKeyRotation({ database });
  }

  async getPendingDatabaseKeyRotation(database: string): Promise<{ pending: boolean; rotationId?: string; oldSecret?: string; newSecret?: string }> {
    requireAndroid();
    return nativeVault.getPendingDatabaseKeyRotation({ database });
  }

  async commitDatabaseKeyRotation(rotationId: string): Promise<void> {
    requireAndroid();
    await nativeVault.commitDatabaseKeyRotation({ rotationId });
  }

  async abortDatabaseKeyRotation(rotationId: string): Promise<void> {
    requireAndroid();
    await nativeVault.abortDatabaseKeyRotation({ rotationId });
  }

  async restoreRecoveryEnvelope(envelope: RecoveryEnvelopeV1, passphrase: string, database: string): Promise<void> {
    requireAndroid();
    if (passphrase.length < 12) throw new Error("Use the recovery passphrase of at least 12 characters.");
    if (envelope.version !== 1 || envelope.kdf !== "PBKDF2-HMAC-SHA256" || envelope.iterations !== 600000) {
      throw new Error("Unsupported MYFIN recovery envelope version or KDF parameters.");
    }
    await nativeVault.restoreRecoveryEnvelope({ ...envelope, passphrase, database });
  }
}
