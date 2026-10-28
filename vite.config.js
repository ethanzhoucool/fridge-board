import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// `npm run demo` swaps Supabase for an in-memory fake so the UI can be previewed signed out.
export default defineConfig(({ mode }) => ({
  resolve: mode === "demo" ? { alias: { "@supabase/supabase-js": fileURLToPath(new URL("./dev/fake-supabase.js", import.meta.url)) } } : {},
}));
