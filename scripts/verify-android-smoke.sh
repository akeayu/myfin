#!/usr/bin/env bash
set -euo pipefail
set -x

APK="android/app/build/outputs/apk/debug/app-debug.apk"
BACKUP="/tmp/myfin-separate-install-backup.json"

timeout 60s adb wait-for-device
timeout 60s adb shell 'until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done'
timeout 60s adb install -r "$APK"
timeout 30s adb logcat -c
timeout 30s adb shell am start -n com.myfin.app/.MainActivity

wait_for_marker() {
  local marker="$1"
  for attempt in $(seq 1 120); do
    local log
    log="$(timeout 15s adb logcat -d 2>/dev/null || true)"
    if grep -q "$marker" <<<"$log"; then return 0; fi
    if grep -q "MYFIN_ANDROID_SMOKE:FAIL" <<<"$log" || grep -q "FATAL EXCEPTION" <<<"$log"; then
      printf '%s\n' "$log" | tail -n 350
      return 1
    fi
    sleep 2
  done
  timeout 30s adb logcat -d | tail -n 350
  echo "Timed out waiting for $marker" >&2
  return 1
}

# First installation creates an encrypted, portable backup in app-private files.
wait_for_marker "MYFIN_ANDROID_SMOKE:BACKUP_READY"
timeout 30s adb exec-out run-as com.myfin.app cat files/myfin-smoke-backup.json > "$BACKUP"
python3 - <<'PY'
from pathlib import Path
data = Path("/tmp/myfin-separate-install-backup.json").read_text()
assert "MYFIN-ENCRYPTED-BACKUP" in data, "backup envelope header missing"
assert "MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "plaintext marker leaked into backup file"
print(f"PASS: portable backup staged ({len(data)} characters); synthetic plaintext absent")
PY

# Uninstall removes the original app data and Android Keystore namespace.
timeout 60s adb uninstall com.myfin.app
timeout 60s adb install "$APK"
timeout 30s adb shell run-as com.myfin.app sh -c 'cat > files/myfin-smoke-backup.json' < "$BACKUP"
timeout 30s adb logcat -c
timeout 30s adb shell am start -n com.myfin.app/.MainActivity

# The second installation must restore the SQLCipher DB and wrap its key with
# the new installation's Android Keystore key, using only the encrypted backup.
wait_for_marker "MYFIN_ANDROID_SMOKE:RESTORE_PASS"
timeout 30s adb shell run-as com.myfin.app ls -l databases
timeout 30s adb exec-out run-as com.myfin.app cat databases/myfin_android_smokeSQLite.db > /tmp/myfin-android-smoke.db
python3 - <<'PY'
from pathlib import Path
data = Path("/tmp/myfin-android-smoke.db").read_bytes()
assert len(data) > 4096, f"database unexpectedly small: {len(data)} bytes"
assert data[:16] != (b"SQLite format 3" + bytes([0])), "database has a plaintext SQLite header"
assert b"MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "synthetic plaintext marker found in database file"
print(f"PASS: separate-install restored database is encrypted ({len(data)} bytes); plaintext SQLite header and sentinel absent")
PY
