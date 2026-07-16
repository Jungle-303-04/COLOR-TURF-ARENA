import type {
  ClientRenderStatsPayload,
  JoinResult,
  OpsSnapshot,
  RoomSnapshot,
  WatchResult,
} from "@paint-arena/shared";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createGameServer } from "./server.js";

interface TelemetryAck {
  ok: boolean;
  error?: "invalid-payload" | "unauthorized-role";
}

const emitAck = <T>(socket: Socket, event: string, payload: unknown): Promise<T> => (
  new Promise((resolve) => socket.emit(event, payload, (result: T) => resolve(result)))
);

const connect = async (url: string): Promise<Socket> => {
  const socket = createClient(url, { transports: ["websocket"], reconnection: false });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  return socket;
};

const metricValue = (text: string, name: string): number => {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${name}{`));
  if (!line) throw new Error(`Metric ${name} was not exposed`);
  return Number(line.trim().split(/\s+/).at(-1));
};

describe("browser render telemetry", () => {
  const clients: Socket[] = [];
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    clients.length = 0;
    if (stop) await stop();
    stop = null;
  });

  it("validates roles and payloads, aggregates live clients, exports gauges, and removes stale samples", async () => {
    const gameServer = createGameServer({
      adminToken: "test-admin",
      clientRenderTelemetryTtlMs: 500,
      snapshotIntervalMs: 10_000,
    });
    const running = await gameServer.start(0, "127.0.0.1");
    stop = gameServer.stop;

    const createResponse = await fetch(`${running.url}/api/rooms`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ durationSeconds: 30, gridWidth: 40 }),
    });
    expect(createResponse.status).toBe(201);
    const room = ((await createResponse.json()) as { room: RoomSnapshot }).room;

    const controller = await connect(running.url);
    const watcher = await connect(running.url);
    const admin = await connect(running.url);
    clients.push(controller, watcher, admin);

    const fastSample: ClientRenderStatsPayload = {
      fps: 60,
      frameTimeP95Ms: 18,
      droppedFramePercent: 2,
      sampleDurationMs: 1000.25,
      frameCount: 60,
    };
    const slowSample: ClientRenderStatsPayload = {
      fps: 30,
      frameTimeP95Ms: 45,
      droppedFramePercent: 10,
      sampleDurationMs: 1001.5,
      frameCount: 30,
    };

    expect(await emitAck<TelemetryAck>(controller, "client_render_stats", fastSample)).toEqual({
      ok: false,
      error: "unauthorized-role",
    });

    const joined = await emitAck<JoinResult>(controller, "join_room", {
      roomCode: room.roomCode,
      sessionId: "render-controller-session",
      nickname: "Render Controller",
    });
    expect(joined.ok).toBe(true);
    const watched = await emitAck<WatchResult>(watcher, "spectator_subscribe", { roomCode: room.roomCode });
    expect(watched.ok).toBe(true);
    expect(await emitAck<{ ok: boolean }>(admin, "admin_subscribe", { token: "test-admin" })).toEqual({ ok: true });

    expect(await emitAck<TelemetryAck>(controller, "client_render_stats", {
      ...fastSample,
      fps: -1,
    })).toEqual({ ok: false, error: "invalid-payload" });
    expect(await emitAck<TelemetryAck>(admin, "client_render_stats", fastSample)).toEqual({
      ok: false,
      error: "unauthorized-role",
    });
    expect(await emitAck<TelemetryAck>(controller, "client_render_stats", fastSample)).toEqual({ ok: true });
    expect(await emitAck<TelemetryAck>(watcher, "client_render_stats", slowSample)).toEqual({ ok: true });

    const ops = await (await fetch(`${running.url}/api/ops`)).json() as OpsSnapshot;
    expect(ops.server.metrics).toMatchObject({
      clientFpsP10: 30,
      clientFrameTimeP95Ms: 45,
      clientFrameDropP95Percent: 10,
      clientTelemetryClients: 2,
    });

    const prometheus = await (await fetch(`${running.url}/metrics`)).text();
    expect(metricValue(prometheus, "game_client_render_fps_p10")).toBe(30);
    expect(metricValue(prometheus, "game_client_render_frame_time_p95_seconds")).toBeCloseTo(0.045, 6);
    expect(metricValue(prometheus, "game_client_render_frame_drop_ratio_p95")).toBeCloseTo(0.1, 6);
    expect(metricValue(prometheus, "game_client_render_telemetry_clients")).toBe(2);

    watcher.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterDisconnect = await gameServer.getOpsSnapshot();
    expect(afterDisconnect.server.metrics).toMatchObject({
      clientFpsP10: 60,
      clientFrameTimeP95Ms: 18,
      clientFrameDropP95Percent: 2,
      clientTelemetryClients: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 550));
    const afterExpiry = await gameServer.getOpsSnapshot();
    expect(afterExpiry.server.metrics).toMatchObject({
      clientFpsP10: 0,
      clientFrameTimeP95Ms: 0,
      clientFrameDropP95Percent: 0,
      clientTelemetryClients: 0,
    });
  });
});
