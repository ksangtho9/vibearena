import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Root is the client/ directory; the repo-level `npm run dev` points at this
// config explicitly. /api is proxied to the Express key-holding server so the
// browser never talks to the LLM provider directly.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
