import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.myfin.app",
  appName: "MYFIN Android Storage Verification",
  webDir: "www",
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      iosIsEncryption: true
    }
  }
};

export default config;
