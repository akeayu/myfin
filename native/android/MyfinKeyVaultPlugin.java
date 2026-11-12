package com.myfin.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import android.content.SharedPreferences;
import net.zetetic.database.sqlcipher.SQLiteDatabase;

@CapacitorPlugin(name = "MyfinKeyVault")
public class MyfinKeyVaultPlugin extends Plugin {
    private static final String ALIAS = "myfin.database.key.wrap.v1";
    private static final String PREFS = "myfin_key_vault_v1";
    private static final String ACTIVE = "wrapped_database_key";
    private static final String PENDING = "pending_wrapped_database_key";
    private static final String PENDING_ID = "pending_rotation_id";
    private static final int GCM_TAG_BITS = 128;
    private static final int KEY_BYTES = 32;
    private static final int PBKDF2_ITERATIONS = 600000;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private SecretKey wrappingKey(boolean createIfMissing) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        if (!createIfMissing) throw new IllegalStateException("MYFIN Android Keystore wrapping key is missing; refusing to generate a replacement.");
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build());
        return generator.generateKey();
    }

    private byte[] wrap(byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(true));
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext);
        byte[] result = new byte[1 + iv.length + ciphertext.length];
        result[0] = (byte) iv.length;
        System.arraycopy(iv, 0, result, 1, iv.length);
        System.arraycopy(ciphertext, 0, result, 1 + iv.length, ciphertext.length);
        return result;
    }

    private byte[] unwrap(byte[] wrapped) throws Exception {
        int ivLength = wrapped[0] & 0xff;
        byte[] iv = java.util.Arrays.copyOfRange(wrapped, 1, 1 + ivLength);
        byte[] ciphertext = java.util.Arrays.copyOfRange(wrapped, 1 + ivLength, wrapped.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(false), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return cipher.doFinal(ciphertext);
    }

    private java.io.File databaseFile(String database) {
        if (database == null || !database.matches("[a-zA-Z0-9_-]{1,64}"))
            throw new IllegalArgumentException("Invalid MYFIN database name.");
        return getContext().getDatabasePath(database + "SQLite.db");
    }

    private void refuseProvisioningIfDatabaseArtifactsExist(String database) {
        java.io.File file = databaseFile(database);
        String path = file.getAbsolutePath();
        String[] artifacts = { path, path + "-wal", path + "-shm", path + "-journal" };
        for (String artifact : artifacts) {
            if (new java.io.File(artifact).isFile()) {
                throw new IllegalStateException("MYFIN encrypted database artifacts exist but the active Keystore key is missing. Refusing to generate a replacement key; restore the original key and database together.");
            }
        }
    }

    private byte[] activeKey(String database) throws Exception {
        String stored = prefs().getString(ACTIVE, null);
        if (stored == null) {
            refuseProvisioningIfDatabaseArtifactsExist(database);
            byte[] key = new byte[KEY_BYTES];
            new SecureRandom().nextBytes(key);
            String wrapped = Base64.encodeToString(wrap(key), Base64.NO_WRAP);
            if (!prefs().edit().putString(ACTIVE, wrapped).commit())
                throw new IllegalStateException("Unable to persist wrapped MYFIN database key.");
            return key;
        }
        return unwrap(Base64.decode(stored, Base64.NO_WRAP));
    }

    @PluginMethod
    public void getOrCreateDatabaseKey(PluginCall call) {
        try {
            String database = call.getString("database", "");
            JSObject ret = new JSObject();
            ret.put("secret", Base64.encodeToString(activeKey(database), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) { call.reject("MYFIN Keystore key unavailable.", e); }
    }

    @PluginMethod
    public void verifyDatabaseKey(PluginCall call) {
        SQLiteDatabase database = null;
        try {
            String name = call.getString("database", "");
            String secret = call.getString("secret", "");
            if (!name.matches("[a-zA-Z0-9_-]{1,64}") || secret.isEmpty())
                throw new IllegalArgumentException("Invalid MYFIN database verification request.");
            java.io.File file = getContext().getDatabasePath(name + "SQLite.db");
            if (!file.isFile()) throw new java.io.FileNotFoundException("MYFIN database file does not exist.");
            System.loadLibrary("sqlcipher");
            database = SQLiteDatabase.openDatabase(
                file.getAbsolutePath(), secret, null, SQLiteDatabase.OPEN_READONLY, null
            );
            if (!database.isOpen()) throw new IllegalStateException("SQLCipher did not open the database.");
            database.getVersion();
            try (android.database.Cursor cursor = database.rawQuery("PRAGMA cipher_integrity_check", null)) {
                if (!cursor.moveToFirst() || !"ok".equalsIgnoreCase(cursor.getString(0)))
                    throw new IllegalStateException("SQLCipher integrity check did not return ok.");
            }
            JSObject ret = new JSObject();
            ret.put("valid", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("SQLCipher database-key verification failed.", e);
        } finally {
            if (database != null) database.close();
        }
    }

    @PluginMethod
    public void prepareDatabaseKeyRotation(PluginCall call) {
        try {
            if (prefs().getString(PENDING, null) != null) throw new IllegalStateException("A database-key rotation is already pending.");
            String database = call.getString("database", "");
            byte[] oldKey = activeKey(database);
            byte[] newKey = new byte[KEY_BYTES];
            new SecureRandom().nextBytes(newKey);
            String rotationId = java.util.UUID.randomUUID().toString();
            boolean saved = prefs().edit()
                .putString(PENDING, Base64.encodeToString(wrap(newKey), Base64.NO_WRAP))
                .putString(PENDING_ID, rotationId).commit();
            if (!saved) throw new IllegalStateException("Unable to persist staged database-key rotation.");
            JSObject ret = new JSObject();
            ret.put("rotationId", rotationId);
            ret.put("oldSecret", Base64.encodeToString(oldKey, Base64.NO_WRAP));
            ret.put("newSecret", Base64.encodeToString(newKey, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) { call.reject("Unable to stage MYFIN database-key rotation.", e); }
    }

    @PluginMethod
    public void getPendingDatabaseKeyRotation(PluginCall call) {
        try {
            String database = call.getString("database", "");
            String pending = prefs().getString(PENDING, null);
            JSObject ret = new JSObject();
            ret.put("pending", pending != null);
            if (pending != null) {
                ret.put("rotationId", prefs().getString(PENDING_ID, ""));
                ret.put("oldSecret", Base64.encodeToString(activeKey(database), Base64.NO_WRAP));
                ret.put("newSecret", Base64.encodeToString(unwrap(Base64.decode(pending, Base64.NO_WRAP)), Base64.NO_WRAP));
            }
            call.resolve(ret);
        } catch (Exception e) { call.reject("Unable to inspect pending MYFIN key rotation.", e); }
    }

    @PluginMethod
    public void commitDatabaseKeyRotation(PluginCall call) {
        try {
            String rotationId = call.getString("rotationId", "");
            String pendingId = prefs().getString(PENDING_ID, null);
            String pending = prefs().getString(PENDING, null);
            if (pending == null || pendingId == null || !pendingId.equals(rotationId))
                throw new IllegalStateException("MYFIN key-rotation receipt does not match the pending operation.");
            if (!prefs().edit().putString(ACTIVE, pending).remove(PENDING).remove(PENDING_ID).commit())
                throw new IllegalStateException("Unable to commit MYFIN database-key rotation.");
            call.resolve();
        } catch (Exception e) { call.reject("Unable to commit MYFIN database-key rotation.", e); }
    }

    @PluginMethod
    public void abortDatabaseKeyRotation(PluginCall call) {
        try {
            String rotationId = call.getString("rotationId", "");
            String pendingId = prefs().getString(PENDING_ID, null);
            if (pendingId == null || !pendingId.equals(rotationId))
                throw new IllegalStateException("MYFIN key-rotation receipt does not match the pending operation.");
            if (!prefs().edit().remove(PENDING).remove(PENDING_ID).commit())
                throw new IllegalStateException("Unable to clear staged MYFIN key rotation.");
            call.resolve();
        } catch (Exception e) { call.reject("Unable to abort MYFIN database-key rotation.", e); }
    }

    @PluginMethod
    public void writeSmokeBackupFile(PluginCall call) {
        try {
            String content = call.getString("content", "");
            if (content.length() < 64 || content.length() > 100000000)
                throw new IllegalArgumentException("Invalid MYFIN smoke backup size.");
            java.io.File file = new java.io.File(getContext().getFilesDir(), "myfin-smoke-backup.json");
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(file, false)) {
                output.write(content.getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) { call.reject("Unable to stage encrypted MYFIN smoke backup.", e); }
    }

    @PluginMethod
    public void readSmokeBackupFile(PluginCall call) {
        try {
            java.io.File file = new java.io.File(getContext().getFilesDir(), "myfin-smoke-backup.json");
            JSObject ret = new JSObject();
            if (!file.isFile()) {
                ret.put("content", (String) null);
            } else {
                long length = file.length();
                if (length < 64 || length > 100000000) throw new IllegalStateException("Staged MYFIN smoke backup has an invalid size.");
                byte[] bytes = new byte[(int) length];
                try (java.io.FileInputStream input = new java.io.FileInputStream(file)) {
                    int offset = 0;
                    while (offset < bytes.length) {
                        int read = input.read(bytes, offset, bytes.length - offset);
                        if (read < 0) throw new java.io.EOFException("Unexpected end of staged backup file.");
                        offset += read;
                    }
                }
                ret.put("content", new String(bytes, StandardCharsets.UTF_8));
            }
            call.resolve(ret);
        } catch (Exception e) { call.reject("Unable to read staged encrypted MYFIN smoke backup.", e); }
    }

    @PluginMethod
    public void exportRecoveryEnvelope(PluginCall call) {
        char[] passphrase = call.getString("passphrase", "").toCharArray();
        if (passphrase.length < 12) { call.reject("Recovery passphrase must contain at least 12 characters."); return; }
        PBEKeySpec spec = null;
        try {
            byte[] salt = new byte[16]; new SecureRandom().nextBytes(salt);
            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            spec = new PBEKeySpec(passphrase, salt, PBKDF2_ITERATIONS, 256);
            byte[] derived = factory.generateSecret(spec).getEncoded();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(derived, "AES"));
            String database = call.getString("database", "");
            byte[] ciphertext = cipher.doFinal(activeKey(database));
            JSObject ret = new JSObject();
            ret.put("version", 1); ret.put("kdf", "PBKDF2-HMAC-SHA256");
            ret.put("iterations", PBKDF2_ITERATIONS);
            ret.put("salt", Base64.encodeToString(salt, Base64.NO_WRAP));
            ret.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            ret.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) { call.reject("Unable to create encrypted recovery envelope.", e); }
        finally { if (spec != null) spec.clearPassword(); java.util.Arrays.fill(passphrase, '\0'); }
    }

    @PluginMethod
    public void restoreRecoveryEnvelope(PluginCall call) {
        char[] passphrase = call.getString("passphrase", "").toCharArray();
        PBEKeySpec spec = null;
        try {
            String database = call.getString("database", "");
            if (call.getInt("version", 0) != 1 || !"PBKDF2-HMAC-SHA256".equals(call.getString("kdf")) ||
                call.getInt("iterations", 0) != PBKDF2_ITERATIONS) throw new IllegalArgumentException("Unsupported recovery envelope.");
            if (passphrase.length < 12) throw new IllegalArgumentException("Recovery passphrase must contain at least 12 characters.");
            byte[] salt = Base64.decode(call.getString("salt"), Base64.NO_WRAP);
            byte[] iv = Base64.decode(call.getString("iv"), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(call.getString("ciphertext"), Base64.NO_WRAP);
            if (salt.length != 16 || iv.length != 12 || ciphertext.length != KEY_BYTES + 16)
                throw new IllegalArgumentException("Invalid recovery envelope cryptographic field lengths.");
            spec = new PBEKeySpec(passphrase, salt, PBKDF2_ITERATIONS, 256);
            byte[] derived = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(derived, "AES"), new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] key = cipher.doFinal(ciphertext);
            if (key.length != KEY_BYTES) throw new IllegalArgumentException("Invalid recovered database key.");
            String current = prefs().getString(ACTIVE, null);
            if (current == null) refuseProvisioningIfDatabaseArtifactsExist(database);
            if (current != null) {
                byte[] currentKey = unwrap(Base64.decode(current, Base64.NO_WRAP));
                if (!java.security.MessageDigest.isEqual(currentKey, key))
                    throw new IllegalStateException("A different local database key already exists. Restore the encrypted database and key together through the staged restore workflow.");
                call.resolve();
                return;
            }
            String wrapped = Base64.encodeToString(wrap(key), Base64.NO_WRAP);
            if (!prefs().edit().putString(ACTIVE, wrapped).commit()) throw new IllegalStateException("Unable to persist recovered key.");
            call.resolve();
        } catch (Exception e) { call.reject("Recovery failed; existing local key was not intentionally changed.", e); }
        finally { if (spec != null) spec.clearPassword(); java.util.Arrays.fill(passphrase, '\0'); }
    }
}
