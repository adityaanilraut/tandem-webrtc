import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import {
  certPath,
  keyPath,
  devEnvironment,
  WEB_PORT,
  SIGNAL_PORT,
} from "./server/environment.ts";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: WEB_PORT,
    strictPort: true,
    https: devEnvironment().localHttpsReady
      ? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
      : undefined,
    proxy: {
      "/api": { target: `http://127.0.0.1:${SIGNAL_PORT}` },
      "/ws": { target: `ws://127.0.0.1:${SIGNAL_PORT}`, ws: true },
    },
  },
});
