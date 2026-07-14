import { z } from "zod";

export const TEAM_IDS = ["A", "B"] as const;
export const RELEASE_CHANNELS = ["stable", "canary"] as const;

export type TeamId = (typeof TEAM_IDS)[number];
export type RoomStatus = "lobby" | "running" | "paused" | "ended";
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export type ClusterName = "primary" | "dr";
export type BroadcastMode = "delta" | "full";

export interface Vector2 {
  x: number;
  y: number;
}

export interface TeamConfig {
  id: TeamId;
  name: string;
  color: string;
  softColor: string;
}

export interface GameConfig {
  durationSeconds: number;
  gridWidth: number;
  gridHeight: number;
  paintRadius: number;
  playerSpeed: number;
  releaseChannel: ReleaseChannel;
  teams: Record<TeamId, TeamConfig>;
}

export interface PlayerPublic {
  id: string;
  nickname: string;
  team: TeamId;
  connected: boolean;
  joinedAt: string;
  position: Vector2;
  isBot: boolean;
}

export interface RoomScores {
  cells: Record<TeamId, number>;
  percentage: Record<TeamId, number>;
  paintedCells: number;
  totalCells: number;
}

export interface ServerIdentity {
  version: string;
  gitSha: string;
  podName: string;
  cluster: ClusterName;
  releaseChannel: ReleaseChannel;
  broadcastMode: BroadcastMode;
}

export interface ActiveGameEvent {
  type: "paint-boost";
  label: string;
  startedAt: string;
  endsAt: string;
  multiplier: number;
}

export interface RoomSnapshot {
  roomCode: string;
  matchId: string;
  status: RoomStatus;
  config: GameConfig;
  players: PlayerPublic[];
  grid: Array<TeamId | null>;
  scores: RoomScores;
  remainingMs: number;
  matchEndsAt: string | null;
  winner: TeamId | "draw" | null;
  sequence: number;
  activeEvents: ActiveGameEvent[];
  announcement: string | null;
  server: ServerIdentity;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  snapshotCreatedAt: string;
}

export interface ChangedCell {
  x: number;
  y: number;
  team: TeamId | null;
}

export interface StateDelta {
  roomCode: string;
  sequence: number;
  changedCells: ChangedCell[];
  players: PlayerPublic[];
  scores: RoomScores;
  remainingMs: number;
  status: RoomStatus;
  winner: TeamId | "draw" | null;
  activeEvents: ActiveGameEvent[];
  announcement: string | null;
  server: ServerIdentity;
  updatedAt: string;
}

export interface EventLogEntry {
  id: string;
  at: string;
  type: string;
  message: string;
  roomCode: string | null;
  source: "system" | "admin" | "player" | "simulation" | "platform" | "chaos";
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RoomSummary {
  roomCode: string;
  status: RoomStatus;
  players: number;
  humanPlayers: number;
  bots: number;
  connectedPlayers: number;
  teamPlayers: Record<TeamId, number>;
  scores: Record<TeamId, number>;
  percentages: Record<TeamId, number>;
  remainingMs: number;
  version: string;
  cluster: ClusterName;
  releaseChannel: ReleaseChannel;
  broadcastMode: BroadcastMode;
  updatedAt: string;
}

export interface PodObservation {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  cpu: string | null;
  memory: string | null;
  image: string | null;
}

export interface InfrastructureObservation {
  mode: "local" | "kubernetes";
  source: "runtime" | "kubernetes-api";
  available: boolean;
  observedAt: string;
  message: string;
  desiredReplicas: number | null;
  readyReplicas: number | null;
  pods: PodObservation[];
  appVersion: string;
  imageTag: string;
}

export interface SimulationState {
  label: "DEMO / CHAOS MODE";
  latencyMs: number;
  disconnectWaves: number;
  podRestartMarkerUntil: string | null;
  forceFullBroadcast: boolean;
  activeCluster: ClusterName;
  updatedAt: string;
}

export interface RuntimeMetricSummary {
  tickMeanMs: number;
  tickP95Ms: number;
  broadcastP95Ms: number;
  websocketRttP95Ms: number;
  statePayloadBytes: number;
  reconnects: number;
  snapshotCreatedAt: string | null;
  snapshotAgeSeconds: number | null;
  eventLoopLagP95Ms: number;
  cpuPercent: number;
  memoryRssMb: number;
  heapUsedMb: number;
  inputRejectRate: number;
}

export interface OpsSnapshot {
  observedAt: string;
  server: {
    health: "healthy";
    ready: boolean;
    uptimeSeconds: number;
    connectedSockets: number;
    inputEventsPerSecond: number;
    inputLatencyP95Ms: number;
    totalInputEvents: number;
    rejectedInputEvents: number;
    disconnects: number;
    reconnects: number;
    identity: ServerIdentity;
    metrics: RuntimeMetricSummary;
  };
  rooms: RoomSummary[];
  infrastructure: InfrastructureObservation;
  simulation: SimulationState;
  recentEvents: EventLogEntry[];
}

export const joinPayloadSchema = z.object({
  roomCode: z.string().trim().min(3).max(16),
  sessionId: z.string().trim().min(8).max(128).optional(),
  clientId: z.string().trim().min(8).max(128).optional(),
  nickname: z.string().trim().min(1).max(24).optional(),
  isBot: z.boolean().optional(),
}).refine((value) => Boolean(value.sessionId || value.clientId), { message: "sessionId is required" });

export type JoinPayload = z.infer<typeof joinPayloadSchema>;

export const inputPayloadSchema = z.object({
  roomCode: z.string().trim().min(3).max(16),
  sessionId: z.string().trim().min(8).max(128).optional(),
  clientId: z.string().trim().min(8).max(128).optional(),
  sequence: z.number().int().nonnegative(),
  sentAt: z.number().int().positive(),
  direction: z.object({
    x: z.number().min(-1).max(1),
    y: z.number().min(-1).max(1),
  }),
}).refine((value) => Boolean(value.sessionId || value.clientId), { message: "sessionId is required" });

export type InputPayload = z.infer<typeof inputPayloadSchema>;

export const opsEventTypes = [
  "DEPLOYMENT_STARTED",
  "DEPLOYMENT_COMPLETED",
  "CANARY_STARTED",
  "SLO_BREACH",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "PRIMARY_UNHEALTHY",
  "FAILOVER_STARTED",
  "SNAPSHOT_RESTORED",
  "FAILOVER_COMPLETED",
  "SERVICE_RECOVERED",
] as const;

export const opsEventSchema = z.object({
  type: z.enum(opsEventTypes),
  timestamp: z.string().datetime({ offset: true }).optional(),
  roomId: z.string().trim().min(3).max(16).optional(),
  service: z.string().trim().max(80).optional(),
  version: z.string().trim().max(40).optional(),
  gitSha: z.string().trim().max(64).optional(),
  cluster: z.enum(["primary", "dr"]).optional(),
  releaseChannel: z.enum(RELEASE_CHANNELS).optional(),
  message: z.string().trim().min(1).max(300),
});

export type OpsEventPayload = z.infer<typeof opsEventSchema>;

export interface JoinResult {
  ok: boolean;
  player?: PlayerPublic;
  snapshot?: RoomSnapshot;
  sessionId?: string;
  socketPath?: string;
  reconnected?: boolean;
  error?: string;
}

export interface WatchResult {
  ok: boolean;
  snapshot?: RoomSnapshot;
  error?: string;
}

export interface InputResult {
  ok: boolean;
  reason?: "not-running" | "unknown-player" | "rate-limited" | "stale" | "duplicate" | "invalid-direction";
}

export interface PublicConfig {
  publicBaseUrl: string;
  appVersion: string;
  socketPath: string;
  adminTokenRequired: boolean;
}

export interface VersionInfo extends ServerIdentity {
  startedAt: string;
}

export interface SystemStatus {
  observedAt: string;
  connectedSockets: number;
  activeRooms: number;
  activePlayers: number;
  runtime: RuntimeMetricSummary;
  server: ServerIdentity;
  recentEvents: EventLogEntry[];
}
