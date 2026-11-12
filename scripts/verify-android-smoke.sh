#!/usr/bin/env bash
set -euo pipefail
set -x

timeout 60s adb wait-for-device
timeout 60s adb shell 'until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done'
timeout 60s adb install -r android/app/build/outputs/apk/debug/app-debug.apk
timeout 30s adb logcat -c
timeout 30s adb shell am start -n com.myfin.app/.MainActivity

passed=0
for attempt in $(seq 1 90); do
  log="$(timeout 15s adb logcat -d -s System.out:I chromium:I Capacitor/Console:E AndroidRuntime:E '*:S' 2>/dev/null || true)"
  if grep -q "MYFIN_ANDROID_SMOKE:PASS" <<<"$log"; then
    passed=1
    break
  fi
  if grep -q "MYFIN_ANDROID_SMOKE:FAIL" <<<"$log" || grep -q "FATAL EXCEPTION" <<<"$log"; then
    printf '%s\n' "$log" | tail -n 300
    exit 1
  fi
  sleep 2
done

if [ "$passed" -ne 1 ]; then
  timeout 30s adb logcat -d | tail -n 300
  echo "Android smoke test did not report PASS within 180 seconds." >&2
  exit 1
fi

timeout 30s adb shell run-as com.myfin.app ls -l databases
timeout 30s adb exec-out run-as com.myfin.app cat databases/myfin_android_smokeSQLite.db > /tmp/myfin-android-smoke.db
python3 - <<'PY'
from pathlib import Path

data = Path("/tmp/myfin-android-smoke.db").read_bytes()
assert len(data) > 4096, f"database unexpectedly small: {len(data)} bytes"
assert data[:16] != (b"SQLite format 3" + bytes([0])), "database has a plaintext SQLite header"
assert b"MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "synthetic plaintext marker found in database file"
print(f"PASS: encrypted database inspected ({len(data)} bytes); plaintext SQLite header and sentinel absent")
PY
