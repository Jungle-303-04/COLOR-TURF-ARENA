import type {
  DemoChaosActionResponse,
  InputResult,
  JoinResult,
  OpsSnapshot,
  RoomSnapshot,
  StateDelta,
  WatchResult,
} from "@paint-arena/shared";
import { createClient as createRedisClient } from "redis";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  it("routes room-scoped ops and every chaos control to the current Redis lease owner", async () => {
    vi.stubEnv("ALLOW_DEMO_SERVER_SHUTDOWN", "true");
    const ownerShutdown = vi.fn();
    const gatewayShutdown = vi.fn();
    const owner = createGameServer({
      redisUrl,
      podName: "game-server-owner",
      adminToken: "test-admin",
      snapshotIntervalMs: 250,
      broadcastMode: "delta",
      demoTickDelayMs: 0,
      onDemoServerShutdown: ownerShutdown,
    });
    const runningOwner = await owner.start(0, "127.0.0.1");
    stops.push(owner.stop);
    const createResponse = await fetch(`${runningOwner.url}/api/rooms`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ durationSeconds: 30, gridWidth: 40 }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { room: RoomSnapshot };
    const roomCode = created.room.roomCode;

    const gateway = createGameServer({
      redisUrl,
      podName: "game-server-gateway",
      adminToken: "test-admin",
      snapshotIntervalMs: 250,
      broadcastMode: "delta",
      demoTickDelayMs: 0,
      onDemoServerShutdown: gatewayShutdown,
    });
    const runningGateway = await gateway.start(0, "127.0.0.1");
    stops.push(gateway.stop);

    const adminSocket = createSocketClient(runningGateway.url, {
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(adminSocket);
    await new Promise<void>((resolve) => adminSocket.once("connect", resolve));
    expect(await emitAck<{ ok: boolean }>(adminSocket, "admin_subscribe", { token: "test-admin" })).toEqual({ ok: true });
    const processAck = await new Promise<OpsSnapshot>((resolve) => adminSocket.emit("ops.watch", resolve));
    expect(processAck.server.identity.podName).toBe("game-server-gateway");
    expect(processAck.demoChaos.scope).toEqual({
      kind: "process",
      roomCode: null,
      podName: "game-server-gateway",
    });
    const initialOwnerStream = new Promise<OpsSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        adminSocket.off("ops.snapshot", handle);
        reject(new Error("Timed out waiting for admin.room.watch owner ops snapshot"));
      }, 4_000);
      const handle = (snapshot: OpsSnapshot) => {
        if (snapshot.server.identity.podName !== "game-server-owner") return;
        clearTimeout(timer);
        adminSocket.off("ops.snapshot", handle);
        resolve(snapshot);
      };
      adminSocket.on("ops.snapshot", handle);
    });
    expect(await emitAck<WatchResult>(adminSocket, "admin.room.watch", { roomCode })).toMatchObject({
      ok: true,
      snapshot: { roomCode },
    });
    expect((await initialOwnerStream).demoChaos.scope.kind).toBe("room-owner-process");
    const socketAck = await emitAck<OpsSnapshot>(adminSocket, "ops.watch", { roomCode });
    expect(socketAck.server.identity.podName).toBe("game-server-owner");
    expect(socketAck.demoChaos.scope).toEqual({
      kind: "room-owner-process",
      roomCode,
      podName: "game-server-owner",
    });
    const ownerStream = new Promise<OpsSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        adminSocket.off("ops.snapshot", handle);
        reject(new Error("Timed out waiting for owner-routed ops.snapshot"));
      }, 4_000);
      const handle = (snapshot: OpsSnapshot) => {
        if (snapshot.server.identity.podName !== "game-server-owner" || snapshot.demoChaos.runtime.tickDelayMs !== 70) return;
        clearTimeout(timer);
        adminSocket.off("ops.snapshot", handle);
        resolve(snapshot);
      };
      adminSocket.on("ops.snapshot", handle);
    });

    const initialOwnerOps = await (
      await fetch(`${runningGateway.url}/api/ops?roomCode=${roomCode}`)
    ).json() as OpsSnapshot;
    expect(initialOwnerOps.server.identity.podName).toBe("game-server-owner");
    expect(initialOwnerOps.demoChaos.scope).toEqual({
      kind: "room-owner-process",
      roomCode,
      podName: "game-server-owner",
    });

    const lag = await fetch(`${runningGateway.url}/api/admin/chaos/lag`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode, delayMs: 70 }),
    });
    expect(lag.status).toBe(200);
    expect((await lag.json()) as DemoChaosActionResponse).toMatchObject({
      action: "lag",
      status: {
        scope: {
          kind: "room-owner-process",
          roomCode,
          podName: "game-server-owner",
        },
        runtime: { tickDelayMs: 70 },
      },
    });
    expect((await ownerStream).demoChaos.scope.podName).toBe("game-server-owner");

    const full = await fetch(`${runningGateway.url}/api/admin/chaos/full-broadcast`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode, enabled: true }),
    });
    expect(full.status).toBe(200);
    expect((await full.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: { podName: "game-server-owner" },
        runtime: { effectiveBroadcastMode: "full" },
      },
    });

    const primaryFailure = await fetch(`${runningGateway.url}/api/admin/chaos/primary-failure`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode, reason: "Owner-routed simulation" }),
    });
    expect(primaryFailure.status).toBe(200);
    expect((await primaryFailure.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: { podName: "game-server-owner" },
        simulations: { primaryFailure: { active: true, source: "timeline-only" } },
      },
    });

    const failover = await fetch(`${runningGateway.url}/api/admin/chaos/failover`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode, targetCluster: "dr" }),
    });
    expect(failover.status).toBe(200);
    expect((await failover.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: { podName: "game-server-owner" },
        simulations: { failover: { active: true, targetCluster: "dr" } },
      },
    });

    const ownerOps = await (
      await fetch(`${runningGateway.url}/api/ops?roomCode=${roomCode}`)
    ).json() as OpsSnapshot;
    expect(ownerOps.server.identity.podName).toBe("game-server-owner");
    expect(ownerOps.demoChaos.runtime).toMatchObject({
      tickDelayMs: 70,
      effectiveBroadcastMode: "full",
      overrideActive: true,
    });
    expect(ownerOps.demoChaos.simulations.primaryFailure.active).toBe(true);
    expect(ownerOps.demoChaos.simulations.failover.active).toBe(true);

    const gatewayLocalOps = await gateway.getOpsSnapshot();
    expect(gatewayLocalOps.server.identity.podName).toBe("game-server-gateway");
    expect(gatewayLocalOps.demoChaos.scope.kind).toBe("process");
    expect(gatewayLocalOps.demoChaos.runtime).toMatchObject({
      tickDelayMs: 0,
      effectiveBroadcastMode: "delta",
      overrideActive: false,
    });

    const shutdown = await fetch(`${runningGateway.url}/api/admin/chaos/server-shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode, reason: "Owner callback only" }),
    });
    expect(shutdown.status).toBe(202);
    expect((await shutdown.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: { roomCode, podName: "game-server-owner" },
        serverShutdown: { allowed: true, handlerAvailable: true },
      },
    });
    await vi.waitFor(() => expect(ownerShutdown).toHaveBeenCalledOnce());
    expect(gatewayShutdown).not.toHaveBeenCalled();

    const reset = await fetch(`${runningGateway.url}/api/admin/chaos/reset`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ roomCode }),
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: { roomCode, podName: "game-server-owner" },
        runtime: { tickDelayMs: 0, effectiveBroadcastMode: "delta", overrideActive: false },
        simulations: {
          primaryFailure: { active: false },
          failover: { active: false },
        },
      },
    });
  }, 20_000);
});
