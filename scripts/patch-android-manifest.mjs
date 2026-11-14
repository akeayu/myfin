import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const pluginSource = "native/android/MyfinKeyVaultPlugin.java";
const pluginTarget = "android/app/src/main/java/com/myfin/app/MyfinKeyVaultPlugin.java";
const smokePluginSource = "native/android/MyfinSmokeMarkerPlugin.java";
const smokePluginTarget = "android/app/src/main/java/com/myfin/app/MyfinSmokeMarkerPlugin.java";
await mkdir(dirname(pluginTarget), { recursive: true });
await copyFile(pluginSource, pluginTarget);
await copyFile(smokePluginSource, smokePluginTarget);

const activityPath = "android/app/src/main/java/com/myfin/app/MainActivity.java";
let activity = await readFile(activityPath, "utf8");
const requiredRegistrations = [
  ["MyfinKeyVaultPlugin.class", "registerPlugin(MyfinKeyVaultPlugin.class);"],
  ["MyfinSmokeMarkerPlugin.class", "registerPlugin(MyfinSmokeMarkerPlugin.class);"]
];
const classPattern = /public class MainActivity extends BridgeActivity\s*\{/;
if (!classPattern.test(activity)) throw new Error("Capacitor MainActivity class declaration not found.");

const onCreatePattern = /public\s+void\s+onCreate\s*\([^)]*\)\s*\{/;
let onCreate = onCreatePattern.exec(activity);
if (!onCreate) {
  const generated = [
    "    @Override",
    "    public void onCreate(android.os.Bundle savedInstanceState) {",
    '        android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONCREATE");',
    ...requiredRegistrations.map(([, statement]) => "        " + statement),
    "        super.onCreate(savedInstanceState);",
    "    }"
  ].join("\n");
  activity = activity.replace(classPattern, match => match + "\n" + generated);
} else {
  const bodyStart = onCreate.index + onCreate[0].length;
  const insertions = [];
  if (!activity.includes("NATIVE_ACTIVITY_ONCREATE")) {
    insertions.push('        android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONCREATE");');
  }
  for (const [className, statement] of requiredRegistrations) {
    if (!activity.includes(className)) insertions.push("        " + statement);
  }
  if (insertions.length) {
    const superCall = /super\s*\.\s*onCreate\s*\([^)]*\)\s*;/;
    if (superCall.test(activity)) {
      activity = activity.replace(superCall, match => insertions.join("\n") + "\n        " + match);
    } else {
      activity = activity.slice(0, bodyStart) + "\n" + insertions.join("\n") + activity.slice(bodyStart);
    }
  }
}

// These markers are emitted by Android Activity callbacks directly, independently
// of Capacitor, WebView JavaScript, or plugin registration.
const lifecycle = [
  ["onStart", 'android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONSTART");'],
  ["onResume", 'android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONRESUME");'],
  ["onPause", 'android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONPAUSE");'],
  ["onStop", 'android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONSTOP");'],
  ["onDestroy", 'android.util.Log.i("MYFIN_ANDROID_SMOKE", "NATIVE_ACTIVITY_ONDESTROY");']
];
for (const [name, marker] of lifecycle) {
  const signature = new RegExp("public\\s+void\\s+" + name + "\\s*\\(");
  if (!signature.test(activity)) {
    const callback = name === "onStart" || name === "onResume"
      ? "        super." + name + "();\n        " + marker
      : "        " + marker + "\n        super." + name + "();";
    const method = "    @Override\n    public void " + name + "() {\n" + callback + "\n    }";
    activity = activity.replace(/\n}\s*$/, "\n" + method + "\n}\n");
  } else if (!activity.includes("NATIVE_ACTIVITY_" + name.toUpperCase())) {
    const methodStart = signature.exec(activity);
    const openBrace = activity.indexOf("{", methodStart.index) + 1;
    activity = activity.slice(0, openBrace) + "\n        " + marker + activity.slice(openBrace);
  }
}
await writeFile(activityPath, activity);
console.log("MYFIN generated MainActivity.java after patching:");
console.log(activity);
console.log("PASS: onCreate marker insertion is unconditional and plugin-registration independent.");

const appGradlePath = "android/app/build.gradle";
let appGradle = await readFile(appGradlePath, "utf8");
const nativeDependencies = [
  "    implementation 'net.zetetic:sqlcipher-android:4.17.0@aar'",
  '    implementation "androidx.sqlite:sqlite:2.4.0"'
];
const missingNativeDependencies = nativeDependencies.filter(line => !appGradle.includes(line));
if (missingNativeDependencies.length > 0) {
  if (!/dependencies\s*\{/.test(appGradle)) throw new Error("Android app dependencies block not found.");
  appGradle = appGradle.replace(/dependencies\s*\{/, match => match + "\n" + missingNativeDependencies.join("\n"));
  await writeFile(appGradlePath, appGradle);
}

const manifestPath = "android/app/src/main/AndroidManifest.xml";
let manifest = await readFile(manifestPath, "utf8");
const application = manifest.match(/<application\b[^>]*>/s);
if (!application) throw new Error("Android application manifest tag not found.");
let tag = application[0];
function setAttribute(name, value) {
  const expression = new RegExp(name + '="[^"]*"');
  tag = expression.test(tag) ? tag.replace(expression, name + '="' + value + '"') : tag.replace(/>$/, " " + name + '="' + value + '">');
}
setAttribute("android:allowBackup", "false");
setAttribute("android:fullBackupContent", "false");
setAttribute("android:dataExtractionRules", "@xml/data_extraction_rules");
manifest = manifest.replace(application[0], tag);
await writeFile(manifestPath, manifest);
const rulesPath = "android/app/src/main/res/xml/data_extraction_rules.xml";
await mkdir(dirname(rulesPath), { recursive: true });
const rules = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<data-extraction-rules>',
  '  <cloud-backup>',
  '    <exclude domain="root" />',
  '    <exclude domain="database" />',
  '    <exclude domain="sharedpref" />',
  '    <exclude domain="external" />',
  '  </cloud-backup>',
  '  <device-transfer>',
  '    <exclude domain="root" />',
  '    <exclude domain="database" />',
  '    <exclude domain="sharedpref" />',
  '    <exclude domain="external" />',
  '  </device-transfer>',
  '</data-extraction-rules>',
  ''
].join('\n');
await writeFile(rulesPath, rules);
console.log("Android backup defaults disabled; explicit encrypted export/recovery remains a separate MYFIN feature.");
