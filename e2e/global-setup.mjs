import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createGameServer } from "../services/game-api/dist/server.js";

const webRoot = fileURLToPath(new URL("../apps/web", import.meta.url));
const host = "127.0.0.1";
const adminToken = "e2e-admin";

const reservePort = () => new Promise((resolve, reject) => {
  const server = createTcpServer();
  server.once("error", reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Unable to reserve an E2E web port"));
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve(address.port);
    });
  });
});

export default async function globalSetup() {
  const webPort = await reservePort();
  const webUrl = `http://${host}:${webPort}`;
  const gameServer = createGameServer({
    adminToken,
    opsEventToken: "e2e-ops",
    publicBaseUrl: webUrl,
    redisUrl: "",
    snapshotIntervalMs: 250,
    clusterName: "primary",
    podName: "playwright-e2e",
  });
  let webServer;

  try {
    const runningApi = await gameServer.start(0, host);
    webServer = await createViteServer({
      configFile: false,
      root: webRoot,
      plugins: [react()],
      logLevel: "silent",
      server: {
        host,
        port: webPort,
        strictPort: true,
        proxy: {
          "/api": runningApi.url,
          "/healthz": runningApi.url,
          "/readyz": runningApi.url,
          "/metrics": runningApi.url,
          "/socket.io": {
            target: runningApi.url,
            ws: true,
          },
        },
      },
    });
    await webServer.listen();
    process.env.E2E_BASE_URL = webUrl;
    process.env.E2E_ADMIN_TOKEN = adminToken;
  } catch (error) {
    await webServer?.close();
    await gameServer.stop();
    throw error;
  }

  return async () => {
    await webServer?.close();
    await gameServer.stop();
  };
}
