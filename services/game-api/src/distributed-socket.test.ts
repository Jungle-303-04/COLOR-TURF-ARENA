import type { InputResult, JoinResult, RoomSnapshot, StateDelta } from "@paint-arena/shared";
import { createClient as createRedisClient } from "redis";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGameServer } from "./server.js";

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

const emitAck = <T>(socket: Socket, event: string, payload: unknown): Promise<T> => (
  new Promise((resolve) => socket.emit(event, payload, (result: T) => resolve(result)))
);

describeRedis("Redis-backed multi-replica room gateway", () => {
  const sockets: Socket[] = [];
  const stops: Array<() => Promise<void>> = [];
  const originalBotGatewayUrl = process.env.BOT_GATEWAY_URL;

  beforeEach(async () => {
    const redis = createRedisClient({ url: redisUrl });
    await redis.connect();
    await redis.flushDb();
    await redis.quit();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    for (const stop of stops.splice(0).reverse()) await stop();
    if (originalBotGatewayUrl === undefined) delete process.env.BOT_GATEWAY_URL;
    else process.env.BOT_GATEWAY_URL = originalBotGatewayUrl;
  });

  it("accepts a player on a non-owner pod and broadcasts authoritative deltas back", async () => {
    const authority = createGameServer({
      redisUrl,
      podName: "game-server-a",
      adminToken: "test-admin",
      opsEventToken: "test-ops",
      snapshotIntervalMs: 250,
    });
    const runningAuthority = await authority.start(0, "127.0.0.1");
    const authorityStop = authority.stop;
    stops.push(authorityStop);

    const createResponse = await fetch(`${runningAuthority.url}/api/rooms`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ durationSeconds: 30, gridWidth: 40 }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { room: RoomSnapshot };

    const authorityController = createSocketClient(runningAuthority.url, {
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(authorityController);
    await new Promise<void>((resolve) => authorityController.once("connect", resolve));
    expect((await emitAck<JoinResult>(authorityController, "room.join", {
      roomCode: created.room.roomCode,
      sessionId: "session-authority-pod",
      nickname: "Authority Pod",
    })).ok).toBe(true);

    const gateway = createGameServer({
      redisUrl,
      podName: "game-server-b",
      adminToken: "test-admin",
      opsEventToken: "test-ops",
      snapshotIntervalMs: 250,
    });
    const runningGateway = await gateway.start(0, "127.0.0.1");
    stops.push(gateway.stop);

    const controller = createSocketClient(runningGateway.url, {
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(controller);
    await new Promise<void>((resolve) => controller.once("connect", resolve));

    const join = await emitAck<JoinResult>(controller, "room.join", {
      roomCode: created.room.roomCode,
      sessionId: "session-cross-pod",
      nickname: "Cross Pod",
    });
    expect(join.ok).toBe(true);
    expect(join.player?.nickname).toBe("Cross Pod");

    const startResponse = await fetch(
      `${runningGateway.url}/api/admin/rooms/${created.room.roomCode}/start`,
      { method: "POST", headers: { authorization: "Bearer test-admin" } },
    );
    expect(startResponse.status).toBe(200);

    const deltaPromise = new Promise<StateDelta>((resolve) => controller.once("state_delta", resolve));
    const authorityDeltaPromise = new Promise<StateDelta>((resolve) => authorityController.once("state_delta", resolve));
    const input = await emitAck<InputResult>(controller, "game.input", {
      roomCode: created.room.roomCode,
      sessionId: "session-cross-pod",
      sequence: 1,
      sentAt: Date.now(),
      direction: { x: 1, y: 0 },
    });
    expect(input.ok).toBe(true);
    const delta = await deltaPromise;
    const authorityDelta = await authorityDeltaPromise;
    expect(delta.roomCode).toBe(created.room.roomCode);
    expect(delta.players.some((player) => player.id === "session-cross-pod")).toBe(true);
    expect(authorityDelta.sequence).toBe(delta.sequence);

    const authorityOps = await (await fetch(`${runningAuthority.url}/api/ops`)).json() as {
      server: { connectedSockets: number };
    };
    const gatewayOps = await (await fetch(`${runningGateway.url}/api/ops`)).json() as {
      server: { connectedSockets: number };
    };
    expect(authorityOps.server.connectedSockets).toBe(1);
    expect(gatewayOps.server.connectedSockets).toBe(1);

    process.env.BOT_GATEWAY_URL = runningGateway.url;
    const botsResponse = await fetch(
      `${runningGateway.url}/api/admin/rooms/${created.room.roomCode}/bots`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ action: "add", count: 2 }),
      },
    );
    expect(botsResponse.status).toBe(200);
    expect(((await botsResponse.json()) as { count: number }).count).toBe(2);
    const botsJoinedDeadline = Date.now() + 3_000;
    let botsJoined = 0;
    while (Date.now() < botsJoinedDeadline) {
      const current = await (await fetch(`${runningGateway.url}/api/rooms/${created.room.roomCode}`)).json() as { room: RoomSnapshot };
      botsJoined = current.room.players.filter((player) => player.isBot && player.connected).length;
      if (botsJoined === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(botsJoined).toBe(2);

    for (const event of [
      { type: "PRIMARY_UNHEALTHY", message: "Primary health check failed", cluster: "primary" },
      { type: "FAILOVER_STARTED", message: "Routing traffic to DR", cluster: "dr" },
    ]) {
      const response = await fetch(`${runningAuthority.url}/api/ops/events`, {
        method: "POST",
        headers: { authorization: "Bearer test-ops", "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      expect(response.status).toBe(202);
    }

    await authorityStop();
    stops.splice(stops.indexOf(authorityStop), 1);

    const deadline = Date.now() + 6_000;
    let recovered: RoomSnapshot | null = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${runningGateway.url}/api/rooms/${created.room.roomCode}`);
      if (response.ok) {
        recovered = ((await response.json()) as { room: RoomSnapshot }).room;
        const connectedBots = recovered.players.filter((player) => player.isBot && player.connected).length;
        if (recovered.server.podName === "game-server-b" && connectedBots === 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(recovered?.server.podName).toBe("game-server-b");
    expect(recovered?.players.filter((player) => player.isBot && player.connected)).toHaveLength(2);
    expect(controller.connected).toBe(true);

    const drOps = await (await fetch(`${runningGateway.url}/api/ops`)).json() as {
      recentEvents: Array<{ type: string; message: string }>;
    };
    expect(drOps.recentEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      "PRIMARY_UNHEALTHY",
      "FAILOVER_STARTED",
    ]));
    const drTimeline = await (await fetch(`${runningGateway.url}/api/ops/events`)).json() as {
      events: Array<{ type: string }>;
    };
    expect(drTimeline.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "PRIMARY_UNHEALTHY",
      "FAILOVER_STARTED",
    ]));

    const continued = await emitAck<InputResult>(controller, "game.input", {
      roomCode: created.room.roomCode,
      sessionId: "session-cross-pod",
      sequence: 2,
      sentAt: Date.now(),
      direction: { x: 0, y: 1 },
    });
    expect(continued.ok).toBe(true);
  }, 20_000);
});
