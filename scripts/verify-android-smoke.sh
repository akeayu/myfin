#!/usr/bin/env bash
set -euo pipefail

adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am start -n com.myfin.app/.MainActivity

passed=0
for attempt in $(seq 1 90); do
  if adb logcat -d | grep -q "MYFIN_ANDROID_SMOKE:PASS"; then
    passed=1
    break
  fi
  if adb logcat -d | grep -q "MYFIN_ANDROID_SMOKE:FAIL"; then
    adb logcat -d | tail -n 250
    exit 1
  fi
  sleep 2
done

if [ "$passed" -ne 1 ]; then
  adb logcat -d | tail -n 250
  echo "Android smoke test did not report PASS within 180 seconds." >&2
  exit 1
fi

adb shell run-as com.myfin.app ls -l databases
adb exec-out run-as com.myfin.app cat databases/myfin_android_smokeSQLite.db > /tmp/myfin-android-smoke.db
python3 - <<'PY'
from pathlib import Path

data = Path("/tmp/myfin-android-smoke.db").read_bytes()
assert len(data) > 4096, f"database unexpectedly small: {len(data)} bytes"
assert data[:16] != (b"SQLite format 3" + bytes([0])), "database has a plaintext SQLite header"
assert b"MYFIN_ANDROID_SMOKE_SENTINEL" not in data, "synthetic plaintext marker found in database file"
print(f"PASS: encrypted database inspected ({len(data)} bytes); plaintext SQLite header and sentinel absent")
PY
