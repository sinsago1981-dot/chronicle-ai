import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd    = process.env.NODE_ENV === "production";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    ...(isProd ? { level: "warn" } : {}),
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(
  cors({
    origin: isProd ? false : true,
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// API routes
app.use("/api", router);

// In production: serve the compiled Vite frontend
if (isProd) {
  const staticDir = path.join(__dirname, "public");
  app.use(express.static(staticDir, { maxAge: "1y", etag: true, index: false }));

  // SPA fallback — return index.html for all non-API routes (Express 5 syntax)
  app.get(/(.*)/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
