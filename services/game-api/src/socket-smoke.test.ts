import type { JoinResult, RoomSnapshot, StateDelta, WatchResult } from "@paint-arena/shared";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGameServer } from "./server.js";

const emitAck = <T>(socket: Socket, event: string, payload: unknown): Promise<T> => new Promise((resolve) => socket.emit(event, payload, (result: T) => resolve(result)));
const waitForDelta = (socket: Socket, predicate: (delta: StateDelta) => boolean, timeoutMs = 4000): Promise<StateDelta> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off("state_delta", handle); reject(new Error("Timed out waiting for matching state delta")); }, timeoutMs);
  const handle = (delta: StateDelta) => {
    if (!predicate(delta)) return;
    clearTimeout(timer);
    socket.off("state_delta", handle);
    resolve(delta);
  };
  socket.on("state_delta", handle);
});
const auth = { authorization: "Bearer test-admin", "content-type": "application/json" };

describe("two-client Socket.IO and protected operations flow", () => {
  const clients: Socket[] = [];
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    clients.length = 0;
    if (stop) await stop();
    stop = null;
    vi.unstubAllEnvs();
  });

  it("keeps the replacement socket authoritative after an overlapping session resume", async () => {
    const gameServer = createGameServer({ adminToken: "test-admin", snapshotIntervalMs: 250 });
    const running = await gameServer.start(0, "127.0.0.1");
    stop = gameServer.stop;
    const createResponse = await fetch(`${running.url}/api/rooms`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ durationSeconds: 20, gridWidth: 40 }),
    });
    const created = await createResponse.json() as { room: RoomSnapshot };

    const oldSocket = createClient(running.url, { transports: ["websocket"], reconnection: false });
    const newSocket = createClient(running.url, { transports: ["websocket"], reconnection: false });
    clients.push(oldSocket, newSocket);
    await Promise.all([oldSocket, newSocket].map((client) => new Promise<void>((resolve) => client.once("connect", resolve))));

    const session = { roomCode: created.room.roomCode, sessionId: "session-overlap", nickname: "Overlap" };
    expect((await emitAck<JoinResult>(oldSocket, "join_room", session)).reconnected).toBe(false);
    expect((await emitAck<JoinResult>(newSocket, "resume_session", session)).reconnected).toBe(true);
    oldSocket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const room = await (await fetch(`${running.url}/api/rooms/${created.room.roomCode}`)).json() as { room: RoomSnapshot };
    expect(room.room.players.find((player) => player.id === session.sessionId)?.connected).toBe(true);
  });

  it("runs authoritative delta play, boost, auth, ops events and metrics", async () => {
    const gameServer = createGameServer({ publicBaseUrl: "http://demo.local", adminToken: "test-admin", opsEventToken: "test-ops", snapshotIntervalMs: 250 });
    const running = await gameServer.start(0, "127.0.0.1");
    stop = gameServer.stop;

    const config = await (await fetch(`${running.url}/api/config`)).json() as { tickRateHz: number };
    expect(config.tickRateHz).toBe(30);

    expect((await fetch(`${running.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const createResponse = await fetch(`${running.url}/api/rooms`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ durationSeconds: 20, gridWidth: 40, gridHeight: 22, releaseChannel: "stable" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { room: RoomSnapshot; joinUrl: string };
    expect(created.joinUrl).toContain("http://demo.local/play/");
    expect(created.room.config.gridWidth).toBe(40);
    expect(created.room.config.gridHeight).toBe(40);

    const first = createClient(running.url, { transports: ["websocket"], reconnection: false });
    const second = createClient(running.url, { transports: ["websocket"], reconnection: false });
    const admin = createClient(running.url, { transports: ["websocket"], reconnection: false });
    clients.push(first, second, admin);
    await Promise.all([first, second, admin].map((client) => new Promise<void>((resolve) => client.once("connect", () => resolve()))));

    const joinOne = await emitAck<JoinResult>(first, "join_room", { roomCode: created.room.roomCode, sessionId: "session-smoke-one", nickname: "Alpha" });
    const joinTwo = await emitAck<JoinResult>(second, "join_room", { roomCode: created.room.roomCode, sessionId: "session-smoke-two", nickname: "Bravo" });
    expect(joinOne.ok).toBe(true);
    expect(joinTwo.ok).toBe(true);
    expect(new Set([joinOne.player?.team, joinTwo.player?.team])).toEqual(new Set(["A", "B"]));

    expect((await emitAck<{ ok: boolean }>(admin, "admin_subscribe", { token: "test-admin" })).ok).toBe(true);
    const watched = await emitAck<WatchResult>(admin, "admin.room.watch", { roomCode: created.room.roomCode });
    expect(watched.ok).toBe(true);
    expect(watched.snapshot?.players).toHaveLength(2);

    const startResponse = await fetch(`${running.url}/api/admin/rooms/${created.room.roomCode}/start`, { method: "POST", headers: auth });
    expect(startResponse.ok).toBe(true);
    const deltaPromise = new Promise<StateDelta>((resolve) => first.once("state_delta", resolve));
    const adminDeltaPromise = new Promise<StateDelta>((resolve) => admin.once("state_delta", resolve));
    expect((await emitAck<{ ok: boolean }>(first, "player_input", {
      roomCode: created.room.roomCode,
      sessionId: "session-smoke-one",
      sequence: 1,
      sentAt: Date.now(),
      direction: { x: 1, y: 0 },
    })).ok).toBe(true);
    const delta = await deltaPromise;
    const adminDelta = await adminDeltaPromise;
    expect(delta.changedCells.length).toBeGreaterThan(0);
    expect(delta).not.toHaveProperty("grid");
    expect(adminDelta.sequence).toBe(delta.sequence);
    expect(adminDelta.players[0]?.position.x).toBe(delta.players[0]?.position.x);

    const announcementShown = waitForDelta(first, (next) => next.announcement === "Load test starts now");
    const announcement = await fetch(`${running.url}/api/admin/rooms/${created.room.roomCode}/announcement`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "Load test starts now" }),
    });
    expect(announcement.ok).toBe(true);
    expect(((await announcement.json()) as { room: RoomSnapshot }).room.announcement).toBe("Load test starts now");
    const shownDelta = await announcementShown;
    expect(shownDelta.changedCells).toHaveLength(0);
    const announcementCleared = waitForDelta(first, (next) => next.sequence > shownDelta.sequence && next.announcement === null);
    expect((await announcementCleared).announcement).toBeNull();

    const boost = await fetch(`${running.url}/api/admin/rooms/${created.room.roomCode}/events/paint-boost`, { method: "POST", headers: auth, body: JSON.stringify({ durationMs: 3000 }) });
    expect(boost.ok).toBe(true);
    expect(((await boost.json()) as { room: RoomSnapshot }).room.activeEvents[0]?.type).toBe("paint-boost");

    expect((await fetch(`${running.url}/api/ops/events`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const opsEvent = await fetch(`${running.url}/api/ops/events`, {
      method: "POST",
      headers: { authorization: "Bearer test-ops", "content-type": "application/json" },
      body: JSON.stringify({ type: "CANARY_STARTED", message: "Canary deployment started", releaseChannel: "canary" }),
    });
    expect(opsEvent.status).toBe(202);

    const blockedOom = await fetch(`${running.url}/api/admin/faults/memory-oom`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(blockedOom.status).toBe(409);
    expect(await blockedOom.json()).toEqual({
      error: "이 환경에서는 실제 OOMKilled 장애 주입이 비활성화되어 있습니다.",
    });

    for (const removedPath of ["lag", "full-broadcast", "server-shutdown", "primary-failure", "failover", "reset"]) {
      expect((await fetch(`${running.url}/api/admin/chaos/${removedPath}`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
    }
    expect((await fetch(`${running.url}/api/demo-simulation`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const persisted = await gameServer.storage.load(created.room.roomCode);
    expect(persisted?.players).toHaveLength(2);

    const metrics = await (await fetch(`${running.url}/metrics`)).text();
    expect(metrics).toContain("game_tick_duration_seconds");
    expect(metrics).toContain("game_state_payload_bytes");
    expect(metrics).toContain("game_snapshot_save_duration_seconds");
    expect(metrics).toContain("game_ops_events_total");
  }, 20_000);

  it("exposes one real memory fault path and reports allocation progress", async () => {
    vi.stubEnv("ALLOW_DEMO_OOM_KILL", "true");
    const scheduled: Array<() => void> = [];
    const gameServer = createGameServer({
      adminToken: "test-admin",
      memoryOomChunkBytes: 1024 * 1024,
      memoryOomAllocate: () => Buffer.alloc(1024),
      memoryOomSchedule: (callback) => {
        scheduled.push(callback);
        return setTimeout(() => undefined, 60_000);
      },
    });
    const running = await gameServer.start(0, "127.0.0.1");
    stop = gameServer.stop;

    const started = await fetch(`${running.url}/api/admin/faults/memory-oom`, { method: "POST", headers: auth, body: "{}" });
    expect(started.status).toBe(202);
    expect(((await started.json()) as { faultInjection: { phase: string } }).faultInjection.phase).toBe("allocating");
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    const observed = await (await fetch(`${running.url}/api/ops`)).json() as { faultInjection: { phase: string; allocatedMiB: number; targetPod: string | null } };
    expect(observed.faultInjection.phase).toBe("allocating");
    expect(observed.faultInjection.allocatedMiB).toBeGreaterThan(0);
    expect(observed.faultInjection.targetPod).toBe("local-process");
    expect((await fetch(`${running.url}/api/admin/faults/memory-oom`, { method: "POST", headers: auth, body: "{}" })).status).toBe(409);
  });
});
