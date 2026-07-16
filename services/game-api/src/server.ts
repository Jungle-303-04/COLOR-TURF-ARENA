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
  type MemoryOomFaultStatus,
  type OpsEventPayload,
  type OpsSnapshot,
  type PublicConfig,
  type RoomSnapshot,
  type ServerIdentity,
  type SystemStatus,
  type VersionInfo,
  type WatchResult,
} from "@paint-arena/shared";
import { BotManager } from "./bots.js";
import { DEFAULT_GAME_CONFIG, DEFAULT_WORLD_SIZE, GameRoom, type GameEvent } from "./game.js";
import { KubernetesObserver } from "./kubernetes.js";
import { createMetrics } from "./metrics.js";
import { RedisRoomCoordinator, RedisSocketCluster } from "./redis-cluster.js";
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
  socketPath?: string;
  stableSocketPath?: string;
  canarySocketPath?: string;
  canaryApiUrl?: string;
  partitionRoomsByRelease?: boolean;
  demoTickDelayMs?: number;
  memoryOomAllocate?: (bytes: number) => Buffer;
  memoryOomSchedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  memoryOomChunkBytes?: number;
  memoryOomIntervalMs?: number;
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

type RoomClusterCommand =
  | { kind: "snapshot"; roomCode: string }
  | { kind: "join"; roomCode: string; sessionId: string; socketId: string; nickname?: string; isBot: boolean }
  | { kind: "input"; roomCode: string; sessionId: string; payload: InputPayload }
  | { kind: "disconnect"; roomCode: string; sessionId: string; socketId: string }
  | { kind: "action"; roomCode: string; action: string }
  | { kind: "update"; roomCode: string; patch: Parameters<GameRoom["updateConfig"]>[0] }
  | { kind: "paint-boost"; roomCode: string; durationMs: number }
  | { kind: "announce"; roomCode: string; message: string }
  | { kind: "bots"; roomCode: string; action: "add" | "remove"; count: number };

interface RoomClusterResponse {
  handled: boolean;
  snapshot?: RoomSnapshot;
  join?: JoinResult;
  input?: InputResult;
  sessionIds?: string[];
  error?: string;
}

export const DEFAULT_TICK_RATE_HZ = 30;
const DEFAULT_TICK_INTERVAL_MS = 1000 / DEFAULT_TICK_RATE_HZ;

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
  const processReleaseChannel = options.releaseChannel ?? (process.env.RELEASE_CHANNEL === "canary" ? "canary" : "stable");
  const socketPath = options.socketPath ?? process.env.SOCKET_PATH ?? "/socket.io";
  const stableSocketPath = options.stableSocketPath
    ?? process.env.STABLE_SOCKET_PATH
    ?? (processReleaseChannel === "stable" ? socketPath : "/socket.io");
  const canarySocketPath = options.canarySocketPath
    ?? process.env.CANARY_SOCKET_PATH
    ?? (processReleaseChannel === "canary" ? socketPath : "/socket/canary");
  const canaryApiUrl = (options.canaryApiUrl ?? process.env.CANARY_API_URL ?? "").replace(/\/$/, "");
  const partitionRoomsByRelease = options.partitionRoomsByRelease
    ?? process.env.PARTITION_ROOMS_BY_RELEASE === "true";
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
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const socketCluster = redisUrl ? new RedisSocketCluster(redisUrl) : null;
  const roomCoordinator = redisUrl
    ? new RedisRoomCoordinator<RoomClusterCommand, RoomClusterResponse>(redisUrl, ownerId)
    : null;
  const leaseTtlMs = 7000;
  const snapshotIntervalMs = Math.max(250, options.snapshotIntervalMs ?? numeric(process.env.SNAPSHOT_INTERVAL_MS, 1000));
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "demo-admin";
  const demoAdminAuthDisabled = process.env.DEMO_ADMIN_AUTH_DISABLED === "true";
  const singleUseMode = process.env.SINGLE_USE_GAME === "true";
  const opsEventToken = options.opsEventToken ?? process.env.OPS_EVENT_TOKEN ?? "demo-ops";
  const stableVersion = options.appVersion ?? process.env.SERVER_VERSION ?? process.env.APP_VERSION ?? "v1.1.3";
  const canaryVersion = process.env.CANARY_SERVER_VERSION ?? "v1.2.0";
  const configuredBroadcastMode = options.broadcastMode ?? (process.env.BROADCAST_MODE === "full" ? "full" : "delta");
  const configuredTickDelayMs = Math.max(0, options.demoTickDelayMs ?? numeric(process.env.DEMO_TICK_DELAY_MS, 0));
  let boundUrl = "http://127.0.0.1:3001";
  let tickRunning = false;
  let tickSchedulerActive = false;
  let nextTickAt = 0;
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
  const persistedSnapshotAtByRoom = new Map<string, number>();
  let lastCpuUsage = process.cpuUsage();
  let lastCpuSampleAt = Date.now();
  const runtimeMode = {
    latencyMs: configuredTickDelayMs,
    forceFullBroadcast: configuredBroadcastMode === "full",
    activeCluster: options.clusterName ?? (
      process.env.CLUSTER_NAME === "dr" || process.env.CLUSTER_NAME === "cluster-1" || process.env.CLUSTER_NAME === "cluster-2"
        ? process.env.CLUSTER_NAME
        : "primary"
    ),
  };

  let tickTimer: NodeJS.Timeout | null = null;
  let opsTimer: NodeJS.Timeout | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  let memoryOomTimer: NodeJS.Timeout | null = null;
  const retainedFaultMemory: Buffer[] = [];
  const memoryOomChunkBytes = Math.max(1024 * 1024, options.memoryOomChunkBytes ?? numeric(process.env.OOM_LEAK_CHUNK_MIB, 4) * 1024 * 1024);
  const memoryOomIntervalMs = Math.max(100, options.memoryOomIntervalMs ?? numeric(process.env.OOM_LEAK_INTERVAL_MS, 250));
  const memoryOomAllocate = options.memoryOomAllocate ?? ((bytes: number) => Buffer.alloc(bytes, 0xa5));
  const memoryOomSchedule = options.memoryOomSchedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  let memoryOomFault: MemoryOomFaultStatus = {
    kind: "memory-oom",
    phase: "idle",
    targetPod: null,
    requestedAt: null,
    observedAt: new Date().toISOString(),
    allocatedMiB: 0,
    restartCount: null,
    lastTerminationReason: null,
    lastTerminatedAt: null,
    message: "실제 메모리 장애를 주입하지 않았습니다.",
  };
  const announcementTimers = new Map<string, NodeJS.Timeout>();
  const pendingEventWrites = new Map<string, Promise<boolean>>();

  const baseIdentity = (): ServerIdentity => ({
    version: stableVersion,
    gitSha: options.gitSha ?? process.env.GIT_SHA ?? "local",
    podName: options.podName ?? process.env.POD_NAME ?? "local-process",
    cluster: runtimeMode.activeCluster,
    releaseChannel: processReleaseChannel,
    broadcastMode: runtimeMode.forceFullBroadcast ? "full" : configuredBroadcastMode,
  });

  const roomSocketPath = (releaseChannel: "stable" | "canary"): string => {
    if (releaseChannel === "stable") return stableSocketPath;
    return canaryApiUrl || processReleaseChannel === "canary" ? canarySocketPath : socketPath;
  };

  const roomIdentity = (room: GameRoom): ServerIdentity => ({
    ...baseIdentity(),
    version: room.releaseChannel === "canary" ? canaryVersion : stableVersion,
    releaseChannel: room.releaseChannel,
    broadcastMode: runtimeMode.forceFullBroadcast || room.releaseChannel === "canary" ? "full" : configuredBroadcastMode,
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
    const persistence = storage.appendEvent(entry)
      .then(() => true)
      .catch((error: unknown) => {
        if (process.env.NODE_ENV !== "test") {
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            message: "shared ops event persistence failed",
            eventId: entry.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        return false;
      });
    pendingEventWrites.set(entry.id, persistence);
    void persistence.finally(() => {
      if (pendingEventWrites.get(entry.id) === persistence) pendingEventWrites.delete(entry.id);
    });
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

  const syncSharedEvents = async (): Promise<void> => {
    try {
      const sharedEvents = await storage.loadRecentEvents(200);
      const merged = new Map<string, EventLogEntry>();
      for (const entry of events) merged.set(entry.id, entry);
      for (const entry of sharedEvents) if (!merged.has(entry.id)) merged.set(entry.id, entry);
      const ordered = [...merged.values()]
        .sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0))
        .slice(0, 200);
      events.splice(0, events.length, ...ordered);
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "shared ops event load failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
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

  const snapshotAgeSamples = (now = Date.now()) => roomStore.list().flatMap((room) => {
    const snapshotCreatedAt = persistedSnapshotAtByRoom.get(room.roomCode);
    if (snapshotCreatedAt === undefined) return [];
    return [{
      roomCode: room.roomCode,
      cluster: baseIdentity().cluster,
      ageSeconds: Math.max(0, (now - snapshotCreatedAt) / 1000),
    }];
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
    await syncSharedEvents();
    const now = Date.now();
    const cpuUsage = process.cpuUsage();
    const wallMicros = Math.max(1, (now - lastCpuSampleAt) * 1000);
    stats.cpuPercent = Math.min(100, Math.max(0, ((cpuUsage.user - lastCpuUsage.user) + (cpuUsage.system - lastCpuUsage.system)) / wallMicros * 100));
    lastCpuUsage = cpuUsage;
    lastCpuSampleAt = now;
    stats.inputTimes = stats.inputTimes.filter((time) => time > now - 1000);
    const summaries = await clusterRoomSummaries();
    const infrastructure = await kubernetes.observe();
    const observedOomPod = infrastructure.pods
      .filter((pod) => pod.lastTerminationReason === "OOMKilled"
        && pod.lastTerminatedAt
        && new Date(pod.lastTerminatedAt).getTime() >= now - 15 * 60_000)
      .sort((left, right) => (right.lastTerminatedAt ?? "").localeCompare(left.lastTerminatedAt ?? ""))[0];
    if (observedOomPod) {
      memoryOomFault = {
        ...memoryOomFault,
        phase: observedOomPod.ready ? "recovered" : "restarting",
        targetPod: observedOomPod.name,
        observedAt: infrastructure.observedAt,
        restartCount: observedOomPod.restarts,
        lastTerminationReason: observedOomPod.lastTerminationReason,
        lastTerminatedAt: observedOomPod.lastTerminatedAt,
        message: observedOomPod.ready
          ? "Kubernetes가 OOMKilled를 기록했고 컨테이너가 다시 Ready 상태가 되었습니다."
          : "Kubernetes가 OOMKilled를 기록했고 컨테이너를 다시 시작하고 있습니다.",
      };
    }
    metrics.refresh(baseIdentity(), io.engine.clientsCount, summaries, snapshotAgeSamples(now));
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
      infrastructure,
      faultInjection: { ...memoryOomFault },
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
    if (request) {
      const forwardedHost = request.get("x-forwarded-host")?.split(",")[0]?.trim();
      return `${request.protocol}://${forwardedHost || request.get("host")}`;
    }
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
  const requireAdmin = demoAdminAuthDisabled
    ? (_request: Request, _response: Response, next: NextFunction) => next()
    : requireToken(adminToken);
  const requireOpsEvent = requireToken(opsEventToken);

  const forwardCanaryRoomCreation = async (request: Request, response: Response): Promise<void> => {
    try {
      const upstream = await fetch(`${canaryApiUrl}/api/rooms`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
          "x-forwarded-host": request.get("host") ?? "",
          "x-forwarded-proto": request.protocol,
        },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(5000),
      });
      const rawBody = await upstream.text();
      let body: unknown;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        response.status(502).json({ error: "Canary room service returned an invalid response" });
        return;
      }
      response.status(upstream.status).json(body);
    } catch (error) {
      response.status(502).json({
        error: `Canary room service unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  };

  const forwardCanaryOps = async (response: Response): Promise<void> => {
    try {
      const upstream = await fetch(`${canaryApiUrl}/api/ops`, {
        signal: AbortSignal.timeout(3000),
      });
      const rawBody = await upstream.text();
      let body: unknown;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        response.status(502).json({ error: "Canary telemetry service returned an invalid response" });
        return;
      }
      response.status(upstream.status).json(body);
    } catch (error) {
      response.status(502).json({
        error: `Canary telemetry service unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  };

  const saveRoomSnapshot = async (room: GameRoom): Promise<void> => {
    setIdentity(room);
    const started = performance.now();
    const state = room.serialize();
    await storage.save(state);
    const elapsed = performance.now() - started;
    persistedSnapshotAtByRoom.set(room.roomCode, state.snapshotCreatedAt);
    stats.lastSnapshotAt = Math.max(stats.lastSnapshotAt ?? 0, state.snapshotCreatedAt);
    metrics.gameSnapshotSaveDuration.observe({ cluster: baseIdentity().cluster }, elapsed / 1000);
  };

  const persistRooms = async () => {
    const activeRoom = singleUseMode ? await storage.activeRoomCode() : null;
    for (const room of roomStore.list()) {
      if (activeRoom && room.roomCode !== activeRoom) {
        botManager.stopRoom(room.roomCode, false);
        roomStore.remove(room.roomCode);
        persistedSnapshotAtByRoom.delete(room.roomCode);
        await storage.releaseLease(room.roomCode, ownerId);
        addEvent("room.expired", `Removed stale room ${room.roomCode} in single-use mode`, "system", room.roomCode);
        continue;
      }
      await saveRoomSnapshot(room);
    }
  };

  const recoverAvailableRooms = async (): Promise<number> => {
    let recovered = 0;
    const persistedRooms = await storage.loadAll();
    const hasLiveSessions = persistedRooms.some((state) => state.players.some((player) => player.connected && player.socketId));
    const liveSocketIds = hasLiveSessions
      ? new Set((await io.fetchSockets()).map((socket) => socket.id))
      : new Set<string>();
    for (const state of persistedRooms) {
      if (roomStore.get(state.roomCode)) continue;
      if (partitionRoomsByRelease && state.config.releaseChannel !== processReleaseChannel) continue;
      if (!(await storage.acquireLease(state.roomCode, ownerId, leaseTtlMs))) continue;
      const recoveryStarted = performance.now();
      const room = roomStore.restore(state, true);
      persistedSnapshotAtByRoom.set(room.roomCode, state.snapshotCreatedAt);
      stats.lastSnapshotAt = Math.max(stats.lastSnapshotAt ?? 0, state.snapshotCreatedAt);
      for (const player of state.players) {
        if (player.connected && player.socketId && !liveSocketIds.has(player.socketId)) {
          room.disconnect(player.id, player.socketId);
        }
      }
      const restoredBots = botManager.restore(
        room.roomCode,
        state.players
          .filter((player) => player.isBot)
          .map((player) => ({ sessionId: player.id, nickname: player.nickname, lastSequence: player.lastSequence })),
      );
      setIdentity(room);
      const elapsed = (performance.now() - recoveryStarted) / 1000;
      metrics.gameRoomRecoveryDuration.observe({
        room_id: room.roomCode,
        source_cluster: state.serverIdentity.cluster,
        target_cluster: baseIdentity().cluster,
      }, elapsed);
      addEvent("SNAPSHOT_RESTORED", `Recovered room ${room.roomCode} from ${storage.kind}`, "system", room.roomCode, {
        recoveryTimeMs: Math.round(elapsed * 1000),
        restoredBots: restoredBots.length,
      });
      // Existing clients may still be connected to healthy gateway replicas.
      // Publish the recovered snapshot so play resumes without waiting for a
      // browser reconnect after the authority pod rolls.
      broadcastSnapshot(room);
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
        botManager.stopRoom(room.roomCode, false);
        roomStore.remove(room.roomCode);
        persistedSnapshotAtByRoom.delete(room.roomCode);
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
      if (runtimeMode.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, runtimeMode.latencyMs));
      for (const room of roomStore.list()) {
        const started = performance.now();
        const changed = room.tick();
        const elapsed = performance.now() - started + runtimeMode.latencyMs;
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

  const scheduleNextTick = () => {
    if (!tickSchedulerActive) return;
    const delayMs = Math.max(0, nextTickAt - performance.now());
    tickTimer = setTimeout(() => {
      tickTimer = null;
      void runTicks().finally(() => {
        if (!tickSchedulerActive) return;
        nextTickAt += DEFAULT_TICK_INTERVAL_MS;
        const now = performance.now();
        if (nextTickAt <= now) nextTickAt = now + DEFAULT_TICK_INTERVAL_MS;
        scheduleNextTick();
      });
    }, delayMs);
  };

  const botManager = new BotManager(
    // In Kubernetes, route bot sockets through the Service so each connection
    // exercises a real gateway replica. Local development stays in-process.
    () => process.env.BOT_GATEWAY_URL?.replace(/\/$/, "") || boundUrl,
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

  const executeLocalRoomCommand = async (command: RoomClusterCommand): Promise<RoomClusterResponse> => {
    const room = roomStore.get(command.roomCode);
    if (!room) return { handled: false };
    try {
      if (command.kind === "snapshot") {
        setIdentity(room);
        return { handled: true, snapshot: room.snapshot() };
      }
      if (command.kind === "join") {
        const joined = room.join(command.sessionId, command.socketId, command.nickname, command.isBot);
        setIdentity(room);
        const snapshot = room.snapshot();
        broadcastTick(room);
        return {
          handled: true,
          snapshot,
          join: {
            ok: true,
            player: joined.player,
            snapshot,
            sessionId: command.sessionId,
            socketPath: roomSocketPath(snapshot.config.releaseChannel),
            reconnected: joined.reconnected,
          },
        };
      }
      if (command.kind === "input") {
        return { handled: true, input: room.handleInput(command.sessionId, command.payload) };
      }
      if (command.kind === "disconnect") {
        if (room.disconnect(command.sessionId, command.socketId)) broadcastSnapshot(room);
        return { handled: true };
      }
      if (command.kind === "action") {
        roomAction(room, command.action);
        return { handled: true, snapshot: broadcastSnapshot(room) };
      }
      if (command.kind === "update") {
        room.updateConfig(command.patch);
        return { handled: true, snapshot: broadcastSnapshot(room) };
      }
      if (command.kind === "paint-boost") {
        room.activatePaintBoost(command.durationMs);
        return { handled: true, snapshot: broadcastSnapshot(room) };
      }
      if (command.kind === "announce") {
        room.announce(command.message);
        broadcastTick(room);
        const existingTimer = announcementTimers.get(room.roomCode);
        if (existingTimer) clearTimeout(existingTimer);
        if (command.message) {
          announcementTimers.set(room.roomCode, setTimeout(() => {
            announcementTimers.delete(room.roomCode);
            const current = roomStore.get(room.roomCode);
            if (!current || current.snapshot().announcement !== command.message) return;
            current.announce("");
            broadcastTick(current);
          }, 2500));
        }
        return { handled: true, snapshot: room.snapshot() };
      }

      const sessionIds = command.action === "add"
        ? botManager.add(room.roomCode, command.count)
        : botManager.remove(room.roomCode, command.count);
      addEvent(
        `bot.${command.action}`,
        `${sessionIds.length} bot(s) ${command.action === "add" ? "started" : "removed"}`,
        "admin",
        room.roomCode,
      );
      return { handled: true, sessionIds };
    } catch (error) {
      return {
        handled: true,
        error: error instanceof Error ? error.message : "Room command failed",
      };
    }
  };

  const dispatchRoomCommand = async (command: RoomClusterCommand): Promise<RoomClusterResponse> => {
    if (!roomCoordinator) return executeLocalRoomCommand(command);
    return await roomCoordinator.request(command.roomCode, command) ?? { handled: false };
  };

  const clusterRoomSummaries = async () => {
    const states = await storage.loadAll();
    const roomCodes = new Set([
      ...states.map((state) => state.roomCode),
      ...roomStore.list().map((room) => room.roomCode),
    ]);
    const byCode = new Map(states.map((state) => [state.roomCode, state]));
    return (await Promise.all([...roomCodes].map(async (roomCode) => {
      const response = await dispatchRoomCommand({ kind: "snapshot", roomCode });
      if (response.snapshot) return summarizeRoom(response.snapshot);
      const persisted = byCode.get(roomCode);
      return persisted ? summarizeRoom(GameRoom.restore(persisted).snapshot()) : null;
    }))).filter((summary): summary is NonNullable<typeof summary> => summary !== null);
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
    metrics.refresh(baseIdentity(), io.engine.clientsCount, roomSummaries(), snapshotAgeSamples());
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
      tickRateHz: DEFAULT_TICK_RATE_HZ,
      adminTokenRequired: !demoAdminAuthDisabled,
    };
    response.json(config);
  });

  app.get("/api/rooms", async (_request, response) => response.json({ rooms: await clusterRoomSummaries() }));
  app.post("/api/rooms", requireAdmin, async (request, response) => {
    const requestedConfig = createConfig(request.body as Record<string, unknown>);
    if (requestedConfig.releaseChannel === "canary" && canaryApiUrl && processReleaseChannel !== "canary") {
      await forwardCanaryRoomCreation(request, response);
      return;
    }
    if (processReleaseChannel === "canary" && requestedConfig.releaseChannel !== "canary") {
      response.status(409).json({ error: "Canary authority only creates canary rooms" });
      return;
    }
    if (singleUseMode) {
      const activeRoomCode = await storage.activeRoomCode();
      if (activeRoomCode) {
        const existing = await loadRoom(activeRoomCode);
        if (existing.snapshot) {
          response.status(200).json({
            room: existing.snapshot,
            joinUrl: `${resolvePublicBaseUrl(request)}/play/${existing.snapshot.roomCode}`,
            screenUrl: `${resolvePublicBaseUrl(request)}/watch/${existing.snapshot.roomCode}`,
            socketPath: roomSocketPath(existing.snapshot.config.releaseChannel),
            reused: true,
          });
          return;
        }
      }
    }
    const room = roomStore.create(requestedConfig);
    if (singleUseMode) {
      await storage.activateSingleRoom(room.roomCode);
      for (const stale of [...roomStore.list()]) {
        if (stale.roomCode === room.roomCode) continue;
        botManager.stopRoom(stale.roomCode, false);
        roomStore.remove(stale.roomCode);
        persistedSnapshotAtByRoom.delete(stale.roomCode);
        await storage.releaseLease(stale.roomCode, ownerId);
      }
      addEvent("single_use.reset", `Activated ${room.roomCode} and removed every previous game`, "admin", room.roomCode);
    }
    await storage.acquireLease(room.roomCode, ownerId, leaseTtlMs);
    await saveRoomSnapshot(room);
    addEvent("room.created", `Room ${room.roomCode} created`, "admin", room.roomCode);
    const snapshot = broadcastSnapshot(room);
    response.status(201).json({
      room: snapshot,
      joinUrl: `${resolvePublicBaseUrl(request)}/play/${room.roomCode}`,
      screenUrl: `${resolvePublicBaseUrl(request)}/watch/${room.roomCode}`,
      socketPath: roomSocketPath(snapshot.config.releaseChannel),
    });
  });
  const loadRoom = async (roomCode: string) => dispatchRoomCommand({ kind: "snapshot", roomCode });

  app.get("/api/rooms/:roomCode", async (request, response) => {
    const result = await loadRoom(String(request.params.roomCode ?? ""));
    if (!result.snapshot) { response.status(404).json({ error: "Room not found" }); return; }
    response.json({ room: result.snapshot });
  });
  app.get("/api/rooms/:roomCode/state", async (request, response) => {
    const result = await loadRoom(String(request.params.roomCode ?? ""));
    if (!result.snapshot) { response.status(404).json({ error: "Room not found" }); return; }
    response.json({ room: result.snapshot });
  });
  app.post("/api/rooms/:roomCode/join", async (request, response) => {
    const result = await loadRoom(String(request.params.roomCode ?? ""));
    if (!result.snapshot) { response.status(404).json({ error: "Room not found" }); return; }
    response.json({
      roomId: result.snapshot.roomCode,
      releaseChannel: result.snapshot.config.releaseChannel,
      socketPath: roomSocketPath(result.snapshot.config.releaseChannel),
      sessionId: randomUUID(),
    });
  });
  app.patch("/api/rooms/:roomCode", requireAdmin, async (request, response) => {
    const result = await dispatchRoomCommand({
      kind: "update",
      roomCode: String(request.params.roomCode ?? ""),
      patch: request.body as Parameters<GameRoom["updateConfig"]>[0],
    });
    if (!result.handled) { response.status(404).json({ error: "Room not found" }); return; }
    if (result.error || !result.snapshot) { response.status(409).json({ error: result.error ?? "Unable to update room" }); return; }
    response.json({ room: result.snapshot });
  });

  const actionHandler = (action: string) => async (request: Request, response: Response) => {
    const result = await dispatchRoomCommand({
      kind: "action",
      roomCode: String(request.params.roomCode ?? ""),
      action,
    });
    if (!result.handled) { response.status(404).json({ error: "Room not found" }); return; }
    if (result.error || !result.snapshot) { response.status(409).json({ error: result.error ?? "Action failed" }); return; }
    response.json({ room: result.snapshot });
  };

  app.post("/api/rooms/:roomCode/actions", requireAdmin, (request, response) => actionHandler(String((request.body as Record<string, unknown>).action ?? ""))(request, response));
  for (const action of ["start", "pause", "resume", "reset", "stop"] as const) {
    app.post(`/api/admin/rooms/:roomCode/${action}`, requireAdmin, actionHandler(action));
  }
  app.post("/api/admin/rooms/:roomCode/reassign", requireAdmin, actionHandler("reassign"));
  app.post("/api/admin/rooms/:roomCode/events/paint-boost", requireAdmin, async (request, response) => {
    const durationMs = numeric((request.body as Record<string, unknown>).durationMs, 10_000);
    const result = await dispatchRoomCommand({
      kind: "paint-boost",
      roomCode: String(request.params.roomCode ?? ""),
      durationMs,
    });
    if (!result.handled) { response.status(404).json({ error: "Room not found" }); return; }
    if (result.error || !result.snapshot) { response.status(409).json({ error: result.error ?? "Action failed" }); return; }
    response.json({ room: result.snapshot });
  });
  app.post("/api/admin/rooms/:roomCode/announcement", requireAdmin, async (request, response) => {
    const message = String((request.body as Record<string, unknown>).message ?? "").trim().slice(0, 160);
    const result = await dispatchRoomCommand({
      kind: "announce",
      roomCode: String(request.params.roomCode ?? ""),
      message,
    });
    if (!result.handled) { response.status(404).json({ error: "Room not found" }); return; }
    if (result.error || !result.snapshot) { response.status(409).json({ error: result.error ?? "Action failed" }); return; }
    response.json({ room: result.snapshot });
  });
  app.post("/api/admin/rooms/:roomCode/bots", requireAdmin, async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const count = Math.max(1, Math.min(500, Math.round(numeric(body.count, 1))));
    const action = body.action === "remove" ? "remove" : "add";
    const result = await dispatchRoomCommand({
      kind: "bots",
      roomCode: String(request.params.roomCode ?? ""),
      action,
      count,
    });
    if (!result.handled) { response.status(404).json({ error: "Room not found" }); return; }
    if (result.error) { response.status(409).json({ error: result.error }); return; }
    const sessionIds = result.sessionIds ?? [];
    response.json({ action, count: sessionIds.length, sessionIds });
  });

  app.get("/api/ops", async (request, response) => {
    const requestedChannel = request.query.releaseChannel === "canary" ? "canary" : "stable";
    if (requestedChannel === "canary" && canaryApiUrl && processReleaseChannel !== "canary") {
      await forwardCanaryOps(response);
      return;
    }
    response.json(await getOpsSnapshot());
  });
  app.get("/api/ops/events", async (_request, response) => {
    await syncSharedEvents();
    response.json({ events: events.slice(0, 100) });
  });
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
    const persisted = await (pendingEventWrites.get(entry.id) ?? Promise.resolve(false));
    if (!persisted) {
      response.status(503).json({ accepted: false, error: "Shared ops event persistence failed", event: entry });
      return;
    }
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

  const allocateMemoryUntilKilled = () => {
    if (memoryOomFault.phase !== "allocating") return;
    try {
      // Buffer.alloc touches every page. The cgroup, not an application flag,
      // terminates this process once the real container memory limit is hit.
      retainedFaultMemory.push(memoryOomAllocate(memoryOomChunkBytes));
      memoryOomFault = {
        ...memoryOomFault,
        allocatedMiB: retainedFaultMemory.reduce((sum, value) => sum + value.byteLength, 0) / 1024 / 1024,
        observedAt: new Date().toISOString(),
        message: "실제 메모리를 계속 점유하고 있습니다. Kubernetes OOMKilled 판정을 기다리는 중입니다.",
      };
      memoryOomTimer = memoryOomSchedule(allocateMemoryUntilKilled, memoryOomIntervalMs);
    } catch (error) {
      memoryOomFault = {
        ...memoryOomFault,
        phase: "failed",
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "메모리 장애 주입 중 오류가 발생했습니다.",
      };
      addEvent("fault.memory-oom.failed", memoryOomFault.message, "fault", null, { podName: baseIdentity().podName });
    }
  };

  app.post("/api/admin/faults/memory-oom", requireAdmin, async (_request, response) => {
    if (process.env.ALLOW_DEMO_OOM_KILL !== "true") {
      response.status(409).json({ error: "이 환경에서는 실제 OOMKilled 장애 주입이 비활성화되어 있습니다." });
      return;
    }
    if (memoryOomFault.phase === "allocating") {
      response.status(409).json({ error: "이 Pod에서 실제 메모리 장애 주입이 이미 진행 중입니다." });
      return;
    }
    const requestedAt = new Date().toISOString();
    memoryOomFault = {
      kind: "memory-oom",
      phase: "allocating",
      targetPod: baseIdentity().podName,
      requestedAt,
      observedAt: requestedAt,
      allocatedMiB: 0,
      restartCount: null,
      lastTerminationReason: null,
      lastTerminatedAt: null,
      message: "실제 메모리 누수를 시작했습니다. 할당량과 Pod 상태를 관측하고 있습니다.",
    };
    addEvent("fault.memory-oom.started", "Actual memory leak started; waiting for Kubernetes OOMKilled and restart", "fault", null, {
      podName: baseIdentity().podName,
      chunkMiB: memoryOomChunkBytes / 1024 / 1024,
      intervalMs: memoryOomIntervalMs,
    });
    response.status(202).json(await getOpsSnapshot());
    memoryOomTimer = memoryOomSchedule(allocateMemoryUntilKilled, memoryOomIntervalMs);
  });

  const joinRoomChannel = async (socket: Socket, roomCode: string): Promise<WatchResult> => {
    const result = await loadRoom(roomCode);
    if (!result.snapshot) return { ok: false, error: "Room not found" };
    const data = socket.data as SocketData;
    if (data.roomCode && data.roomCode !== result.snapshot.roomCode) void socket.leave(roomChannel(data.roomCode));
    await socket.join(roomChannel(result.snapshot.roomCode));
    data.roomCode = result.snapshot.roomCode;
    return { ok: true, snapshot: result.snapshot };
  };

  const watchRoom = async (socket: Socket, roomCode: string, role: NonNullable<SocketData["role"]>): Promise<WatchResult> => {
    const result = await joinRoomChannel(socket, roomCode);
    if (result.ok) (socket.data as SocketData).role = role;
    return result;
  };

  const processInput = async (socket: Socket, rawPayload: unknown, acknowledge?: (result: InputResult) => void): Promise<void> => {
    const parsed = inputPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) { acknowledge?.({ ok: false, reason: "invalid-direction" }); return; }
    const payload: InputPayload = parsed.data;
    const sessionId = payload.sessionId ?? payload.clientId!;
    const receivedAt = Date.now();
    const response = (socket.data as SocketData).sessionId === sessionId
      ? await dispatchRoomCommand({ kind: "input", roomCode: payload.roomCode, sessionId, payload })
      : { handled: false };
    const result: InputResult = response.input ?? { ok: false, reason: "unknown-player" };
    const latency = Math.max(0, Date.now() - payload.sentAt);
    stats.totalInputEvents += 1;
    stats.inputTimes.push(receivedAt);
    pushWindow(stats.inputLatenciesMs, latency);
    if (!result.ok) stats.rejectedInputEvents += 1;
    metrics.gameInputEvents.inc({ result: result.ok ? "accepted" : result.reason ?? "rejected" });
    metrics.gameInputQueueDelay.observe({
      room_id: payload.roomCode.toUpperCase(),
      version: baseIdentity().version,
      cluster: baseIdentity().cluster,
    }, latency / 1000);
    acknowledge?.(result);
  };

  io.on("connection", (socket) => {
    socket.on("spectator_subscribe", async (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => acknowledge?.(await watchRoom(socket, String(payload.roomCode ?? "").toUpperCase(), "watcher")));
    socket.on("room.watch", async (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => acknowledge?.(await watchRoom(socket, String(payload.roomCode ?? "").toUpperCase(), "watcher")));
    socket.on("ops.watch", async (acknowledge?: (snapshot: OpsSnapshot) => void) => {
      const data = socket.data as SocketData;
      if (data.role !== "admin") data.role = "ops";
      void socket.join("ops");
      acknowledge?.(await getOpsSnapshot());
    });
    socket.on("admin_subscribe", (payload: { token?: string }, acknowledge?: (result: { ok: boolean }) => void) => {
      const ok = demoAdminAuthDisabled || payload.token === adminToken;
      if (ok) { (socket.data as SocketData).role = "admin"; void socket.join("ops"); }
      acknowledge?.({ ok });
    });
    socket.on("admin.room.watch", async (payload: { roomCode?: string }, acknowledge?: (result: WatchResult) => void) => {
      if ((socket.data as SocketData).role !== "admin") {
        acknowledge?.({ ok: false, error: "Unauthorized" });
        return;
      }
      acknowledge?.(await joinRoomChannel(socket, String(payload.roomCode ?? "").toUpperCase()));
    });
    const join = async (rawPayload: unknown, acknowledge?: (result: JoinResult) => void) => {
      const parsed = joinPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) { acknowledge?.({ ok: false, error: "Invalid join payload" }); return; }
      const payload = parsed.data;
      const sessionId = payload.sessionId ?? payload.clientId!;
      const response = await dispatchRoomCommand({
        kind: "join",
        roomCode: payload.roomCode,
        sessionId,
        socketId: socket.id,
        ...(payload.nickname ? { nickname: payload.nickname } : {}),
        isBot: payload.isBot ?? false,
      });
      const joined = response.join;
      if (!response.handled || !joined?.ok || !joined.snapshot || !joined.player) {
        acknowledge?.({ ok: false, error: response.error ?? "Room not found" });
        return;
      }
      (socket.data as SocketData).role = "controller";
      (socket.data as SocketData).roomCode = joined.snapshot.roomCode;
      (socket.data as SocketData).sessionId = sessionId;
      await socket.join(roomChannel(joined.snapshot.roomCode));
      if (joined.reconnected) {
        stats.reconnects += 1;
        metrics.gameClientReconnects.inc({
          room_id: joined.snapshot.roomCode,
          version: joined.snapshot.server.version,
          cluster: joined.snapshot.server.cluster,
        });
        socket.emit("reconnect_status", { status: "restored", roomCode: joined.snapshot.roomCode });
      }
      socket.emit("join_accepted", joined.player);
      socket.emit("team.assigned", joined.player);
      socket.emit("room_snapshot", joined.snapshot);
      acknowledge?.(joined);
    };
    socket.on("join_room", join);
    socket.on("resume_session", join);
    socket.on("room.join", join);
    socket.on("player_input", (payload: unknown, acknowledge?: (result: InputResult) => void) => void processInput(socket, payload, acknowledge));
    socket.on("game.input", (payload: unknown, acknowledge?: (result: InputResult) => void) => void processInput(socket, payload, acknowledge));
    socket.on("client_ping", (payload: { sentAt?: number }, acknowledge?: (result: { sentAt: number; serverTimestamp: number }) => void) => {
      const sentAt = numeric(payload?.sentAt, Date.now());
      acknowledge?.({ sentAt, serverTimestamp: Date.now() });
    });
    socket.on("client_rtt", (payload: { rttMs?: number }) => {
      const rttMs = numeric(payload?.rttMs, -1);
      if (rttMs >= 0 && rttMs <= 60_000) pushWindow(stats.rttValuesMs, rttMs);
    });
    socket.on("disconnect", () => {
      stats.disconnects += 1;
      const data = socket.data as SocketData;
      if (data.role === "controller" && data.roomCode && data.sessionId) {
        void dispatchRoomCommand({
          kind: "disconnect",
          roomCode: data.roomCode,
          sessionId: data.sessionId,
          socketId: socket.id,
        });
      }
    });
  });

  const start = async (port = Number(process.env.PORT ?? 3001), host = process.env.HOST ?? "0.0.0.0"): Promise<RunningGameServer> => {
    if (socketCluster) await socketCluster.attach(io);
    await storage.connect();
    if (roomCoordinator) await roomCoordinator.connect(executeLocalRoomCommand);
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => { httpServer.off("error", reject); resolve(); });
      });
    } catch (error) {
      if (roomCoordinator) await roomCoordinator.close();
      if (socketCluster) await socketCluster.close();
      await storage.close();
      throw error;
    }
    const address = httpServer.address() as AddressInfo;
    boundUrl = `http://127.0.0.1:${address.port}`;
    await recoverAvailableRooms();
    tickSchedulerActive = true;
    nextTickAt = performance.now() + DEFAULT_TICK_INTERVAL_MS;
    scheduleNextTick();
    // Every gateway computes the same cluster room summary, but only its local
    // admin sockets need that sample. Avoid N replicas broadcasting N copies.
    opsTimer = setInterval(() => void getOpsSnapshot().then((snapshot) => io.local.to("ops").emit("ops.snapshot", snapshot)), 1000);
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
    // Bots are part of the live room load. Preserve their sessions in the
    // snapshot so the next authority can recreate them after a rolling update.
    botManager.stopAll(false);
    tickSchedulerActive = false;
    if (tickTimer) clearTimeout(tickTimer);
    if (opsTimer) clearInterval(opsTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (memoryOomTimer) clearTimeout(memoryOomTimer);
    for (const timer of announcementTimers.values()) clearTimeout(timer);
    announcementTimers.clear();
    eventLoopDelay.disable();
    tickTimer = null;
    opsTimer = null;
    snapshotTimer = null;
    leaseTimer = null;
    memoryOomTimer = null;
    if (storage.isReady()) {
      await persistRooms();
      for (const room of roomStore.list()) await storage.releaseLease(room.roomCode, ownerId);
    }
    await Promise.allSettled([...pendingEventWrites.values()]);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    if (roomCoordinator) await roomCoordinator.close();
    if (socketCluster) await socketCluster.close();
    await storage.close();
  };

  return { app, httpServer, io, store: roomStore, storage, start, stop, getOpsSnapshot, getSystemStatus };
};
