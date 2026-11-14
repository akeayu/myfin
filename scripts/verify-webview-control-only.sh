#!/usr/bin/env bash
set -euo pipefail
set -x

CONTROL_APK="build/webview-control/app/build/outputs/apk/debug/app-debug.apk"
CONTROL_PACKAGE="org.myfin.webviewcontrol"
MARKER="MYFIN_WEBVIEW_CONTROL_JS_EXECUTED"

timeout 180s adb wait-for-device
timeout 180s adb shell 'until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done'

echo "===== SECOND-IMAGE DEVICE IDENTITY ====="
adb shell getprop ro.build.fingerprint
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.cpu.abi
echo "===== SECOND-IMAGE WEBVIEW PROVIDER ====="
timeout 30s adb shell dumpsys webviewupdate
echo "===== INSTALLED WEBVIEW PROVIDER PACKAGES ====="
timeout 30s adb shell pm list packages -f | grep -Ei 'webview|chrome' || true
for package in com.android.webview com.google.android.webview com.google.android.webview.beta com.chrome.beta com.android.chrome; do
  timeout 20s adb shell dumpsys package "$package" 2>/dev/null | grep -E 'Package \[|versionName=|versionCode=' | head -n 8 || true
done

test -s "$CONTROL_APK"
echo "===== STANDALONE CONTROL APK SHA-256 ====="
sha256sum "$CONTROL_APK"
timeout 240s adb install -r "$CONTROL_APK"
timeout 60s adb logcat -c
timeout 120s adb shell am start -n "$CONTROL_PACKAGE/.MainActivity"

seen=0
for attempt in $(seq 1 90); do
  log="$(timeout 20s adb logcat -d -v brief -t 4000 2>/dev/null || true)"
  if grep -Fq "$MARKER" <<<"$log"; then
    seen=1
    break
  fi
  if [ "$attempt" -ge 10 ] && ! timeout 10s adb shell pidof "$CONTROL_PACKAGE" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if [ "$seen" -ne 1 ]; then
  echo "FAIL: standalone WebView control did not emit its JavaScript execution marker."
  timeout 30s adb shell dumpsys activity exit-info "$CONTROL_PACKAGE" 2>&1 | tail -n 120 || true
  timeout 30s adb shell dumpsys webviewupdate 2>&1 || true
  timeout 30s adb logcat -b crash -d -v threadtime 2>&1 | tail -n 300 || true
  timeout 30s adb logcat -b all -d -v threadtime -t 12000 2>&1 | grep -Ei 'webview|chromium|crash|fatal|sigtrap|org[.]myfin|renderer|tombstone|libc|DEBUG' | tail -n 1000 || true
  exit 1
fi

echo "PASS: standalone WebView control emitted the JavaScript execution marker."
sleep 10
if timeout 10s adb shell pidof "$CONTROL_PACKAGE" >/dev/null 2>&1; then
  echo "PASS: standalone control process and renderer host remained alive for 10 seconds."
else
  echo "FAIL: standalone control process exited after JavaScript execution."
  timeout 30s adb logcat -b crash -d -v threadtime 2>&1 | tail -n 300 || true
  exit 1
fi

timeout 60s adb shell am force-stop "$CONTROL_PACKAGE"
echo "PASS: second-image standalone WebView control test completed."
