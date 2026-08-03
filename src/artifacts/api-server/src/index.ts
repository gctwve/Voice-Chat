import { createServer } from "node:http";
import app from "./app";
import { setupVoiceChat } from "./voiceChat";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
setupVoiceChat(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});
