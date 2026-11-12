# MYFIN Android physical-device verification protocol

Status: TEST PACKAGE PREPARATION — not evidence of a completed handset test.

## Scope and safety

- Use synthetic records only. Do not import real financial data, connect bank accounts, or use production credentials.
- This is a debug smoke APK. It is not a production release or a signed distribution build.
- The test creates a synthetic SQLCipher database, rotates its key, exports a passphrase-protected backup, and exercises fresh-install recovery.
- The debug-only missing-key probe temporarily removes the active wrapped-key preference, verifies that an existing database causes provisioning to fail closed, and restores the original wrapped-key preference in a `finally` path.
- Do not clear app data or uninstall before extracting the encrypted backup.
- Keep the APK SHA-256, device model, Android version/build, date, and complete logcat output with the test record.

## Required device evidence

1. Exact APK SHA-256 and source commit SHA.
2. Device manufacturer/model, Android API level/build fingerprint, and security patch level.
3. `KEYSTORE_DIAGNOSTICS` JSON: `insideSecureHardware`, `securityLevel`, and `strongBoxBacked`. Do not infer hardware backing from the Android brand/model.
4. `KEY_LOSS_FAIL_CLOSED` probe success (represented by the smoke test proceeding beyond the probe).
5. First-launch `ROTATION_PENDING`, followed after force-stop/restart by `BACKUP_READY`.
6. Fresh-install `RESTORE_PASS` and `SIDECAR_PASS`.
7. A record of old-key rejection and new-key SQLCipher integrity acceptance from the smoke log.
8. A scan of app-private database, WAL, SHM, rollback-journal, TEMP, cache, files, and preferences for the synthetic plaintext sentinels.

## ADB procedure

Replace `<apk>` with the APK downloaded from the exact-head GitHub Actions artifact.

```bash
sha256sum <apk>
adb devices
adb install -r <apk>
adb logcat -c
adb shell am start -n com.myfin.app/.MainActivity
adb logcat -d | grep 'MYFIN_ANDROID_SMOKE'
```

Wait for `MYFIN_ANDROID_SMOKE:ROTATION_PENDING`. Then force-stop and relaunch to exercise startup reconciliation:

```bash
adb shell am force-stop com.myfin.app
adb logcat -c
adb shell am start -n com.myfin.app/.MainActivity
adb logcat -d | grep 'MYFIN_ANDROID_SMOKE'
```

Wait for `MYFIN_ANDROID_SMOKE:BACKUP_READY`, then extract the encrypted backup before uninstalling:

```bash
adb exec-out run-as com.myfin.app cat files/myfin-smoke-backup.json > myfin-smoke-backup.json
```

Confirm the file contains the encrypted backup envelope header and does not contain `MYFIN_ANDROID_SMOKE_SENTINEL`. Then test a genuinely fresh app/Keystore installation:

```bash
adb uninstall com.myfin.app
adb install <apk>
adb shell run-as com.myfin.app sh -c 'cat > files/myfin-smoke-backup.json' < myfin-smoke-backup.json
adb logcat -c
adb shell am start -n com.myfin.app/.MainActivity
adb logcat -d | grep 'MYFIN_ANDROID_SMOKE'
```

Wait for both `MYFIN_ANDROID_SMOKE:SIDECAR_PASS` and `MYFIN_ANDROID_SMOKE:RESTORE_PASS`. The sidecar probe holds WAL, rollback-journal and TEMP activity open for a bounded inspection window.

For an app-private snapshot while the smoke app is reporting `SIDECAR_READY`:

```bash
adb exec-out run-as com.myfin.app sh -c 'cd /data/user/0/com.myfin.app && toybox tar -cf - .' > myfin-app-private.tar
```

Scan the archive for these exact byte strings; none may appear in any file:

- `MYFIN_WAL_SENTINEL`
- `MYFIN_JOURNAL_SENTINEL`
- `MYFIN_TEMP_SENTINEL_`
- `MYFIN_ANDROID_SMOKE_SENTINEL`

The archive should include the live database `-wal` and `-shm` files, the second database's `-journal` file, and a SQLite `etilqs_` TEMP file. Record filenames and hashes, not the database key or recovery passphrase.

## Restart and device-specific checks

- Repeat a normal force-stop/relaunch and confirm the active key persists.
- Reboot the handset and repeat startup reconciliation checks.
- Confirm the reported Keystore security level. TEE/StrongBox is a device capability result, not an assumption.
- Test lock/unlock and the device's configured biometric/PIN state; record any Keystore invalidation or authentication-bound behavior.
- Do not test app-data clearing or uninstall until the encrypted backup has been safely copied.
- Verify backup restoration on the same handset after uninstall/reinstall. Cross-device restore is a separate test and must not be inferred from same-device recovery.

## Acceptance

Physical-device verification is PASS only when the complete evidence set is captured on the actual handset, no plaintext sentinel is found in any inspected app-private file, the old key is rejected, the new key passes SQLCipher integrity verification, and fresh-install recovery succeeds. Any missing evidence is PARTIAL/NOT RUN. This protocol does not replace an independent security review.
