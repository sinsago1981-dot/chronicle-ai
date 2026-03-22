import app from "./app";
import { logger } from "./lib/logger";

const port = Number(process.env.PORT || 10000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

app.listen(port, "0.0.0.0", () => {
  logger.info({ port, env: process.env.NODE_ENV }, "Server listening");
});
