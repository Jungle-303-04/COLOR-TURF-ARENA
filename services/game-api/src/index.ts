import { createGameServer } from "./server.js";

const server = createGameServer();

server.start().then(({ port }) => {
  console.log(JSON.stringify({
    level: "info",
    event: "server.started",
    service: "paint-arena-game-api",
    port,
    version: process.env.APP_VERSION ?? "1.0.0",
  }));
}).catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    event: "server.start_failed",
    message: error instanceof Error ? error.message : "unknown error",
  }));
  process.exitCode = 1;
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: "info", event: "server.stopping", signal }));
  await server.stop();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

