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
const missingRegistrations = requiredRegistrations
  .filter(([className]) => !activity.includes(className))
  .map(([, statement]) => "        " + statement);
if (missingRegistrations.length > 0) {
  const onCreate = [
    "    @Override",
    "    public void onCreate(android.os.Bundle savedInstanceState) {",
    ...missingRegistrations,
    "        super.onCreate(savedInstanceState);",
    "    }"
  ].join("\\n");
  const classPattern = /public class MainActivity extends BridgeActivity\\s*\\{/;
  if (!classPattern.test(activity)) throw new Error("Capacitor MainActivity class declaration not found.");
  activity = activity.replace(classPattern, match => match + "\\n" + onCreate);
  await writeFile(activityPath, activity);
}



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
