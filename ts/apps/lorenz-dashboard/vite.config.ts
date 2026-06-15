import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Resolve workspace value imports from source: the package exports map
      // points at dist/, which does not exist yet when this build runs on a
      // fresh checkout (pnpm build runs vite before tsc --build).
      "@lorenz/traceviz-server/stats": fileURLToPath(
        new URL("../../packages/traceviz-server/src/stats.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4040",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:4040",
        ws: true,
      },
    },
  },
});
