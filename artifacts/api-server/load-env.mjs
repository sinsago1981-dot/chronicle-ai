/**
 * Cross-platform .env loader — works with any Node 16+, Windows/Linux/macOS.
 * This file is NOT bundled by esbuild. It runs directly via `node ./load-env.mjs`
 * and dynamically imports the compiled bundle after loading environment variables.
 */
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Root .env is at ../../.env relative to artifacts/api-server/
const envPath = resolve(__dirname, "../../.env");

if (existsSync(envPath)) {
  const { config } = await import("dotenv");
  config({ path: envPath, override: false });
}

// Default NODE_ENV to development if not explicitly set
process.env.NODE_ENV ??= "development";

// Start the server
await import("./dist/index.mjs");
