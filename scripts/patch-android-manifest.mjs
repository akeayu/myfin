import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const pluginSource = "native/android/MyfinKeyVaultPlugin.java";
const pluginTarget = "android/app/src/main/java/com/myfin/app/MyfinKeyVaultPlugin.java";
await mkdir(dirname(pluginTarget), { recursive: true });
await copyFile(pluginSource, pluginTarget);

const activityPath = "android/app/src/main/java/com/myfin/app/MainActivity.java";
let activity = await readFile(activityPath, "utf8");
if (!activity.includes("MyfinKeyVaultPlugin.class")) {
  activity = activity.replace(
    /public class MainActivity extends BridgeActivity\s*\{/,
    "public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(MyfinKeyVaultPlugin.class);\n        super.onCreate(savedInstanceState);\n    }"
  );
  await writeFile(activityPath, activity);
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
