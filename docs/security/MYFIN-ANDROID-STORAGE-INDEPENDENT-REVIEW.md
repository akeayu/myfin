# MYFIN Android Storage Security Review Package

Status: **PREPARATION ONLY — independent review not yet performed**

Target branch: `feat/a3-financial-calendar-offline-iroka-foundation`

## Review boundary

Review the Android encrypted-storage and recovery implementation as a security-critical subsystem. Do not infer production readiness from successful compilation, unit tests, emulator smoke tests, or this review package.

In-scope files:
- `native/android/MyfinKeyVaultPlugin.java`
- `src/security/android-keystore.ts`
- `src/security/encrypted-backup.ts`
- `src/security/key-rotation.ts`
- `src/storage/capacitor.ts`
- `android-smoke/main.ts`
- `scripts/verify-android-smoke.sh`
- `.github/workflows/android-sqlcipher.yml`
- `scripts/patch-android-manifest.mjs`

## Assets and security objectives

1. Confidentiality and integrity of the MYFIN SQLCipher database and financial records.
2. Confidentiality of the database key and its Android Keystore wrapping key.
3. Recovery of a database on a fresh installation without relying on the previous installation's Keystore namespace.
4. Atomicity and recoverability of SQLCipher key rotation.
5. Confidentiality and integrity of user-controlled exported backup files.
6. Prevention of plaintext leakage through Android Auto Backup, WAL, rollback journal, shared memory, temporary files, logs, or crash artifacts.
7. Fail-closed behavior on wrong credentials, malformed backup data, interrupted rotation, missing keys, and partial restore.

## Required independent test cases

### Keystore and key lifecycle
- Determine whether the wrapping key is hardware-backed on each supported physical device; record security level and StrongBox availability without assuming emulator results prove hardware protection.
- Verify key alias creation, app restart persistence, app-data clearing, uninstall/reinstall, device lock/unlock, OS upgrade, backup/restore, and key invalidation behavior.
- Verify loss of the Keystore wrapping key does not silently create a new key for an existing database.
- Inspect whether database secrets are exposed in JavaScript memory, Capacitor bridge traffic, logs, crash reports, or plugin-managed preferences.
- Test authentication and concurrent access requirements against the product threat model.

### SQLCipher and sidecars
- Verify SQLCipher cipher parameters, key derivation, encrypted database header, and wrong-key rejection.
- Inspect main database, `-wal`, `-shm`, rollback journal, temporary files, copied files, and crash/recovery artifacts while the database is active and after checkpoint/close.
- Confirm all sidecars are encrypted or contain no recoverable plaintext financial records.
- Test abrupt process termination during writes, checkpoint, key rotation, backup export, and restore.

### Backup and restore
- Verify backup encryption parameters, random salt/nonce generation, authentication-tag enforcement, version validation, and metadata binding.
- Test wrong passphrase, tampered ciphertext, truncated backup, oversized backup, unsupported version, malformed SQLite JSON, replayed backup, and database-name mismatch.
- Verify export/import preserves schema, triggers, indexes, migrations, journal invariants, audit history, and integer precision.
- Verify restore never overwrites an existing live ledger and is atomic or safely retryable after interruption.
- Verify no plaintext export is written to temporary files or logs.
- Review the actual user-facing file picker/share workflow when integrated; the current service API returns serialized encrypted backup content and does not itself provide a user-facing document picker.

### Key rotation
- Verify SQLCipher rekey actually changes the database key and the new key opens the database.
- Interrupt the process before SQLCipher rekey, during rekey, after rekey but before Keystore promotion, and after promotion.
- Verify pending rotation reconciliation identifies the key that actually opens the database and never discards both candidates.
- Verify rotation failure does not permit new writes until reconciled.

### Android backup and platform behavior
- Inspect manifest backup exclusions on supported Android API levels.
- Verify cloud backup, device transfer, OEM migration, debugging, rooted-device exposure, and app-private file permissions.
- Verify no secret, database, WAL, journal, or backup material is included in automatic platform backups.

## Required reviewer deliverables

- Reviewer identity, qualifications, organization, date, device models, Android versions, and test environment.
- Exact reviewed commit SHA and any reviewed diff.
- Reproducible test commands and raw evidence.
- Findings ranked Critical / High / Medium / Low / Informational, with affected files and exploit preconditions.
- Explicit statement of tests not run and environmental limitations.
- Remediation PR references and independent retest results.
- Signed review report or equivalent verifiable provenance.

## Current limitations that must remain open

- Physical-device verification is not yet recorded.
- WAL/journal/temp-file inspection is not yet recorded.
- Fresh-install emulator recovery must pass before claiming emulator recovery success.
- User-facing document picker / save-to-location integration is not yet implemented; current backup API creates and consumes serialized encrypted backup content.
- Independent security review is not started.
- No production data, release, merge, or deployment is authorized by this document.
