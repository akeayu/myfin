import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyfinEncryptedBackupService, type SqliteBackupPort } from "../src/security/encrypted-backup.js";
import type { RecoveryEnvelopeV1 } from "../src/security/android-keystore.js";

const recovery: RecoveryEnvelopeV1 = {
  version: 1, kdf: "PBKDF2-HMAC-SHA256", iterations: 600000,
  salt: "c2FsdC1mb3ItdGVzdA==", iv: "aXYtZm9yLXRlc3Q=", ciphertext: "Y2lwaGVydGV4dA=="
};

function makeHarness() {
  let exists = false;
  let secretStored = false;
  let encrypted = false;
  const sqlite: SqliteBackupPort = {
    exportToJson: vi.fn(async () => ({ export: {
      database: "myfin_test", version: 1, overwrite: false, encrypted: true, mode: "full",
      tables: [{ name: "synthetic", schema: [], indexes: [], triggers: [], values: [["sentinel"]] }]
    } })),
    isDatabase: vi.fn(async () => ({ result: exists })),
    isDatabaseEncrypted: vi.fn(async () => ({ result: encrypted })),
    isSecretStored: vi.fn(async () => ({ result: secretStored })),
    setEncryptionSecret: vi.fn(async () => { secretStored = true; }),
    importFromJson: vi.fn(async () => { exists = true; encrypted = true; return { changes: { changes: 1 } }; }),
    checkEncryptionSecret: vi.fn(async () => ({ result: true })),
    deleteDatabase: vi.fn(async () => { exists = false; })
  };
  const keyVault = {
    getOrCreateSecret: vi.fn(async () => "A".repeat(44)),
    exportRecoveryEnvelope: vi.fn(async () => recovery),
    restoreRecoveryEnvelope: vi.fn(async () => undefined)
  };
  return { service: new MyfinEncryptedBackupService(sqlite, keyVault), sqlite, keyVault, state: () => ({ exists, secretStored, encrypted }) };
}

describe("MYFIN encrypted backup", () => {
  beforeEach(() => vi.stubGlobal("crypto", globalThis.crypto));

  it("exports a passphrase-protected full logical backup and restores to an empty installation", async () => {
    const source = makeHarness();
    const serialized = await source.service.exportBackup("myfin_test", "correct-horse-battery-staple");
    expect(JSON.parse(serialized)).toMatchObject({
      magic: "MYFIN-ENCRYPTED-BACKUP", version: 1, cipher: "AES-256-GCM", iterations: 600000
    });

    const target = makeHarness();
    const restored = await target.service.restoreBackup(serialized, "correct-horse-battery-staple");
    expect(restored.database).toBe("myfin_test");
    expect(target.keyVault.restoreRecoveryEnvelope).toHaveBeenCalledWith(recovery, "correct-horse-battery-staple");
    expect(target.sqlite.setEncryptionSecret).toHaveBeenCalled();
    expect(target.sqlite.importFromJson).toHaveBeenCalledOnce();
    expect(target.state()).toEqual({ exists: true, secretStored: true, encrypted: true });
  });

  it("rejects a wrong passphrase and tampered ciphertext before touching storage", async () => {
    const source = makeHarness();
    const serialized = await source.service.exportBackup("myfin_test", "correct-horse-battery-staple");
    const target = makeHarness();
    await expect(target.service.restoreBackup(serialized, "incorrect-passphrase")).rejects.toThrow();
    const altered = JSON.parse(serialized) as { ciphertext: string };
    altered.ciphertext = altered.ciphertext.slice(0, -4) + "AAAA";
    await expect(target.service.restoreBackup(JSON.stringify(altered), "correct-horse-battery-staple")).rejects.toThrow();
    expect(target.sqlite.importFromJson).not.toHaveBeenCalled();
  });

  it("never overwrites an existing database", async () => {
    const source = makeHarness();
    const serialized = await source.service.exportBackup("myfin_test", "correct-horse-battery-staple");
    const target = makeHarness();
    // Make the target name exist before import.
    (target.sqlite.isDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ result: true });
    await expect(target.service.restoreBackup(serialized, "correct-horse-battery-staple")).rejects.toThrow(/already exists/);
    expect(target.sqlite.importFromJson).not.toHaveBeenCalled();
  });

  it("cleans up a partial database when import fails", async () => {
    const source = makeHarness();
    const serialized = await source.service.exportBackup("myfin_test", "correct-horse-battery-staple");
    const target = makeHarness();
    (target.sqlite.importFromJson as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (target.sqlite.isDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ result: true });
      return { changes: { changes: -1 } };
    });
    await expect(target.service.restoreBackup(serialized, "correct-horse-battery-staple")).rejects.toThrow(/rejected/);
    expect(target.sqlite.deleteDatabase).toHaveBeenCalledWith({ database: "myfin_test" });
  });
});
