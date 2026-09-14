import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Worker: the Git LFS API in src/http, and the admin UI served by TanStack Start under /_admin.
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // Server functions live under /_admin too, so one Cloudflare Access application covers everything the UI calls.
    tanstackStart({ serverFns: { base: "/_admin/_serverFn" } }),
    react(),
  ],
});
