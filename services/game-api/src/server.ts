import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server as SocketServer, type Socket } from "socket.io";
import {
  TEAM_IDS,
  inputPayloadSchema,
  joinPayloadSchema,
  opsEventSchema,
  type BroadcastMode,
  type ClusterName,
  type EventLogEntry,
  type GameConfig,
  type InputPayload,
  type InputResult,
  type JoinResult,
  type OpsEventPayload,
  type OpsSnapshot,
  type PublicConfig,
  type RoomSnapshot,
  type ServerIdentity,
  type SimulationState,
  type SystemStatus,
  type VersionInfo,
  type WatchResult,
} from "@paint-arena/shared";
import { BotManager } from "./bots.js";
import { DEFAULT_GAME_CONFIG, DEFAULT_WORLD_SIZE, type GameEvent, type GameRoom } from "./game.js";
import { KubernetesObserver } from "./kubernetes.js";
import { createMetrics } from "./metrics.js";
import { createSnapshotStorage, type SnapshotStorage } from "./snapshot-store.js";
import { MemoryRoomStore, summarizeRoom } from "./store.js";

interface SocketData {
  role?: "controller" | "watcher" | "ops" | "admin";
  roomCode?: string;
  sessionId?: string;
}

export interface GameServerOptions {
  publicBaseUrl?: string;
  appVersion?: string;
  gitSha?: string;
  podName?: string;
  clusterName?: ClusterName;
  releaseChannel?: "stable" | "canary";
  broadcastMode?: BroadcastMode;
  adminToken?: string;
  opsEventToken?: string;
  redisUrl?: string;
  snapshotStorage?: SnapshotStorage;
  snapshotIntervalMs?: number;
  demoTickDelayMs?: number;
}

export interface RunningGameServer {
  url: string;
  port: number;
}

interface RuntimeStats {
  totalInputEvents: number;
  rejectedInputEvents: number;
  disconnects: number;
  reconnects: number;
  inputTimes: number[];
  inputLatenciesMs: number[];
  tickDurationsMs: number[];
  broadcastDurationsMs: number[];
  rttValuesMs: number[];
  payloadBytes: number[];
  lastSnapshotAt: number | null;
  cpuPercent: number;
}

const numeric = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const percentile = (values: number[], value = 0.95): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
};

const pushWindow = (values: number[], value: number, limit = 500) => {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
};

const createConfig = (body: Record<string, unknown> = {}): GameConfig => {
  const teamBody = typeof body.teams === "object" && body.teams ? body.teams as Record<string, Record<string, unknown>> : {};
  const releaseChannel = body.releaseChannel === "canary" ? "canary" : "stable";
  const gridSize = Math.max(40, Math.min(270, Math.round(numeric(body.gridWidth ?? body.gridHeight, DEFAULT_WORLD_SIZE))));
  return {
    durationSeconds: Math.max(15, Math.min(300, Math.round(numeric(body.durationSeconds, DEFAULT_GAME_CONFIG.durationSeconds)))),
    gridWidth: gridSize,
    gridHeight: gridSize,
    paintRadius: Math.max(1, Math.min(5, Math.round(numeric(body.paintRadius, DEFAULT_GAME_CONFIG.paintRadius)))),
    playerSpeed: Math.max(5, Math.min(40, numeric(body.playerSpeed, DEFAULT_GAME_CONFIG.playerSpeed))),
    releaseChannel,
    teams: {
      A: {
        ...DEFAULT_GAME_CONFIG.teams.A,
        ...(typeof teamBody.A?.name === "string" ? { name: teamBody.A.name.slice(0, 20) } : {}),
        ...(typeof teamBody.A?.color === "string" && /^#[0-9a-f]{6}$/i.test(teamBody.A.color) ? { color: teamBody.A.color } : {}),
      },
      B: {
        ...DEFAULT_GAME_CONFIG.teams.B,
        ...(typeof teamBody.B?.name === "string" ? { name: teamBody.B.name.slice(0, 20) } : {}),
        ...(typeof teamBody.B?.color === "string" && /^#[0-9a-f]{6}$/i.test(teamBody.B.color) ? { color: teamBody.B.color } : {}),
      },
    },
  };
};

export const createGameServer = (options: GameServerOptions = {}) => {
  const app = express();
  const httpServer: HttpServer = createServer(app);
  const socketPath = process.env.SOCKET_PATH ?? "/socket.io";
  const io = new SocketServer(httpServer, {
    path: socketPath,
    cors: { origin: true, credentials: true },
    transports: ["websocket", "polling"],
  });
  const metrics = createMetrics();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const kubernetes = new KubernetesObserver();
  const storage = options.snapshotStorage ?? createSnapshotStorage(options.redisUrl);
  const startedAt = new Date().toISOString();
  const ownerId = `${options.clusterName ?? process.env.CLUSTER_NAME ?? "primary"}:${options.podName ?? process.env.POD_NAME ?? "local"}:${randomUUID()}`;
  const leaseTtlMs = 7000;
  const snapshotIntervalMs = Math.max(250, options.snapshotIntervalMs ?? numeric(process.env.SNAPSHOT_INTERVAL_MS, 1000));
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "demo-admin";
  const opsEventToken = options.opsEventToken ?? process.env.OPS_EVENT_TOKEN ?? "demo-ops";
  const stableVersion = options.appVersion ?? process.env.SERVER_VERSION ?? process.env.APP_VERSION ?? "v1.1.3";
  const canaryVersion = process.env.CANARY_SERVER_VERSION ?? "v1.2.0";
  const configuredBroadcastMode = options.broadcastMode ?? (process.env.BROADCAST_MODE === "full" ? "full" : "delta");
  const configuredTickDelayMs = Math.max(0, options.demoTickDelayMs ?? numeric(process.env.DEMO_TICK_DELAY_MS, 0));
  let boundUrl = "http://127.0.0.1:3001";
  let tickRunning = false;
  let leaseMaintenanceRunning = false;

  const events: EventLogEntry[] = [];
  const stats: RuntimeStats = {
    totalInputEvents: 0,
    rejectedInputEvents: 0,
    disconnects: 0,
    reconnects: 0,
    inputTimes: [],
    inputLatenciesMs: [],
    tickDurationsMs: [],
    broadcastDurationsMs: [],
    rttValuesMs: [],
    payloadBytes: [],
    lastSnapshotAt: null,
    cpuPercent: 0,
  };
  let lastCpuUsage = process.cpuUsage();
  let lastCpuSampleAt = Date.now();
  const simulation: SimulationState = {
    label: "DEMO / CHAOS MODE",
    latencyMs: configuredTickDelayMs,
    disconnectWaves: 0,
    podRestartMarkerUntil: null,
    forceFullBroadcast: configuredBroadcastMode === "full",
    activeCluster: options.clusterName ?? (process.env.CLUSTER_NAME === "dr" ? "dr" : "primary"),
    updatedAt: new Date().toISOString(),
  };

  let tickTimer: NodeJS.Timeout | null = null;
  let opsTimer: NodeJS.Timeout | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  const announcementTimers = new Map<string, NodeJS.Timeout>();

  const baseIdentity = (): ServerIdentity => ({
    version: stableVersion,
    gitSha: options.gitSha ?? process.env.GIT_SHA ?? "local",
    podName: options.podName ?? process.env.POD_NAME ?? "local-process",
    cluster: simulation.activeCluster,
    releaseChannel: options.releaseChannel ?? (process.env.RELEASE_CHANNEL === "canary" ? "canary" : "stable"),
    broadcastMode: simulation.forceFullBroadcast ? "full" : configuredBroadcastMode,
  });

  const roomIdentity = (room: GameRoom): ServerIdentity => ({
    ...baseIdentity(),
    version: room.releaseChannel === "canary" ? canaryVersion : stableVersion,
    releaseChannel: room.releaseChannel,
    broadcastMode: simulation.forceFullBroadcast || room.releaseChannel === "canary" ? "full" : configuredBroadcastMode,
  });

  const addEvent = (
    type: string,
    message: string,
    source: EventLogEntry["source"],
    roomCode: string | null = null,
    metadata?: EventLogEntry["metadata"],
  ): EventLogEntry => {
    const entry: EventLogEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      message,
      roomCode,
      source,
      ...(metadata ? { metadata } : {}),
    };
    events.unshift(entry);
    if (events.length > 200) events.length = 200;
    io.emit("ops_event", entry);
    if (process.env.NODE_ENV !== "test") {
      console.log(JSON.stringify({
        timestamp: entry.at,
        level: source === "chaos" ? "warn" : "info",
        message,
        eventType: type,
        roomId: roomCode,
        serverVersion: baseIdentity().version,
        gitSha: baseIdentity().gitSha,
        podName: baseIdentity().podName,
        clusterName: baseIdentity().cluster,
        releaseChannel: baseIdentity().releaseChannel,
        ...metadata,
      }));
    }
    return entry;
  };

  const roomStore = new MemoryRoomStore((roomCode: string, event: GameEvent) => {
    addEvent(event.type, event.message, event.source, roomCode);
  }, baseIdentity);

  const roomChannel = (roomCode: string) => `room:${roomCode}`;

  const setIdentity = (room: GameRoom) => {
    room.setServerIdentity(roomIdentity(room));
  };

  const broadcastSnapshot = (room: GameRoom): RoomSnapshot => {
    setIdentity(room);
    const started = performance.now();
    const snapshot = room.snapshot();
    const payload = JSON.stringify(snapshot);
    io.to(roomChannel(snapshot.roomCode)).emit("room_snapshot", snapshot);
    io.to(roomChannel(snapshot.roomCode)).emit("game.state.snapshot", snapshot);
    const elapsed = performance.now() - started;
    pushWindow(stats.broadcastDurationsMs, elapsed);
    pushWindow(stats.payloadBytes, Buffer.byteLength(payload));
    metrics.observeBroadcast(snapshot, "full", elapsed / 1000, Buffer.byteLength(payload));
    return snapshot;
  };

  const broadcastTick = (room: GameRoom) => {
    setIdentity(room);
    const started = performance.now();
    const snapshot = room.snapshot();
    const delta = room.consumeDelta();
    const mode = snapshot.server.broadcastMode;
    const payloadValue = mode === "full" ? snapshot : delta;
    if (mode === "full") {
      io.to(roomChannel(snapshot.roomCode)).emit("room_snapshot", snapshot);
      io.to(roomChannel(snapshot.roomCode)).emit("game.state.snapshot", snapshot);
    } else {
      io.to(roomChannel(snapshot.roomCode)).emit("state_delta", delta);
    }
    const elapsed = performance.now() - started;
    const bytes = Buffer.byteLength(JSON.stringify(payloadValue));
    pushWindow(stats.broadcastDurationsMs, elapsed);
    pushWindow(stats.payloadBytes, bytes);
    metrics.observeBroadcast(snapshot, mode, elapsed / 1000, bytes, delta);
  };

  const roomSummaries = () => roomStore.list().map((room) => {
    setIdentity(room);
    return summarizeRoom(room.snapshot());
  });

  const runtimeMetricSummary = () => ({
    tickMeanMs: stats.tickDurationsMs.length === 0 ? 0 : stats.tickDurationsMs.reduce((sum, value) => sum + value, 0) / stats.tickDurationsMs.length,
    tickP95Ms: percentile(stats.tickDurationsMs),
    broadcastP95Ms: percentile(stats.broadcastDurationsMs),
    websocketRttP95Ms: percentile(stats.rttValuesMs),
    statePayloadBytes: Math.round(percentile(stats.payloadBytes)),
    reconnects: stats.reconnects,
    snapshotCreatedAt: stats.lastSnapshotAt ? new Date(stats.lastSnapshotAt).toISOString() : null,
    snapshotAgeSeconds: stats.lastSnapshotAt ? Math.max(0, (Date.now() - stats.lastSnapshotAt) / 1000) : null,
    eventLoopLagP95Ms: Number.isFinite(eventLoopDelay.percentile(95)) ? eventLoopDelay.percentile(95) / 1_000_000 : 0,
    cpuPercent: stats.cpuPercent,
    memoryRssMb: process.memoryUsage().rss / 1024 / 1024,
    heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024,
    inputRejectRate: stats.totalInputEvents === 0 ? 0 : (stats.rejectedInputEvents / stats.totalInputEvents) * 100,
  });

  const getOpsSnapshot = async (): Promise<OpsSnapshot> => {
    const now = Date.now();
    const cpuUsage = process.cpuUsage();
    const wallMicros = Math.max(1, (now - lastCpuSampleAt) * 1000);
    stats.cpuPercent = Math.min(100, Math.max(0, ((cpuUsage.user - lastCpuUsage.user) + (cpuUsage.system - lastCpuUsage.system)) / wallMicros * 100));
    lastCpuUsage = cpuUsage;
    lastCpuSampleAt = now;
    stats.inputTimes = stats.inputTimes.filter((time) => time > now - 1000);
    if (simulation.podRestartMarkerUntil && new Date(simulation.podRestartMarkerUntil).getTime() <= now) {
      simulation.podRestartMarkerUntil = null;
      simulation.updatedAt = new Date().toISOString();
    }
    const summaries = roomSummaries();
    metrics.refresh(baseIdentity(), io.engine.clientsCount, summaries);
    return {
      observedAt: new Date(now).toISOString(),
      server: {
        health: "healthy",
        ready: storage.isReady(),
        uptimeSeconds: Math.floor(process.uptime()),
        connectedSockets: io.engine.clientsCount,
        inputEventsPerSecond: stats.inputTimes.length,
        inputLatencyP95Ms: percentile(stats.inputLatenciesMs),
        totalInputEvents: stats.totalInputEvents,
        rejectedInputEvents: stats.rejectedInputEvents,
        disconnects: stats.disconnects,
        reconnects: stats.reconnects,
        identity: baseIdentity(),
        metrics: runtimeMetricSummary(),
      },
      rooms: summaries,
      infrastructure: await kubernetes.observe(),
      simulation: { ...simulation },
      recentEvents: events.slice(0, 60),
    };
  };

  const getSystemStatus = (): SystemStatus => {
    const summaries = roomSummaries();
    return {
      observedAt: new Date().toISOString(),
      connectedSockets: io.engine.clientsCount,
      activeRooms: summaries.filter((room) => room.status !== "ended").length,
      activePlayers: summaries.reduce((sum, room) => sum + room.connectedPlayers, 0),
      runtime: runtimeMetricSummary(),
      server: baseIdentity(),
      recentEvents: events.slice(0, 20),
    };
  };

  const resolvePublicBaseUrl = (request?: Request): string => {
    const configured = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
    if (configured) return configured.replace(/\/$/, "");
    if (request) return `${request.protocol}://${request.get("host")}`;
    return "http://localhost:5173";
  };

  const bearer = (request: Request) => request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const requireToken = (expected: string) => (request: Request, response: Response, next: NextFunction) => {
    if (bearer(request) !== expected) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
  const requireAdmin = requireToken(adminToken);
  const requireOpsEvent = requireToken(opsEventToken);

  const persistRooms = async () => {
    for (const room of roomStore.list()) {
      setIdentity(room);
      const started = performance.now();
      await storage.save(room.serialize());
      const elapsed = performance.now() - started;
      stats.lastSnapshotAt = Date.now();
      metrics.gameSnapshotSaveDuration.observe({ cluster: baseIdentity().cluster }, elapsed / 1000);
      metrics.gameSnapshotAge.set({ room_id: room.roomCode, cluster: baseIdentity().cluster }, 0);
    }
  };

  const recoverAvailableRooms = async (): Promise<number> => {
    let recovered = 0;
    const persistedRooms = await storage.loadAll();
    for (const state of persistedRooms) {
      if (roomStore.get(state.roomCode)) continue;
      if (!(await storage.acquireLease(state.roomCode, ownerId, leaseTtlMs))) continue;
      const recoveryStarted = performance.now();
      const room = roomStore.restore(state);
      setIdentity(room);
      const elapsed = (performance.now() - recoveryStarted) / 1000;
      metrics.gameRoomRecoveryDuration.observe({
        room_id: room.roomCode,
        source_cluster: state.serverIdentity.cluster,
        target_cluster: baseIdentity().cluster,
      }, elapsed);
      addEvent("SNAPSHOT_RESTORED", `Recovered room ${room.roomCode} from ${storage.kind}`, "system", room.roomCode, {
        recoveryTimeMs: Math.round(elapsed * 1000),
      });
      recovered += 1;
    }
    return recovered;
  };

  const maintainLeasesAndRecover = async (): Promise<void> => {
    if (leaseMaintenanceRunning) return;
    leaseMaintenanceRunning = true;
    try {
      for (const room of [...roomStore.list()]) {
        const renewed = await storage.renewLease(room.roomCode, ownerId, leaseTtlMs);
        if (renewed) continue;
        roomStore.remove(room.roomCode);
        addEvent("ROOM_LEASE_LOST", `Stopped serving ${room.roomCode} after lease loss`, "system", room.roomCode);
        for (const socket of await io.fetchSockets()) {
          if ((socket.data as SocketData).roomCode === room.roomCode) socket.disconnect(true);
        }
      }
      await recoverAvailableRooms();
    } finally {
      leaseMaintenanceRunning = false;
    }
  };

  const runTicks = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      if (simulation.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, simulation.latencyMs));
      for (const room of roomStore.list()) {
        const started = performance.now();
        const changed = room.tick();
        const elapsed = performance.now() - started + simulation.latencyMs;
        pushWindow(stats.tickDurationsMs, elapsed);
        setIdentity(room);
        const snapshot = room.snapshot();
        metrics.observeTick(snapshot, elapsed / 1000);
        if (changed || snapshot.status === "running") broadcastTick(room);
      }
    } finally {
      tickRunning = false;
    }
  };

  const performFailover = async () => {
    const recoveryStarted = performance.now();
    const sourceCluster = simulation.activeCluster;
    addEvent("PRIMARY_UNHEALTHY", "Primary health check failed", "chaos");
    addEvent("FAILOVER_STARTED", "DR failover started; clients will reconnect automatically", "chaos");
    await persistRooms();
    simulation.activeCluster = "dr";
    simulation.updatedAt = new Date().toISOString();
    for (const socket of await io.fetchSockets()) {
      if ((socket.data as SocketData).role === "controller") socket.disconnect(true);
    }
    for (const current of [...roomStore.list()]) {
      const persisted = await storage.load(current.roomCode);
      if (!persisted) continue;
      const restored = roomStore.replace(persisted);
      setIdentity(restored);
      const elapsed = (performance.now() - recoveryStarted) / 1000;
      metrics.gameRoomRecoveryDuration.observe({
        room_id: restored.roomCode,
        source_cluster: sourceCluster,
        target_cluster: "dr",
      }, elapsed);
      addEvent("SNAPSHOT_RESTORED", `Room restored from ${storage.kind} snapshot`, "chaos", restored.roomCode, {
        recoveryTimeMs: Math.round(elapsed * 1000),
        snapshotAgeMs: stats.lastSnapshotAt ? Date.now() - stats.lastSnapshotAt : null,
      });
      broadcastSnapshot(restored);
    }
    addEvent("FAILOVER_COMPLETED", "DR recovery completed; reconnecting sessions retain team and position", "chaos");
  };

  const botManager = new BotManager(
    () => boundUrl,
    () => socketPath,
    (roomCode, sessionId) => { roomStore.get(roomCode)?.removeBot(sessionId); },
  );

  const roomAction = (room: GameRoom, action: string): RoomSnapshot => {
    if (action === "start") return room.start();
    if (action === "pause") return room.pause();
    if (action === "resume") return room.resume();
    if (action === "end" || action === "stop") return room.end();
    if (action === "reset") return room.reset();
    if (action === "reassign") return room.reassignTeams();
    throw new Error("Unknown action");
  };

  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));
  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/healthz", (_request, response) => response.json({ status: "ok", service: "color-turf-game-server", version: baseIdentity().version }));
  app.get("/readyz", (_request, response) => {
    const ready = storage.isReady();
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready", store: storage.kind, roomCount: roomStore.list().length });
  });
  app.get("/version", (_request, response) => {
    const version: VersionInfo = { ...baseIdentity(), startedAt };
    response.json(version);
  });
  app.get("/metrics", async (_request, response) => {
    metrics.refresh(baseIdentity(), io.engine.clientsCount, roomSummaries());
    response.setHeader("Content-Type", metrics.register.contentType);
    response.send(await metrics.register.metrics());
  });
  app.get("/api/system/status", (_request, response) => response.json(getSystemStatus()));
  app.get("/api/admin/session", requireAdmin, (_request, response) => response.json({ ok: true }));
  app.get("/api/config", (request, response) => {
    const config: PublicConfig = {
      publicBaseUrl: resolvePublicBaseUrl(request),
      appVersion: baseIdentity().version,
      socketPath,
      adminTokenRequired: true,
    };
    response.json(config);
  });

  app.get("/api/rooms", (_request, response) => response.json({ rooms: roomSummaries() }));
  app.post("/api/rooms", requireAdmin, async (request, response) => {
    const room = roomStore.create(createConfig(request.body as Record<string, unknown>));
    await storage.acquireLease(room.roomCode, ownerId, leaseTtlMs);
    setIdentity(room);
    await storage.save(room.serialize());
    addEvent("room.created", `Room ${room.roomCode} created`, "admin", room.roomCode);
    const snapshot = broadcastSnapshot(room);
    response.status(201).json({
      room: snapshot,
      joinUrl: `${resolvePublicBaseUrl(request)}/play/${room.roomCode}`,
      screenUrl: `${resolvePublicBaseUrl(request)}/watch/${room.roomCode}`,
      socketPath,
    });
  });
  app.get("/api/rooms/:roomCode", (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    setIdentity(room);
    response.json({ room: room.snapshot() });
  });
  app.get("/api/rooms/:roomCode/state", (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    setIdentity(room);
    response.json({ room: room.snapshot() });
  });
  app.post("/api/rooms/:roomCode/join", (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    response.json({ roomId: room.roomCode, releaseChannel: room.releaseChannel, socketPath, sessionId: randomUUID() });
  });
  app.patch("/api/rooms/:roomCode", requireAdmin, (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    try {
      const snapshot = room.updateConfig(request.body as Parameters<GameRoom["updateConfig"]>[0]);
      setIdentity(room);
      broadcastSnapshot(room);
      response.json({ room: snapshot });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "Unable to update room" });
    }
  });

  const actionHandler = (action: string) => (request: Request, response: Response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    try {
      roomAction(room, action);
      response.json({ room: broadcastSnapshot(room) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "Action failed" });
    }
  };

  app.post("/api/rooms/:roomCode/actions", requireAdmin, (request, response) => actionHandler(String((request.body as Record<string, unknown>).action ?? ""))(request, response));
  for (const action of ["start", "pause", "resume", "reset", "stop"] as const) {
    app.post(`/api/admin/rooms/:roomCode/${action}`, requireAdmin, actionHandler(action));
  }
  app.post("/api/admin/rooms/:roomCode/reassign", requireAdmin, actionHandler("reassign"));
  app.post("/api/admin/rooms/:roomCode/events/paint-boost", requireAdmin, (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    const durationMs = numeric((request.body as Record<string, unknown>).durationMs, 10_000);
    room.activatePaintBoost(durationMs);
    response.json({ room: broadcastSnapshot(room) });
  });
  app.post("/api/admin/rooms/:roomCode/announcement", requireAdmin, (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    const message = String((request.body as Record<string, unknown>).message ?? "").trim().slice(0, 160);
    room.announce(message);
    broadcastTick(room);
    const existingTimer = announcementTimers.get(room.roomCode);
    if (existingTimer) clearTimeout(existingTimer);
    if (message) {
      announcementTimers.set(room.roomCode, setTimeout(() => {
        announcementTimers.delete(room.roomCode);
        const current = roomStore.get(room.roomCode);
        if (!current || current.snapshot().announcement !== message) return;
        current.announce("");
        broadcastTick(current);
      }, 2500));
    }
    response.json({ room: room.snapshot() });
  });
  app.post("/api/admin/rooms/:roomCode/bots", requireAdmin, (request, response) => {
    const room = roomStore.get(String(request.params.roomCode ?? ""));
    if (!room) { response.status(404).json({ error: "Room not found" }); return; }
    const body = request.body as Record<string, unknown>;
    const count = Math.max(1, Math.min(500, Math.round(numeric(body.count, 1))));
    const action = body.action === "remove" ? "remove" : "add";
    const sessionIds = action === "add" ? botManager.add(room.roomCode, count) : botManager.remove(room.roomCode, count);
    addEvent(`bot.${action}`, `${sessionIds.length} bot(s) ${action === "add" ? "started" : "removed"}`, "admin", room.roomCode);
    response.json({ action, count: sessionIds.length, sessionIds });
  });

  app.get("/api/ops", async (_request, response) => response.json(await getOpsSnapshot()));
  app.get("/api/ops/events", (_request, response) => response.json({ events: events.slice(0, 100) }));
  app.post("/api/ops/events", requireOpsEvent, async (request, response) => {
    const parsed = opsEventSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "Invalid ops event", details: parsed.error.issues }); return; }
    const payload: OpsEventPayload = parsed.data;
    const entry = addEvent(payload.type, payload.message, "platform", payload.roomId ?? null, {
      service: payload.service ?? null,
      version: payload.version ?? null,
      gitSha: payload.gitSha ?? null,
      cluster: payload.cluster ?? null,
      releaseChannel: payload.releaseChannel ?? null,
    });
    metrics.gameOpsEvents.inc({ type: payload.type, cluster: payload.cluster ?? baseIdentity().cluster, version: payload.version ?? baseIdentity().version });
    if (payload.type === "SLO_BREACH" && process.env.OPS_PLATFORM_WEBHOOK_URL) {
      void fetch(process.env.OPS_PLATFORM_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.OPS_PLATFORM_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.OPS_PLATFORM_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ ...payload, metrics: runtimeMetricSummary() }),
      }).catch((error) => addEvent("webhook.failed", error instanceof Error ? error.message : "Webhook failed", "system"));
    }
    response.status(202).json({ accepted: true, event: entry });
  });

  const chaosHandler = async (action: string, request: Request, response: Response) => {
    if (action === "lag") {
      simulation.latencyMs = Math.max(0, Math.min(1000, Math.round(numeric((request.body as Record<string, unknown>).delayMs, simulation.latencyMs > 0 ? 0 : 350))));
      addEvent("chaos.tick-lag", `Tick delay set to ${simulation.latencyMs}ms`, "chaos");
    } else if (action === "full-broadcast") {
      simulation.forceFullBroadcast = (request.body as Record<string, unknown>).enabled === false ? false : !simulation.forceFullBroadcast;
      addEvent("chaos.full-broadcast", `Full state broadcast ${simulation.forceFullBroadcast ? "enabled" : "disabled"}`, "chaos");
    } else if (action === "primary-failure" || action === "failover") {
      await performFailover();
    } else if (action === "reset") {
      simulation.latencyMs = configuredTickDelayMs;
      simulation.forceFullBroadcast = configuredBroadcastMode === "full";
      simulation.activeCluster = options.clusterName ?? "primary";
      addEvent("SERVICE_RECOVERED", "Demo / Chaos effects cleared", "chaos");
      for (const room of roomStore.list()) broadcastSnapshot(room);
    } else if (action === "server-shutdown") {
      if (process.env.ALLOW_DEMO_SERVER_SHUTDOWN !== "true") {
        response.status(409).json({ error: "Set ALLOW_DEMO_SERVER_SHUTDOWN=true to enable an actual process shutdown." });
        return;
      }
      addEvent("server.shutdown.requested", "Game server shutdown requested", "chaos");
      response.status(202).json({ accepted: true });
      setTimeout(() => void stop(), 250);
      return;
    } else {
      response.status(400).json({ error: "Unknown chaos action" });
      return;
    }
    simulation.updatedAt = new Date().toISOString();
    response.json(await getOpsSnapshot());
  };

  for (const action of ["lag", "full-broadcast", "server-shutdown", "primary-failure", "failover", "reset"] as const) {
    app.post(`/api/admin/chaos/${action}`, requireAdmin, (request, response) => void chaosHandler(action, request, response));
  }
  app.post("/api/demo-simulation", requireAdmin, (request, response) => {
    const legacy = String((request.body as Record<string, unknown>).action ?? "");
    const mapped = legacy === "latency.toggle" ? "lag" : legacy === "disconnect.wave" ? "primary-failure" : legacy === "clear" ? "reset" : "";
    if (!mapped) { response.status(400).json({ error: "Unknown simulation action" }); return; }
    void chaosHandler(mapped, request, response);
  });

  const joinRoomChannel = (socket: Socket, roomCode: string): WatchResult => {
    const room = roomStore.get(roomCode);
    if (!room) return { ok: false, error: "Room not found" };
    setIdentity(room);
    const data = socket.data as SocketData;
    if (data.roomCode && data.roomCode !== room.roomCode) void socket.leave(roomChannel(data.roomCode));
    void socket.join(roomChannel(room.roomCode));
    data.roomCode = room.roomCode;
    return { ok: true, snapshot: room.snapshot() };
  };

  const watchRoom = (socket: Socket, roomCode: string, role: NonNullable<SocketData["role"]>): WatchResult => {
    const result = joinRoomChannel(socket, roomCode);
    if (result.ok) (socket.data as SocketData).role = role;
    return result;
  };

  const processInput = (socket: Socket, rawPayload: unknown, acknowledge?: (result: InputResult) => void): void => {
    const parsed = inputPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) { acknowledge?.({ ok: false, reason: "invalid-direction" }); return; }
    const payload: InputPayload = parsed.data;
    const sessionId = payload.sessionId ?? payload.clientId!;
    const receivedAt = Date.now();
    const room = roomStore.get(payload.roomCode);
    let result: InputResult;
    if (!room || (socket.data as SocketData).sessionId !== sessionId) result = { ok: false, reason: "unknown-player" };
    else result = room.handleInput(sessionId, payload);
    const latency = Math.max(0, Date.now() - payload.sentAt);
    stats.totalInputEvents += 1;
    stats.inputTimes.push(receivedAt);
    pushWindow(stats.inputLatenciesMs, latency);
    if (!result.ok) stats.rejectedInputEvents += 1;
    metrics.gameInputEvents.inc({ result: result.ok ? "accepted" : result.reason ?? "rejected" });
    if (room) {
      setIdentity(room);
      metrics.gameInputQueueDelay.observe({ room_id: room.roomCode, version: room.snapshot().server.version, cluster: room.snapshot().server.cluster }, latency / 1000);
    }
    acknowledge?.(result);
  };

  io.on("connection", (socket) => {
    socket.on("spectator_subscribe", (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => acknowledge?.(watchRoom(socket, String(payload.roomCode ?? "").toUpperCase(), "watcher")));
    socket.on("room.watch", (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => acknowledge?.(watchRoom(socket, String(payload.roomCode ?? "").toUpperCase(), "watcher")));
    socket.on("ops.watch", async (acknowledge?: (snapshot: OpsSnapshot) => void) => {
      const data = socket.data as SocketData;
      if (data.role !== "admin") data.role = "ops";
      void socket.join("ops");
      acknowledge?.(await getOpsSnapshot());
    });
    socket.on("admin_subscribe", (payload: { token?: string }, acknowledge?: (result: { ok: boolean }) => void) => {
      const ok = payload.token === adminToken;
      if (ok) { (socket.data as SocketData).role = "admin"; void socket.join("ops"); }
      acknowledge?.({ ok });
    });
    socket.on("admin.room.watch", (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => {
      if ((socket.data as SocketData).role !== "admin") {
        acknowledge?.({ ok: false, error: "Unauthorized" });
        return;
      }
      acknowledge?.(joinRoomChannel(socket, String(payload.roomCode ?? "").toUpperCase()));
    });
    const join = (rawPayload: unknown, acknowledge?: (result: JoinResult) => void) => {
      const parsed = joinPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) { acknowledge?.({ ok: false, error: "Invalid join payload" }); return; }
      const payload = parsed.data;
      const sessionId = payload.sessionId ?? payload.clientId!;
      const room = roomStore.get(payload.roomCode);
      if (!room) { acknowledge?.({ ok: false, error: "Room not found" }); return; }
      const joined = room.join(sessionId, socket.id, payload.nickname, payload.isBot ?? false);
      (socket.data as SocketData).role = "controller";
      (socket.data as SocketData).roomCode = room.roomCode;
      (socket.data as SocketData).sessionId = sessionId;
      void socket.join(roomChannel(room.roomCode));
      setIdentity(room);
      if (joined.reconnected) {
        stats.reconnects += 1;
        metrics.gameClientReconnects.inc({ room_id: room.roomCode, version: room.snapshot().server.version, cluster: room.snapshot().server.cluster });
        socket.emit("reconnect_status", { status: "restored", roomCode: room.roomCode });
      }
      socket.emit("join_accepted", joined.player);
      socket.emit("team.assigned", joined.player);
      const snapshot = room.snapshot();
      socket.emit("room_snapshot", snapshot);
      acknowledge?.({ ok: true, player: joined.player, snapshot, sessionId, socketPath, reconnected: joined.reconnected });
      // Presence changes use the normal delta path so large-world load tests do
      // not rebroadcast the entire grid once for every joining bot.
      broadcastTick(room);
    };
    socket.on("join_room", join);
    socket.on("resume_session", join);
    socket.on("room.join", join);
    socket.on("player_input", (payload: unknown, acknowledge?: (result: InputResult) => void) => processInput(socket, payload, acknowledge));
    socket.on("game.input", (payload: unknown, acknowledge?: (result: InputResult) => void) => processInput(socket, payload, acknowledge));
    socket.on("client_ping", (payload: { sentAt?: number }, acknowledge?: (result: { sentAt: number; serverTimestamp: number }) => void) => {
      const sentAt = numeric(payload?.sentAt, Date.now());
      const rtt = Math.max(0, Date.now() - sentAt);
      pushWindow(stats.rttValuesMs, rtt);
      acknowledge?.({ sentAt, serverTimestamp: Date.now() });
    });
    socket.on("disconnect", () => {
      stats.disconnects += 1;
      const data = socket.data as SocketData;
      if (data.role === "controller" && data.roomCode && data.sessionId) {
        const room = roomStore.get(data.roomCode);
        if (room?.disconnect(data.sessionId)) broadcastSnapshot(room);
      }
    });
  });

  const start = async (port = Number(process.env.PORT ?? 3001), host = process.env.HOST ?? "0.0.0.0"): Promise<RunningGameServer> => {
    await storage.connect();
    await recoverAvailableRooms();
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => { httpServer.off("error", reject); resolve(); });
    });
    const address = httpServer.address() as AddressInfo;
    boundUrl = `http://127.0.0.1:${address.port}`;
    tickTimer = setInterval(() => void runTicks(), 100);
    opsTimer = setInterval(() => void getOpsSnapshot().then((snapshot) => io.to("ops").emit("ops.snapshot", snapshot)), 1000);
    snapshotTimer = setInterval(() => void persistRooms().catch((error) => addEvent("snapshot.failed", error instanceof Error ? error.message : "Snapshot failed", "system")), snapshotIntervalMs);
    leaseTimer = setInterval(() => {
      void maintainLeasesAndRecover().catch((error) => addEvent(
        "lease.maintenance.failed",
        error instanceof Error ? error.message : "Lease maintenance failed",
        "system",
      ));
    }, 2000);

    if (process.env.DEMO_AUTO_SEED === "true" && roomStore.list().length === 0) {
      const room = roomStore.create(DEFAULT_GAME_CONFIG);
      await storage.acquireLease(room.roomCode, ownerId, leaseTtlMs);
      addEvent("room.seeded", `Demo room ${room.roomCode} seeded`, "system", room.roomCode);
      const botCount = Math.max(0, Math.min(500, Math.round(numeric(process.env.DEMO_BOT_COUNT, 0))));
      if (botCount > 0) botManager.add(room.roomCode, botCount);
    }
    return { port: address.port, url: boundUrl };
  };

  const stop = async (): Promise<void> => {
    botManager.stopAll();
    if (tickTimer) clearInterval(tickTimer);
    if (opsTimer) clearInterval(opsTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    for (const timer of announcementTimers.values()) clearTimeout(timer);
    announcementTimers.clear();
    eventLoopDelay.disable();
    tickTimer = null;
    opsTimer = null;
    snapshotTimer = null;
    leaseTimer = null;
    if (storage.isReady()) {
      await persistRooms();
      for (const room of roomStore.list()) await storage.releaseLease(room.roomCode, ownerId);
    }
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await storage.close();
  };

  return { app, httpServer, io, store: roomStore, storage, start, stop, getOpsSnapshot, getSystemStatus };
};
