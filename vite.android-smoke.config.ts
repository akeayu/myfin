import { defineConfig } from "vite";

export default defineConfig({
  root: "android-smoke",
  build: {
    outDir: "../www",
    emptyOutDir: true,
    target: "es2022"
  }
});
