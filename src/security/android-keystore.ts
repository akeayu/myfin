import { registerPlugin } from "@capacitor/core";
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
  getOrCreateDatabaseKey(): Promise<{ secret: string }>;
  exportRecoveryEnvelope(options: { passphrase: string }): Promise<RecoveryEnvelopeV1>;
  restoreRecoveryEnvelope(options: RecoveryEnvelopeV1 & { passphrase: string }): Promise<void>;
}

const nativeVault = registerPlugin<NativeKeyVault>("MyfinKeyVault");

function requireAndroid(): void {
  if (!/android/i.test(globalThis.navigator?.userAgent ?? "")) {
    throw new Error("MYFIN database key lifecycle requires the native Android Keystore provider.");
  }
}

/** Native Android Keystore-backed key provider. Never replace with browser/localStorage storage. */
export class AndroidKeystoreSecretProvider implements EncryptionSecretProvider {
  async getOrCreateSecret(): Promise<string> {
    requireAndroid();
    const result = await nativeVault.getOrCreateDatabaseKey();
    if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(result.secret)) {
      throw new Error("Android Keystore returned an invalid database key encoding.");
    }
    return result.secret;
  }

  async exportRecoveryEnvelope(passphrase: string): Promise<RecoveryEnvelopeV1> {
    requireAndroid();
    if (passphrase.length < 12) throw new Error("Use a recovery passphrase of at least 12 characters.");
    return nativeVault.exportRecoveryEnvelope({ passphrase });
  }

  async restoreRecoveryEnvelope(envelope: RecoveryEnvelopeV1, passphrase: string): Promise<void> {
    requireAndroid();
    if (passphrase.length < 12) throw new Error("Use the recovery passphrase of at least 12 characters.");
    if (envelope.version !== 1 || envelope.kdf !== "PBKDF2-HMAC-SHA256" || envelope.iterations !== 600000) {
      throw new Error("Unsupported MYFIN recovery envelope version or KDF parameters.");
    }
    await nativeVault.restoreRecoveryEnvelope({ ...envelope, passphrase });
  }
}
