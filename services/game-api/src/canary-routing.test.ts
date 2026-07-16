import type { RoomSnapshot } from "@paint-arena/shared";
import { describe, expect, it } from "vitest";
import { createGameServer } from "./server.js";

const authHeaders = {
  authorization: "Bearer test-admin",
  "content-type": "application/json",
};

describe("release-channel routing", () => {
  it("creates canary rooms on the dedicated authority and returns its Socket.IO path", async () => {
    const canary = createGameServer({
      adminToken: "test-admin",
      releaseChannel: "canary",
      broadcastMode: "full",
      socketPath: "/socket/canary",
      canarySocketPath: "/socket/canary",
      partitionRoomsByRelease: true,
    });
    const runningCanary = await canary.start(0, "127.0.0.1");
    const stable = createGameServer({
      adminToken: "test-admin",
      releaseChannel: "stable",
      canaryApiUrl: runningCanary.url,
      canarySocketPath: "/socket/canary",
      partitionRoomsByRelease: true,
    });
    const runningStable = await stable.start(0, "127.0.0.1");

    try {
      const createResponse = await fetch(`${runningStable.url}/api/rooms`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ releaseChannel: "canary", durationSeconds: 30, gridWidth: 40 }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { room: RoomSnapshot; socketPath: string; joinUrl: string };
      expect(created.room.config.releaseChannel).toBe("canary");
      expect(created.room.server.releaseChannel).toBe("canary");
      expect(created.room.server.broadcastMode).toBe("full");
      expect(created.socketPath).toBe("/socket/canary");
      expect(new URL(created.joinUrl).origin).toBe(runningStable.url);

      const canaryRoom = await fetch(`${runningCanary.url}/api/rooms/${created.room.roomCode}`);
      expect(canaryRoom.status).toBe(200);
      const connection = await fetch(`${runningCanary.url}/api/rooms/${created.room.roomCode}/join`, { method: "POST" });
      expect(connection.status).toBe(200);
      expect((await connection.json() as { socketPath: string }).socketPath).toBe("/socket/canary");

      const telemetry = await fetch(`${runningStable.url}/api/ops?releaseChannel=canary`);
      expect(telemetry.status).toBe(200);
      expect((await telemetry.json() as { server: { identity: { releaseChannel: string } } }).server.identity.releaseChannel).toBe("canary");
    } finally {
      await stable.stop();
      await canary.stop();
    }
  });

  it("keeps a logical canary room on the stable socket path when no dedicated route is configured", async () => {
    const stable = createGameServer({ adminToken: "test-admin", releaseChannel: "stable" });
    const runningStable = await stable.start(0, "127.0.0.1");

    try {
      const createResponse = await fetch(`${runningStable.url}/api/rooms`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ releaseChannel: "canary", durationSeconds: 30, gridWidth: 40 }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { room: RoomSnapshot; socketPath: string };
      expect(created.room.config.releaseChannel).toBe("canary");
      expect(created.socketPath).toBe("/socket.io");
    } finally {
      await stable.stop();
    }
  });
});
