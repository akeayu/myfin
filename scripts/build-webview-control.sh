#!/usr/bin/env bash
set -euo pipefail

# Build a genuinely separate Android application. It shares only the emulator
# and installed Android WebView provider with MYFIN; it has no MYFIN/Capacitor
# Gradle dependencies, package namespace, manifest, Application, SQLite or
# Keystore integration.
PROJECT="build/webview-control"
mkdir -p "$PROJECT/app/src/main/java/org/myfin/webviewcontrol" "$PROJECT/app/src/main/assets"

AGP_VERSION="$(sed -n "s/.*com.android.tools.build:gradle:\\([^'\" ]*\\).*/\\1/p" android/build.gradle | head -n 1)"
if [ -z "$AGP_VERSION" ]; then
  echo "Could not determine Android Gradle Plugin version from generated Capacitor project" >&2
  cat android/build.gradle >&2
  exit 1
fi
echo "Standalone WebView control using Android Gradle Plugin $AGP_VERSION"

cat > "$PROJECT/settings.gradle" <<'GRADLE'
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "MyfinWebViewControl"
include(":app")
GRADLE

cat > "$PROJECT/build.gradle" <<GRADLE
plugins {
    id 'com.android.application' version '$AGP_VERSION' apply false
}
GRADLE

cat > "$PROJECT/app/build.gradle" <<'GRADLE'
plugins {
    id 'com.android.application'
}
android {
    namespace 'org.myfin.webviewcontrol'
    compileSdk 35
    defaultConfig {
        applicationId 'org.myfin.webviewcontrol'
        minSdk 23
        targetSdk 35
        versionCode 1
        versionName '1.0'
    }
}
GRADLE

cat > "$PROJECT/app/src/main/AndroidManifest.xml" <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Standalone WebView Control" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:allowBackup="false">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
XML

cat > "$PROJECT/app/src/main/java/org/myfin/webviewcontrol/MainActivity.java" <<'JAVA'
package org.myfin.webviewcontrol;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public final class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i("WEBVIEW_CONTROL", "NATIVE_ACTIVITY_ONCREATE");
        webView = new WebView(this);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("WEBVIEW_CONTROL", message.message());
                return true;
            }
        });
        webView.getSettings().setJavaScriptEnabled(true);
        setContentView(webView);
        webView.loadUrl("file:///android_asset/webview-control.html");
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
JAVA

cp android-smoke/webview-control.html "$PROJECT/app/src/main/assets/webview-control.html"
chmod +x android/gradlew
./android/gradlew -p "$PROJECT" --no-daemon :app:assembleDebug
test -s "$PROJECT/app/build/outputs/apk/debug/app-debug.apk"
sha256sum "$PROJECT/app/build/outputs/apk/debug/app-debug.apk"
