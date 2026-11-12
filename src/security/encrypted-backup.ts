import type { AndroidKeystoreSecretProvider, RecoveryEnvelopeV1 } from "./android-keystore.js";

const BACKUP_MAGIC = "MYFIN-ENCRYPTED-BACKUP";
const BACKUP_VERSION = 1;
const KDF_ITERATIONS = 600_000;

export interface EncryptedJsonExport {
  readonly export: Record<string, unknown>;
}

export interface SqliteBackupPort {
  exportToJson(options: { database: string; jsonexportmode: "full"; encrypted: true }): Promise<EncryptedJsonExport>;
  isDatabase(options: { database: string }): Promise<{ result: boolean }>;
  isDatabaseEncrypted(options: { database: string }): Promise<{ result: boolean }>;
  isSecretStored(): Promise<{ result: boolean }>;
  setEncryptionSecret(options: { passphrase: string }): Promise<void>;
  isJsonValid(options: { jsonstring: string }): Promise<{ result: boolean }>;
  importFromJson(options: { jsonstring: string }): Promise<{ changes?: { changes?: number } }>;
  deleteDatabase(options: { database: string }): Promise<void>;
}

interface BackupPayloadV1 {
  readonly magic: typeof BACKUP_MAGIC;
  readonly version: typeof BACKUP_VERSION;
  readonly database: string;
  readonly createdAt: string;
  readonly recovery: RecoveryEnvelopeV1;
  readonly sqliteExport: Record<string, unknown>;
}

export interface EncryptedBackupFileV1 {
  readonly magic: typeof BACKUP_MAGIC;
  readonly version: typeof BACKUP_VERSION;
  readonly kdf: "PBKDF2-HMAC-SHA256";
  readonly iterations: typeof KDF_ITERATIONS;
  readonly cipher: "AES-256-GCM";
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function requirePassphrase(value: string): void {
  if (value.length < 12) throw new Error("Backup passphrase must contain at least 12 characters.");
}
async function derive(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: asArrayBuffer(salt), iterations: KDF_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptPayload(payload: BackupPayloadV1, passphrase: string): Promise<EncryptedBackupFileV1> {
  requirePassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    magic: BACKUP_MAGIC, version: BACKUP_VERSION, kdf: "PBKDF2-HMAC-SHA256",
    iterations: KDF_ITERATIONS, cipher: "AES-256-GCM",
    salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext))
  };
}
async function decryptPayload(backup: EncryptedBackupFileV1, passphrase: string): Promise<BackupPayloadV1> {
  requirePassphrase(passphrase);
  if (backup.magic !== BACKUP_MAGIC || backup.version !== BACKUP_VERSION ||
      backup.kdf !== "PBKDF2-HMAC-SHA256" || backup.iterations !== KDF_ITERATIONS ||
      backup.cipher !== "AES-256-GCM") throw new Error("Unsupported MYFIN backup format.");
  const salt = fromBase64(backup.salt);
  const iv = fromBase64(backup.iv);
  const ciphertext = fromBase64(backup.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("MYFIN backup cryptographic field lengths are invalid.");
  }
  const key = await derive(passphrase, salt);
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) }, key, asArrayBuffer(ciphertext)
  );
  const payload = JSON.parse(new TextDecoder().decode(clear)) as BackupPayloadV1;
  if (payload.magic !== BACKUP_MAGIC || payload.version !== BACKUP_VERSION ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.database) ||
      !payload.sqliteExport || typeof payload.sqliteExport !== "object" ||
      payload.sqliteExport.database !== payload.database || payload.sqliteExport.encrypted !== true ||
      payload.sqliteExport.mode !== "full" ||
      !payload.recovery || payload.recovery.version !== 1 ||
      payload.recovery.kdf !== "PBKDF2-HMAC-SHA256" || payload.recovery.iterations !== 600000) {
    throw new Error("MYFIN backup payload validation failed.");
  }
  return payload;
}

/**
 * Produces a portable encrypted logical backup. The SQLite plugin's full JSON
 * export is requested with encrypted=true, then the complete payload (including
 * the recovery envelope) is additionally protected by a user-held passphrase.
 * This is not a byte-for-byte database image; WAL is checkpointed by SQLite's
 * export implementation and is not copied as a separate file.
 */
export class MyfinEncryptedBackupService {
  constructor(
    private readonly sqlite: SqliteBackupPort,
    private readonly keyVault: Pick<AndroidKeystoreSecretProvider, "exportRecoveryEnvelope" | "restoreRecoveryEnvelope" | "getOrCreateSecret">
  ) {}

  async exportBackup(database: string, passphrase: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(database)) throw new Error("Invalid MYFIN database name.");
    requirePassphrase(passphrase);
    const result = await this.sqlite.exportToJson({ database, jsonexportmode: "full", encrypted: true });
    if (!result.export || typeof result.export !== "object") throw new Error("SQLite did not return a full database export.");
    const recovery = await this.keyVault.exportRecoveryEnvelope(passphrase, database);
    const backup: BackupPayloadV1 = {
      magic: BACKUP_MAGIC, version: BACKUP_VERSION, database,
      createdAt: new Date().toISOString(), recovery, sqliteExport: result.export
    };
    return JSON.stringify(await encryptPayload(backup, passphrase));
  }

  /**
   * Restore is deliberately limited to a database name that does not already
   * exist. It never overwrites a live ledger. On import failure, a partial
   * newly-created database is removed so the user can retry from the backup.
   */
  async restoreBackup(serializedBackup: string, passphrase: string): Promise<{ database: string }> {
    if (serializedBackup.length > 100_000_000) throw new Error("MYFIN backup exceeds the supported import size.");
    const backup = JSON.parse(serializedBackup) as EncryptedBackupFileV1;
    const payload = await decryptPayload(backup, passphrase);
    const database = payload.database;
    if ((await this.sqlite.isDatabase({ database })).result) {
      throw new Error("Restore refused: a database with this name already exists. Use a separately reviewed replacement workflow.");
    }

    await this.keyVault.restoreRecoveryEnvelope(payload.recovery, passphrase, database);
    const secret = await this.keyVault.getOrCreateSecret(database);
    if (!(await this.sqlite.isSecretStored()).result) await this.sqlite.setEncryptionSecret({ passphrase: secret });

    try {
      const importObject = { ...payload.sqliteExport, database, overwrite: false, encrypted: true };
      const importJson = JSON.stringify(importObject);
      if (!(await this.sqlite.isJsonValid({ jsonstring: importJson })).result) {
        throw new Error("SQLite rejected the backup structure during pre-import validation.");
      }
      const imported = await this.sqlite.importFromJson({ jsonstring: importJson });
      if ((imported.changes?.changes ?? 0) < 0) throw new Error("SQLite rejected the encrypted backup import.");
      if (!(await this.sqlite.isDatabase({ database })).result) throw new Error("Imported database was not created.");
      if (!(await this.sqlite.isDatabaseEncrypted({ database })).result) throw new Error("Imported database is not encrypted.");
      return { database };
    } catch (error) {
      try {
        if ((await this.sqlite.isDatabase({ database })).result) await this.sqlite.deleteDatabase({ database });
      } catch { /* preserve the original import failure */ }
      throw error;
    }
  }
}
