import { describe, expect, it, vi } from "vitest";
import {
  reconcilePendingMyfinKeyRotation, rotateMyfinDatabaseKey,
  type KeyVaultRotationPort, type SqliteKeyRotationPort
} from "../src/security/key-rotation.js";

function harness(initial: "old" | "new" = "old") {
  let active: "old" | "new" = initial;
  let pending = false;
  const sqlite: SqliteKeyRotationPort = {
    changeEncryptionSecret: vi.fn(async () => { active = "new"; }),
    verifyDatabaseKey: vi.fn(async ({ secret }) => ({ valid: secret === (active === "old" ? "old-key" : "new-key") }))
  };
  const vault: KeyVaultRotationPort = {
    prepareDatabaseKeyRotation: vi.fn(async () => { pending = true; return { rotationId: "rotation-1", oldSecret: "old-key", newSecret: "new-key" }; }),
    getPendingDatabaseKeyRotation: vi.fn(async () => pending
      ? { pending: true, rotationId: "rotation-1", oldSecret: "old-key", newSecret: "new-key" }
      : { pending: false }),
    commitDatabaseKeyRotation: vi.fn(async () => { pending = false; }),
    abortDatabaseKeyRotation: vi.fn(async () => { pending = false; })
  };
  return { sqlite, vault, state: () => ({ active, pending }) };
}

describe("MYFIN two-phase SQLCipher key rotation", () => {
  it("rekeys, verifies the new secret, then commits the Keystore key", async () => {
    const h = harness();
    await expect(rotateMyfinDatabaseKey(h.sqlite, h.vault, "myfin_test")).resolves.toBe("ROTATED");
    expect(h.sqlite.changeEncryptionSecret).toHaveBeenCalledWith({ passphrase: "new-key", oldpassphrase: "old-key" });
    expect(h.vault.commitDatabaseKeyRotation).toHaveBeenCalledWith("rotation-1");
    expect(h.state()).toEqual({ active: "new", pending: false });
  });

  it("reconciles a crash after SQLCipher rekey but before key promotion", async () => {
    const h = harness("new");
    h.vault.getPendingDatabaseKeyRotation = vi.fn(async () => ({
      pending: true, rotationId: "rotation-1", oldSecret: "old-key", newSecret: "new-key"
    }));
    await expect(reconcilePendingMyfinKeyRotation(h.sqlite, h.vault, "myfin_test")).resolves.toBe("RECONCILED_COMMIT");
    expect(h.vault.commitDatabaseKeyRotation).toHaveBeenCalledWith("rotation-1");
  });

  it("aborts a staged rotation when the old SQLCipher key remains active", async () => {
    const h = harness("old");
    h.vault.getPendingDatabaseKeyRotation = vi.fn(async () => ({
      pending: true, rotationId: "rotation-1", oldSecret: "old-key", newSecret: "new-key"
    }));
    await expect(reconcilePendingMyfinKeyRotation(h.sqlite, h.vault)).resolves.toBe("RECONCILED_ABORT");
    expect(h.vault.abortDatabaseKeyRotation).toHaveBeenCalledWith("rotation-1");
  });

  it("preserves the pending journal if neither key authenticates", async () => {
    const h = harness();
    h.sqlite.changeEncryptionSecret = vi.fn(async () => { h.state(); });
    h.sqlite.verifyDatabaseKey = vi.fn(async () => ({ valid: false }));
    await expect(rotateMyfinDatabaseKey(h.sqlite, h.vault)).rejects.toThrow(/unresolved/);
    expect(h.vault.abortDatabaseKeyRotation).not.toHaveBeenCalled();
    expect(h.vault.commitDatabaseKeyRotation).not.toHaveBeenCalled();
  });
});
