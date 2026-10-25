import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
