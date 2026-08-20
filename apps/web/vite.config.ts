import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/__drives3_share": "http://localhost:3000",
    },
  },
  build: {
    outDir: "../../dist/web",
    // Reserved prefix cannot be an S3 bucket name (underscore), so dashboard
    // assets never collide with path-style /{bucket}/{key} requests.
    assetsDir: "__drives3_assets",
    emptyOutDir: true,
  },
});
