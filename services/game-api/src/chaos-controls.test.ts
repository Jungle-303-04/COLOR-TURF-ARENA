import type {
  DemoChaosActionResponse,
  JoinResult,
  OpsSnapshot,
  RoomSnapshot,
  StateDelta,
} from "@paint-arena/shared";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGameServer, type GameServerOptions } from "./server.js";

const adminHeaders = {
  authorization: "Bearer test-admin",
  "content-type": "application/json",
};

const emitAck = <T>(socket: Socket, event: string, payload: unknown): Promise<T> => (
  new Promise((resolve) => socket.emit(event, payload, (result: T) => resolve(result)))
);

const waitForSnapshot = (
  socket: Socket,
  predicate: (snapshot: RoomSnapshot) => boolean,
  timeoutMs = 4_000,
): Promise<RoomSnapshot> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off("room_snapshot", handle);
    reject(new Error("Timed out waiting for matching room snapshot"));
  }, timeoutMs);
  const handle = (snapshot: RoomSnapshot) => {
    if (!predicate(snapshot)) return;
    clearTimeout(timer);
    socket.off("room_snapshot", handle);
    resolve(snapshot);
  };
  socket.on("room_snapshot", handle);
});

const waitForDelta = (
  socket: Socket,
  predicate: (delta: StateDelta) => boolean,
  timeoutMs = 4_000,
): Promise<StateDelta> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off("state_delta", handle);
    reject(new Error("Timed out waiting for matching state delta"));
  }, timeoutMs);
  const handle = (delta: StateDelta) => {
    if (!predicate(delta)) return;
    clearTimeout(timer);
    socket.off("state_delta", handle);
    resolve(delta);
  };
  socket.on("state_delta", handle);
});

describe("protected Demo / Chaos controls", () => {
  const clients: Socket[] = [];
  const servers: Array<ReturnType<typeof createGameServer>> = [];

  const startServer = async (options: GameServerOptions = {}) => {
    const server = createGameServer({ adminToken: "test-admin", snapshotIntervalMs: 10_000, ...options });
    servers.push(server);
    return { server, running: await server.start(0, "127.0.0.1") };
  };

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    clients.length = 0;
    for (const server of servers.splice(0).reverse()) await server.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requires admin auth, strictly validates every payload, and separates runtime effects from simulations", async () => {
    vi.stubEnv("ALLOW_DEMO_SERVER_SHUTDOWN", "false");
    vi.stubEnv("DEMO_ADMIN_AUTH_DISABLED", "true");
    const { running } = await startServer({ clusterName: "primary", broadcastMode: "delta", demoTickDelayMs: 0 });

    const validPayloads = new Map<string, unknown>([
      ["lag", { delayMs: 80 }],
      ["full-broadcast", { enabled: true }],
      ["server-shutdown", { reason: "operator demo" }],
      ["primary-failure", { reason: "timeline demo" }],
      ["failover", { targetCluster: "dr" }],
      ["reset", {}],
    ]);
    for (const [path, body] of validPayloads) {
      const unauthorized = await fetch(`${running.url}/api/admin/chaos/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(unauthorized.status, path).toBe(401);
    }

    const invalidPayloads = new Map<string, unknown>([
      ["lag", { delayMs: "80" }],
      ["full-broadcast", {}],
      ["server-shutdown", { reason: "" }],
      ["primary-failure", { reason: "" }],
      ["failover", { targetCluster: "primary" }],
      ["reset", { unexpected: true }],
    ]);
    for (const [path, body] of invalidPayloads) {
      const invalid = await fetch(`${running.url}/api/admin/chaos/${path}`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(body),
      });
      expect(invalid.status, path).toBe(400);
      expect((await invalid.json()) as { error: string }).toHaveProperty("error", "Invalid chaos payload");
    }
    const missingRoom = await fetch(`${running.url}/api/admin/chaos/lag`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode: "MISSING", delayMs: 20 }),
    });
    expect(missingRoom.status).toBe(404);
    expect(await missingRoom.json()).toMatchObject({ code: "ROOM_NOT_FOUND", roomCode: "MISSING" });
    const missingRoomOps = await fetch(`${running.url}/api/ops?roomCode=MISSING`);
    expect(missingRoomOps.status).toBe(404);
    expect(await missingRoomOps.json()).toMatchObject({ code: "ROOM_NOT_FOUND", roomCode: "MISSING" });

    const lag = await fetch(`${running.url}/api/admin/chaos/lag`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ delayMs: 80 }),
    });
    expect(lag.status).toBe(200);
    const lagResult = await lag.json() as DemoChaosActionResponse;
    expect(lagResult).toMatchObject({
      ok: true,
      action: "lag",
      status: {
        source: "game-api-runtime",
        scope: {
          kind: "process",
          roomCode: null,
          podName: "local-process",
        },
        runtime: {
          tickDelayMs: 80,
          effectiveBroadcastMode: "delta",
          overrideActive: true,
          source: "admin-api",
        },
      },
    });

    const full = await fetch(`${running.url}/api/admin/chaos/full-broadcast`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(full.status).toBe(200);
    expect((await full.json()) as DemoChaosActionResponse).toMatchObject({
      action: "full-broadcast",
      status: {
        runtime: {
          tickDelayMs: 80,
          fullBroadcastEnabled: true,
          effectiveBroadcastMode: "full",
          overrideActive: true,
        },
      },
    });

    const primaryFailure = await fetch(`${running.url}/api/admin/chaos/primary-failure`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ reason: "Demo health check failure" }),
    });
    expect(primaryFailure.status).toBe(200);
    expect((await primaryFailure.json()) as DemoChaosActionResponse).toMatchObject({
      action: "primary-failure",
      status: {
        simulations: {
          primaryFailure: {
            active: true,
            label: "SIMULATION",
            source: "timeline-only",
            reason: "Demo health check failure",
          },
        },
      },
    });

    const failover = await fetch(`${running.url}/api/admin/chaos/failover`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ targetCluster: "dr" }),
    });
    expect(failover.status).toBe(200);
    expect((await failover.json()) as DemoChaosActionResponse).toMatchObject({
      action: "failover",
      status: {
        simulations: {
          failover: {
            active: true,
            label: "SIMULATION",
            source: "timeline-only",
            targetCluster: "dr",
          },
        },
      },
    });

    const ops = await (await fetch(`${running.url}/api/ops`)).json() as OpsSnapshot;
    expect(ops.server.identity.cluster).toBe("primary");
    expect(ops.demoChaos.runtime).toMatchObject({
      tickDelayMs: 80,
      effectiveBroadcastMode: "full",
      source: "admin-api",
    });
    expect(ops.demoChaos.simulations.primaryFailure.active).toBe(true);
    expect(ops.demoChaos.simulations.failover.active).toBe(true);

    const actualEvent = ops.recentEvents.find((event) => event.type === "chaos.tick-delay.updated");
    expect(actualEvent).toMatchObject({
      source: "chaos",
      metadata: {
        effect: "actual-runtime",
        delayMs: 80,
      },
    });
    const simulatedEvents = ops.recentEvents.filter((event) => (
      event.type === "PRIMARY_UNHEALTHY"
      || event.type === "FAILOVER_STARTED"
      || event.type === "FAILOVER_COMPLETED"
    ));
    expect(simulatedEvents).toHaveLength(3);
    for (const event of simulatedEvents) {
      expect(event.source).toBe("simulation");
      expect(event.message).toContain("[SIMULATION]");
      expect(event.metadata).toMatchObject({ simulation: true, effect: "timeline-only", actualCluster: "primary" });
    }

    const reset = await fetch(`${running.url}/api/admin/chaos/reset`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    expect(reset.status).toBe(200);
    const resetResult = await reset.json() as DemoChaosActionResponse;
    expect(resetResult).toMatchObject({
      action: "reset",
      status: {
        runtime: {
          tickDelayMs: 0,
          fullBroadcastEnabled: false,
          effectiveBroadcastMode: "delta",
          overrideActive: false,
          source: "environment",
          updatedAt: null,
        },
        simulations: {
          primaryFailure: { active: false, requestedAt: null, reason: null },
          failover: { active: false, requestedAt: null, targetCluster: null },
        },
      },
    });
  }, 20_000);

  it("applies tick delay to the running loop and switches live clients between full and delta broadcasts", async () => {
    const { running } = await startServer({ broadcastMode: "delta", demoTickDelayMs: 0 });
    const createdResponse = await fetch(`${running.url}/api/rooms`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ durationSeconds: 20, gridWidth: 40 }),
    });
    const created = await createdResponse.json() as { room: RoomSnapshot };
    const client = createClient(running.url, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const session = { roomCode: created.room.roomCode, sessionId: "session-chaos-runtime", nickname: "Runtime" };
    expect((await emitAck<JoinResult>(client, "join_room", session)).ok).toBe(true);

    const startedResponse = await fetch(`${running.url}/api/admin/rooms/${created.room.roomCode}/start`, {
      method: "POST",
      headers: adminHeaders,
    });
    const started = ((await startedResponse.json()) as { room: RoomSnapshot }).room;
    const startPosition = started.players.find((player) => player.id === session.sessionId)?.position;
    expect(startPosition).toBeDefined();

    const fullResponse = await fetch(`${running.url}/api/admin/chaos/full-broadcast`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode: created.room.roomCode, enabled: true }),
    });
    expect((await fullResponse.json()) as DemoChaosActionResponse).toMatchObject({
      status: {
        scope: {
          kind: "room-owner-process",
          roomCode: created.room.roomCode,
          podName: "local-process",
        },
        runtime: { effectiveBroadcastMode: "full" },
      },
    });
    const lagResponse = await fetch(`${running.url}/api/admin/chaos/lag`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode: created.room.roomCode, delayMs: 60 }),
    });
    expect(((await lagResponse.json()) as DemoChaosActionResponse).status.runtime.tickDelayMs).toBe(60);

    await new Promise((resolve) => setTimeout(resolve, 260));
    const delayedOps = await (await fetch(`${running.url}/api/ops?roomCode=${created.room.roomCode}`)).json() as OpsSnapshot;
    expect(delayedOps.demoChaos.scope).toEqual({
      kind: "room-owner-process",
      roomCode: created.room.roomCode,
      podName: "local-process",
    });
    expect(delayedOps.server.metrics.tickP95Ms).toBeGreaterThanOrEqual(60);

    let deltaCount = 0;
    client.on("state_delta", () => { deltaCount += 1; });
    const fullSnapshot = waitForSnapshot(client, (snapshot) => {
      const current = snapshot.players.find((player) => player.id === session.sessionId)?.position;
      return snapshot.server.broadcastMode === "full"
        && snapshot.scores.paintedCells > 0
        && current !== undefined
        && startPosition !== undefined
        && Math.hypot(current.x - startPosition.x, current.y - startPosition.y) > 0.01;
    });
    expect(await emitAck(client, "player_input", {
      ...session,
      sequence: 1,
      sentAt: Date.now(),
      direction: { x: 1, y: 0 },
    })).toEqual({ ok: true });
    const receivedFull = await fullSnapshot;
    expect(receivedFull.grid).toHaveLength(40 * 40);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(deltaCount).toBe(0);

    const deltaResponse = await fetch(`${running.url}/api/admin/chaos/full-broadcast`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode: created.room.roomCode, enabled: false }),
    });
    expect(((await deltaResponse.json()) as DemoChaosActionResponse).status.runtime.effectiveBroadcastMode).toBe("delta");
    const delta = await waitForDelta(client, (value) => (
      value.server.broadcastMode === "delta"
      && value.changedCells.length > 0
    ));
    expect(delta).not.toHaveProperty("grid");
  }, 20_000);

  it("forwards every canary-targeted chaos request to the dedicated canary authority", async () => {
    vi.stubEnv("ALLOW_DEMO_SERVER_SHUTDOWN", "false");
    const canary = await startServer({
      releaseChannel: "canary",
      appVersion: "v1.2.0",
      podName: "canary-pod",
      broadcastMode: "delta",
      demoTickDelayMs: 0,
    });
    const stable = await startServer({
      releaseChannel: "stable",
      appVersion: "v1.1.3",
      podName: "stable-pod",
      canaryApiUrl: canary.running.url,
      broadcastMode: "delta",
      demoTickDelayMs: 0,
    });
    const createResponse = await fetch(`${canary.running.url}/api/rooms`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ releaseChannel: "canary", durationSeconds: 20, gridWidth: 40 }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { room: RoomSnapshot };
    const roomCode = created.room.roomCode;
    const canaryUrl = (path: string) => `${stable.running.url}/api/admin/chaos/${path}?releaseChannel=canary`;

    const unauthorized = await fetch(canaryUrl("lag"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomCode, delayMs: 75 }),
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await fetch(canaryUrl("lag"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, delayMs: "75" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "Invalid chaos payload" });

    const lag = await fetch(canaryUrl("lag"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, delayMs: 75 }),
    });
    expect(lag.status).toBe(200);
    expect((await lag.json()) as DemoChaosActionResponse).toMatchObject({
      action: "lag",
      status: {
        scope: { kind: "room-owner-process", roomCode, podName: "canary-pod" },
        runtime: { tickDelayMs: 75 },
      },
    });

    const full = await fetch(canaryUrl("full-broadcast"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, enabled: true }),
    });
    expect(full.status).toBe(200);
    expect((await full.json()) as DemoChaosActionResponse).toMatchObject({
      action: "full-broadcast",
      status: { runtime: { effectiveBroadcastMode: "full" } },
    });

    const primaryFailure = await fetch(canaryUrl("primary-failure"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, reason: "Canary-only marker" }),
    });
    expect(primaryFailure.status).toBe(200);
    expect((await primaryFailure.json()) as DemoChaosActionResponse).toMatchObject({
      action: "primary-failure",
      status: { simulations: { primaryFailure: { active: true, label: "SIMULATION" } } },
    });

    const failover = await fetch(canaryUrl("failover"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, targetCluster: "dr" }),
    });
    expect(failover.status).toBe(200);
    expect((await failover.json()) as DemoChaosActionResponse).toMatchObject({
      action: "failover",
      status: { simulations: { failover: { active: true, targetCluster: "dr" } } },
    });

    const shutdown = await fetch(canaryUrl("server-shutdown"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode, reason: "Must be rejected by canary gate" }),
    });
    expect(shutdown.status).toBe(409);
    expect(await shutdown.json()).toMatchObject({ code: "DEMO_SERVER_SHUTDOWN_DISABLED" });

    const stableOps = await (await fetch(`${stable.running.url}/api/ops`)).json() as OpsSnapshot;
    const canaryOps = await (
      await fetch(`${stable.running.url}/api/ops?releaseChannel=canary&roomCode=${roomCode}`)
    ).json() as OpsSnapshot;
    expect(stableOps.server.identity.releaseChannel).toBe("stable");
    expect(stableOps.demoChaos.runtime).toMatchObject({
      tickDelayMs: 0,
      effectiveBroadcastMode: "delta",
      overrideActive: false,
    });
    expect(stableOps.demoChaos.simulations.primaryFailure.active).toBe(false);
    expect(canaryOps.server.identity.releaseChannel).toBe("canary");
    expect(canaryOps.demoChaos.scope).toEqual({
      kind: "room-owner-process",
      roomCode,
      podName: "canary-pod",
    });
    expect(canaryOps.demoChaos.runtime).toMatchObject({
      tickDelayMs: 75,
      effectiveBroadcastMode: "full",
      overrideActive: true,
    });
    expect(canaryOps.demoChaos.simulations.primaryFailure.active).toBe(true);
    expect(canaryOps.demoChaos.simulations.failover.active).toBe(true);

    const reset = await fetch(canaryUrl("reset"), {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ roomCode }),
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()) as DemoChaosActionResponse).toMatchObject({
      action: "reset",
      status: {
        runtime: { tickDelayMs: 0, effectiveBroadcastMode: "delta", overrideActive: false },
        simulations: {
          primaryFailure: { active: false },
          failover: { active: false },
        },
      },
    });
  }, 20_000);

  it("keeps shutdown fail-closed and invokes only the injected gated callback without exiting the test process", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const blockedCallback = vi.fn();
    vi.stubEnv("ALLOW_DEMO_SERVER_SHUTDOWN", "false");
    const blocked = await startServer({ onDemoServerShutdown: blockedCallback });
    const blockedResponse = await fetch(`${blocked.running.url}/api/admin/chaos/server-shutdown`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ reason: "must remain blocked" }),
    });
    expect(blockedResponse.status).toBe(409);
    expect(await blockedResponse.json()).toMatchObject({ code: "DEMO_SERVER_SHUTDOWN_DISABLED" });
    expect(blockedCallback).not.toHaveBeenCalled();

    vi.stubEnv("ALLOW_DEMO_SERVER_SHUTDOWN", "true");
    const noHandler = await startServer();
    const noHandlerResponse = await fetch(`${noHandler.running.url}/api/admin/chaos/server-shutdown`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    expect(noHandlerResponse.status).toBe(409);
    expect(await noHandlerResponse.json()).toMatchObject({ code: "DEMO_SERVER_SHUTDOWN_HANDLER_UNAVAILABLE" });

    const shutdownCallback = vi.fn();
    const enabled = await startServer({ onDemoServerShutdown: shutdownCallback });
    const accepted = await fetch(`${enabled.running.url}/api/admin/chaos/server-shutdown`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ reason: "controlled test shutdown" }),
    });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()) as DemoChaosActionResponse).toMatchObject({
      action: "server-shutdown",
      status: {
        serverShutdown: {
          allowed: true,
          handlerAvailable: true,
          source: "environment-gated",
        },
      },
    });
    await vi.waitFor(() => expect(shutdownCallback).toHaveBeenCalledOnce());
    expect(shutdownCallback).toHaveBeenCalledWith(expect.objectContaining({
      reason: "controlled test shutdown",
      server: expect.objectContaining({ cluster: "primary" }),
    }));
    expect(exitSpy).not.toHaveBeenCalled();
  }, 20_000);
});
