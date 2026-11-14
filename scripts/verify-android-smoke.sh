#!/usr/bin/env bash
set -euo pipefail
set -x

APK="android/app/build/outputs/apk/debug/app-debug.apk"
BACKUP="/tmp/myfin-separate-install-backup.json"

# Hosted Android emulators can take several minutes to service package-manager
# operations after a cold boot. Keep explicit bounds, but do not mistake slow
# emulator startup/install for a native SQLCipher failure.
timeout 180s adb wait-for-device
timeout 180s adb shell 'until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done'

diagnostic_snapshot() {
  local reason="\${1:-diagnostic}"
  set +x
  echo "===== MYFIN ANDROID DIAGNOSTICS: $reason ====="
  echo "===== DEVICE ====="
  timeout 20s adb get-state 2>&1 || true
  timeout 20s adb shell getprop sys.boot_completed 2>&1 || true
  echo "===== PACKAGE INSTALLATION STATE ====="
  timeout 20s adb shell pm path com.myfin.app 2>&1 || true
  timeout 20s adb shell dumpsys package com.myfin.app 2>&1 | grep -E 'Package \[|versionCode=|versionName=|codePath=|userId=|enabled=' | head -n 40 || true
  echo "===== PROCESS PID AND STATE ====="
  timeout 20s adb shell pidof com.myfin.app 2>&1 || true
  timeout 20s adb shell ps -A 2>&1 | grep -E 'com[.]myfin|webview|sandboxed_process' | tail -n 80 || true
  echo "===== ACTIVITY / FOREGROUND ====="
  timeout 20s adb shell dumpsys activity activities 2>&1 | grep -E 'mResumedActivity|topResumedActivity|com[.]myfin' | tail -n 100 || true
  timeout 20s adb shell dumpsys window windows 2>&1 | grep -E 'mCurrentFocus|mFocusedApp|com[.]myfin' | tail -n 80 || true
  echo "===== PROCESS EXIT HISTORY ====="
  timeout 20s adb shell dumpsys activity exit-info com.myfin.app 2>&1 | tail -n 100 || true
  echo "===== WEBVIEW PROVIDER ====="
  timeout 20s adb shell dumpsys webviewupdate 2>&1 | tail -n 100 || true
  echo "===== RUNTIME LOGCAT ====="
  timeout 30s adb logcat -b all -d -v threadtime -t 12000 2>&1 | grep -E 'MYFIN_ANDROID_SMOKE|com[.]myfin|Capacitor|chromium|Cr_WebView|WebView|AndroidRuntime|FATAL EXCEPTION|ActivityTaskManager|ActivityManager|PluginManager|Console' | tail -n 1500 || true
  echo "===== END DIAGNOSTICS ====="
  set -x
}

wait_for_marker() {
  local marker="$1"
  set +x
  for attempt in $(seq 1 180); do
    local log
    log="$(timeout 20s adb logcat -d -t 3000 2>/dev/null || true)"
    if grep -q "$marker" <<<"$log"; then set -x; return 0; fi
    if grep -q "MYFIN_ANDROID_SMOKE:FAIL" <<<"$log"; then
      diagnostic_snapshot "application failure while waiting for $marker"
      set -x
      printf '%s\n' "$log" | tail -n 350
      return 1
    fi
    sleep 2
  done
  local log
  log="$(timeout 60s adb logcat -d -t 1500 2>/dev/null || true)"
  diagnostic_snapshot "timeout waiting for $marker"
  set -x
  printf '%s\n' "$log" | tail -n 350
  echo "Timed out waiting for $marker" >&2
  return 1
}

set +e
install_output="$(timeout 240s adb install -r "$APK" 2>&1)"
install_rc=$?
set -e
printf '%s\n' "$install_output"
echo "MYFIN_ADB_INSTALL_EXIT_CODE=$install_rc"
echo "===== PACKAGE STATE AFTER INSTALL ====="
timeout 30s adb shell pm path com.myfin.app 2>&1 || true
timeout 30s adb shell dumpsys package com.myfin.app 2>&1 | grep -E 'Package \[|versionCode=|versionName=|codePath=|userId=|enabled=' | head -n 40 || true
if [ "$install_rc" -ne 0 ]; then
  diagnostic_snapshot "adb install exit code $install_rc"
  exit "$install_rc"
fi

timeout 60s adb logcat -c
set +e
start_output="$(timeout 120s adb shell am start -W -n com.myfin.app/.MainActivity 2>&1)"
start_rc=$?
set -e
printf '%s\n' "$start_output"
echo "MYFIN_AM_START_EXIT_CODE=$start_rc"
echo "===== IMMEDIATE POST-LAUNCH SNAPSHOT ====="
diagnostic_snapshot "immediately after am start"
if [ "$start_rc" -ne 0 ]; then
  diagnostic_snapshot "am start exit code $start_rc"
  exit "$start_rc"
fi
wait_for_marker "MYFIN_ANDROID_SMOKE:NATIVE_ACTIVITY_ONCREATE"
wait_for_marker "MYFIN_ANDROID_SMOKE:NATIVE_ACTIVITY_ONRESUME"
wait_for_marker "MYFIN_ANDROID_SMOKE:JS_ENTRY_EXECUTED"
wait_for_marker "MYFIN_ANDROID_SMOKE:CHECKPOINT WEBVIEW_CAPACITOR_READY"
wait_for_marker "MYFIN_ANDROID_SMOKE:NATIVE_PLUGIN_BRIDGE_READY"
wait_for_marker "MYFIN_ANDROID_SMOKE:CHECKPOINT RUN_ENTERED"
# First installation creates an encrypted, portable backup in app-private files.
wait_for_marker "MYFIN_ANDROID_SMOKE:ROTATION_PENDING"
timeout 120s adb shell am force-stop com.myfin.app
timeout 60s adb logcat -c
timeout 120s adb shell am start -n com.myfin.app/.MainActivity
wait_for_marker "MYFIN_ANDROID_SMOKE:BACKUP_READY"
timeout 120s adb exec-out run-as com.myfin.app cat files/myfin-smoke-backup.json > "$BACKUP"
python3 - <<'PY'
from pathlib import Path
data = Path("/tmp/myfin-separate-install-backup.json").read_text()
assert "MYFIN-ENCRYPTED-BACKUP" in data, "backup envelope header missing"
assert "MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "plaintext marker leaked into backup file"
print(f"PASS: portable backup staged ({len(data)} characters); synthetic plaintext absent")
PY

# Uninstall removes the original app data and Android Keystore namespace.
timeout 180s adb uninstall com.myfin.app
timeout 240s adb install "$APK"
timeout 120s adb shell run-as com.myfin.app sh -c 'cat > files/myfin-smoke-backup.json' < "$BACKUP"
timeout 60s adb logcat -c
timeout 120s adb shell am start -n com.myfin.app/.MainActivity

# The second installation must restore the SQLCipher DB and wrap its key with
# the new installation's Android Keystore key, using only the encrypted backup.
# Snapshot app-private files while WAL, rollback-journal and TEMP probes are live.
wait_for_marker "MYFIN_ANDROID_SMOKE:SIDECAR_READY"
timeout 120s adb exec-out run-as com.myfin.app sh -c 'cd /data/user/0/com.myfin.app && toybox tar -cf - .' > /tmp/myfin-app-private.tar
python3 - <<'PY'
from pathlib import Path
import tarfile

archive_path = Path("/tmp/myfin-app-private.tar")
assert archive_path.stat().st_size > 4096, "app-private snapshot is unexpectedly small"
with tarfile.open(archive_path, "r:") as archive:
    members = [item for item in archive.getmembers() if item.isfile()]
    names = [item.name for item in members]
    required = [
        "databases/myfin_android_smokeSQLite.db-wal",
        "databases/myfin_android_smokeSQLite.db-shm",
        "databases/myfin_journal_smokeSQLite.db-journal",
    ]
    for suffix in required:
        assert any(name.endswith(suffix) for name in names), f"expected live sidecar missing: {suffix}"
    temp_files = [name for name in names if "etilqs_" in name.lower()]
    assert temp_files, "SQLite file-backed TEMP database file was not found in app-private storage"
    sentinels = (b"MYFIN_WAL_SENTINEL", b"MYFIN_JOURNAL_SENTINEL", b"MYFIN_TEMP_SENTINEL_")
    leaks = []
    for member in members:
        stream = archive.extractfile(member)
        if stream is None:
            continue
        payload = stream.read()
        for sentinel in sentinels:
            if sentinel in payload:
                leaks.append((member.name, sentinel.decode("ascii")))
    assert not leaks, f"plaintext sentinel leaked into app-private file(s): {leaks}"
    print(f"PASS: inspected {len(members)} app-private files; WAL, SHM, rollback journal and TEMP file present; no sentinel plaintext found")
    print("TEMP files: " + ", ".join(temp_files[:10]))
PY
wait_for_marker "MYFIN_ANDROID_SMOKE:SIDECAR_PASS"
wait_for_marker "MYFIN_ANDROID_SMOKE:RESTORE_PASS"
timeout 120s adb shell run-as com.myfin.app ls -l databases
timeout 120s adb exec-out run-as com.myfin.app cat databases/myfin_android_smokeSQLite.db > /tmp/myfin-android-smoke.db
python3 - <<'PY'
from pathlib import Path
data = Path("/tmp/myfin-android-smoke.db").read_bytes()
assert len(data) > 4096, f"database unexpectedly small: {len(data)} bytes"
assert data[:16] != (b"SQLite format 3" + bytes([0])), "database has a plaintext SQLite header"
assert b"MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "synthetic plaintext marker found in database file"
print(f"PASS: separate-install restored database is encrypted ({len(data)} bytes); plaintext SQLite header and sentinel absent")
PY
