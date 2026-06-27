import { defineConfig } from "vite";

// Fully static, browser-side app. The dev server and preview both run on 3005
// (strictPort so a port clash fails loudly instead of silently moving).
export default defineConfig({
  server: { port: 3005, strictPort: true },
  preview: { port: 3005, strictPort: true },
});
