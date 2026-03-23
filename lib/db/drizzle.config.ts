import { defineConfig } from "drizzle-kit";
import path from "path";
import { config } from "dotenv";

// Load root .env when running locally (no-op if file doesn't exist or vars already set)
config({ path: path.resolve(import.meta.dirname, "../../.env"), override: false });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Create a .env file at the project root or set it in your environment.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
