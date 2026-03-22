import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);
const basePath = process.env.BASE_PATH || "/";
const outDir = process.env.VITE_OUT_DIR
  ? path.resolve(import.meta.dirname, process.env.VITE_OUT_DIR)
  : path.resolve(import.meta.dirname, "dist/public");

const devPlugins = !isProduction && process.env.REPL_ID
  ? [
      await import("@replit/vite-plugin-runtime-error-modal").then((m) => m.default()),
      await import("@replit/vite-plugin-cartographer").then((m) =>
        m.cartographer({ root: path.resolve(import.meta.dirname, "..") }),
      ),
      await import("@replit/vite-plugin-dev-banner").then((m) => m.devBanner()),
    ]
  : [];

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss(), ...devPlugins],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          motion: ["framer-motion"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: { strict: true, deny: ["**/.*"] },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
