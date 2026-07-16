import { createGameServer } from "./server.js";

let server: ReturnType<typeof createGameServer>;
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "server.stopping", signal }));
  await server.stop();
  if (process.env.NODE_ENV !== "test") process.exit(0);
};

server = createGameServer({
  onDemoServerShutdown: ({ reason }) => shutdown(`ADMIN_DEMO_SHUTDOWN: ${reason}`),
});

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

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
