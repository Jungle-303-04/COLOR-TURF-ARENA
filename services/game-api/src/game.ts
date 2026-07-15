import { randomUUID } from "node:crypto";
import {
  TEAM_IDS,
  type ActiveGameEvent,
  type GameConfig,
  type InputPayload,
  type InputResult,
  type PlayerPublic,
  type RoomScores,
  type RoomSnapshot,
  type RoomStatus,
  type ServerIdentity,
  type StateDelta,
  type TeamId,
  type Vector2,
} from "@paint-arena/shared";

export const DEFAULT_WORLD_SIZE = 216;

export const DEFAULT_GAME_CONFIG: GameConfig = {
  durationSeconds: 90,
  gridWidth: DEFAULT_WORLD_SIZE,
  gridHeight: DEFAULT_WORLD_SIZE,
  paintRadius: 2,
  playerSpeed: 18,
  releaseChannel: "stable",
  teams: {
    A: { id: "A", name: "RED", color: "#ff405a", softColor: "#5f1725" },
    B: { id: "B", name: "BLUE", color: "#25a8ff", softColor: "#123f68" },
  },
};

export const DEFAULT_SERVER_IDENTITY: ServerIdentity = {
  version: "v1.1.3",
  gitSha: "local",
  podName: "local-process",
  cluster: "primary",
  releaseChannel: "stable",
  broadcastMode: "delta",
};

interface PlayerInternal extends PlayerPublic {
  socketId: string;
  lastSequence: number;
  recentInputTimes: number[];
  input: Vector2;
  lastInputAt: number;
}

interface JoinOutcome {
  player: PlayerPublic;
  reconnected: boolean;
}

export interface GameEvent {
  type: string;
  message: string;
  source: "system" | "admin" | "player";
}

export interface GameRoomOptions {
  now?: () => number;
  random?: () => number;
  onEvent?: (event: GameEvent) => void;
  serverIdentity?: ServerIdentity;
}

export interface GameRoomRestoreOptions extends GameRoomOptions {
  /** Preserve gateway socket presence only after the caller verifies it. */
  preserveConnections?: boolean;
}

export interface PersistedPlayer {
  id: string;
  nickname: string;
  team: TeamId;
  joinedAt: string;
  position: Vector2;
  isBot: boolean;
  lastSequence: number;
  /** Socket.IO IDs are cluster-wide when the Redis adapter is enabled. */
  socketId?: string;
  connected?: boolean;
}

export interface PersistedRoomState {
  schemaVersion: 1;
  roomCode: string;
  matchId: string;
  config: GameConfig;
  grid: Array<TeamId | null>;
  players: PersistedPlayer[];
  status: RoomStatus;
  cellCounts: Record<TeamId, number>;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  deadlineAt: number | null;
  pausedAt: number | null;
  sequence: number;
  activeBoost: ActiveGameEvent | null;
  announcement: string | null;
  serverIdentity: ServerIdentity;
  snapshotCreatedAt: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const cloneConfig = (config: GameConfig): GameConfig => ({
  durationSeconds: config.durationSeconds,
  gridWidth: config.gridWidth,
  gridHeight: config.gridHeight,
  paintRadius: config.paintRadius,
  playerSpeed: config.playerSpeed,
  releaseChannel: config.releaseChannel,
  teams: {
    A: { ...config.teams.A },
    B: { ...config.teams.B },
  },
});

const cloneIdentity = (identity: ServerIdentity): ServerIdentity => ({ ...identity });

export class GameRoom {
  readonly roomCode: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onEvent: (event: GameEvent) => void;
  private players = new Map<string, PlayerInternal>();
  private grid: Array<TeamId | null>;
  private cellCounts: Record<TeamId, number> = { A: 0, B: 0 };
  private status: RoomStatus = "lobby";
  private config: GameConfig;
  private matchId = `MATCH-${randomUUID().slice(0, 8).toUpperCase()}`;
  private createdAt: number;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private deadlineAt: number | null = null;
  private pausedAt: number | null = null;
  private lastTickAt: number;
  private sequence = 0;
  private changedCellIndexes = new Set<number>();
  private activeBoost: ActiveGameEvent | null = null;
  private announcement: string | null = null;
  private serverIdentity: ServerIdentity;
  private snapshotCreatedAt: number;

  constructor(roomCode: string, config: GameConfig = DEFAULT_GAME_CONFIG, options: GameRoomOptions = {}) {
    this.roomCode = roomCode.toUpperCase();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.createdAt = this.now();
    this.lastTickAt = this.createdAt;
    this.snapshotCreatedAt = this.createdAt;
    this.config = cloneConfig(config);
    this.serverIdentity = cloneIdentity(options.serverIdentity ?? DEFAULT_SERVER_IDENTITY);
    this.grid = Array.from({ length: this.config.gridWidth * this.config.gridHeight }, () => null);
  }

  static restore(state: PersistedRoomState, options: GameRoomRestoreOptions = {}): GameRoom {
    if (state.schemaVersion !== 1) throw new Error(`Unsupported room snapshot schema: ${state.schemaVersion}`);
    const room = new GameRoom(state.roomCode, state.config, { ...options, serverIdentity: state.serverIdentity });
    room.matchId = state.matchId;
    room.grid = [...state.grid];
    room.status = state.status;
    room.cellCounts = { ...state.cellCounts };
    room.createdAt = state.createdAt;
    room.startedAt = state.startedAt;
    room.endedAt = state.endedAt;
    room.deadlineAt = state.deadlineAt;
    room.pausedAt = state.pausedAt;
    room.sequence = state.sequence;
    room.activeBoost = state.activeBoost ? { ...state.activeBoost } : null;
    room.announcement = state.announcement;
    room.snapshotCreatedAt = state.snapshotCreatedAt;
    room.lastTickAt = room.now();
    room.players = new Map(state.players.map((player) => [player.id, {
      ...player,
      position: { ...player.position },
      connected: options.preserveConnections ? player.connected ?? false : false,
      socketId: options.preserveConnections ? player.socketId ?? "" : "",
      input: { x: 0, y: 0 },
      lastInputAt: 0,
      recentInputTimes: [],
    }]));
    return room;
  }

  setServerIdentity(identity: ServerIdentity): void {
    this.serverIdentity = { ...identity, releaseChannel: this.config.releaseChannel };
  }

  get releaseChannel() {
    return this.config.releaseChannel;
  }

  private emit(type: string, message: string, source: GameEvent["source"]): void {
    this.onEvent({ type, message, source });
  }

  private bump(): void {
    this.sequence += 1;
  }

  updateConfig(next: Partial<Pick<GameConfig, "durationSeconds" | "gridWidth" | "gridHeight" | "paintRadius" | "playerSpeed" | "releaseChannel">> & {
    teams?: Partial<Record<TeamId, Partial<Pick<GameConfig["teams"][TeamId], "name" | "color" | "softColor">>>>;
  }): RoomSnapshot {
    if (this.status !== "lobby") throw new Error("Game settings can only be changed in the lobby.");

    this.config.durationSeconds = clamp(Math.round(next.durationSeconds ?? this.config.durationSeconds), 15, 300);
    let width = this.config.gridWidth;
    let height = this.config.gridHeight;
    if (next.gridWidth !== undefined || next.gridHeight !== undefined) {
      const size = clamp(Math.round(next.gridWidth ?? next.gridHeight ?? DEFAULT_WORLD_SIZE), 40, 270);
      width = size;
      height = size;
    }
    const resized = width !== this.config.gridWidth || height !== this.config.gridHeight;
    this.config.gridWidth = width;
    this.config.gridHeight = height;
    this.config.paintRadius = clamp(Math.round(next.paintRadius ?? this.config.paintRadius), 1, 5);
    this.config.playerSpeed = clamp(Number(next.playerSpeed ?? this.config.playerSpeed), 5, 40);
    if (next.releaseChannel === "stable" || next.releaseChannel === "canary") this.config.releaseChannel = next.releaseChannel;

    for (const team of TEAM_IDS) {
      const patch = next.teams?.[team];
      if (patch?.name) this.config.teams[team].name = patch.name.slice(0, 20);
      if (patch?.color && /^#[0-9a-f]{6}$/i.test(patch.color)) this.config.teams[team].color = patch.color;
      if (patch?.softColor && /^#[0-9a-f]{6}$/i.test(patch.softColor)) this.config.teams[team].softColor = patch.softColor;
    }

    if (resized) {
      this.grid = Array.from({ length: width * height }, () => null);
      this.cellCounts = { A: 0, B: 0 };
      for (const player of this.players.values()) player.position = this.spawnPosition(player.team);
    }
    this.bump();
    this.emit("room.settings.updated", "Game settings updated", "admin");
    return this.snapshot();
  }

  join(sessionId: string, socketId: string, nickname?: string, isBot = false): JoinOutcome {
    const existing = this.players.get(sessionId);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      existing.input = { x: 0, y: 0 };
      if (nickname?.trim()) existing.nickname = nickname.trim().slice(0, 24);
      this.bump();
      this.emit("player.reconnected", `${existing.nickname} reconnected to Team ${existing.team}`, "player");
      return { player: this.toPublicPlayer(existing), reconnected: true };
    }

    const team = this.assignTeam();
    const playerNumber = this.players.size + 1;
    const player: PlayerInternal = {
      id: sessionId,
      socketId,
      nickname: nickname?.trim().slice(0, 24) || `Guest-${playerNumber}`,
      team,
      connected: true,
      joinedAt: new Date(this.now()).toISOString(),
      position: this.spawnPosition(team),
      isBot,
      lastSequence: -1,
      recentInputTimes: [],
      input: { x: 0, y: 0 },
      lastInputAt: 0,
    };
    this.players.set(sessionId, player);
    this.bump();
    this.emit("player.joined", `${player.nickname} joined Team ${team}${isBot ? " as bot" : ""}`, "player");
    return { player: this.toPublicPlayer(player), reconnected: false };
  }

  private spawnPosition(team: TeamId): Vector2 {
    return {
      x: this.config.gridWidth * (team === "A" ? 0.25 : 0.75) + (this.random() - 0.5) * 6,
      y: this.config.gridHeight * (0.2 + this.random() * 0.6),
    };
  }

  private assignTeam(): TeamId {
    const counts: Record<TeamId, number> = { A: 0, B: 0 };
    for (const player of this.players.values()) counts[player.team] += 1;
    if (counts.A < counts.B) return "A";
    if (counts.B < counts.A) return "B";
    return this.random() < 0.5 ? "A" : "B";
  }

  disconnect(sessionId: string, socketId?: string): PlayerPublic | null {
    const player = this.players.get(sessionId);
    if (!player || !player.connected) return null;
    // Ignore a delayed disconnect from a socket that was already replaced by
    // a successful resume of the same session.
    if (socketId && player.socketId !== socketId) return null;
    player.connected = false;
    player.input = { x: 0, y: 0 };
    this.bump();
    this.emit("player.disconnected", `${player.nickname} disconnected`, "player");
    return this.toPublicPlayer(player);
  }

  removeBot(sessionId: string): boolean {
    const player = this.players.get(sessionId);
    if (!player?.isBot) return false;
    this.players.delete(sessionId);
    this.bump();
    this.emit("bot.removed", `${player.nickname} removed`, "admin");
    return true;
  }

  reassignTeams(): RoomSnapshot {
    const players = [...this.players.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    players.forEach((player, index) => {
      player.team = index % 2 === 0 ? "A" : "B";
      player.position = this.spawnPosition(player.team);
    });
    this.bump();
    this.emit("teams.reassigned", "Players were rebalanced across teams", "admin");
    return this.snapshot();
  }

  private toPublicPlayer(player: PlayerInternal): PlayerPublic {
    return {
      id: player.id,
      nickname: player.nickname,
      team: player.team,
      connected: player.connected,
      joinedAt: player.joinedAt,
      position: { ...player.position },
      isBot: player.isBot,
    };
  }

  start(): RoomSnapshot {
    if (this.status !== "lobby" && this.status !== "ended") throw new Error("Game is not startable.");
    if (this.status === "ended") this.resetBoard();
    const now = this.now();
    this.matchId = `MATCH-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.status = "running";
    this.startedAt = now;
    this.endedAt = null;
    this.deadlineAt = now + this.config.durationSeconds * 1000;
    this.pausedAt = null;
    this.lastTickAt = now;
    for (const player of this.players.values()) this.paintAt(player.team, player.position.x, player.position.y);
    this.bump();
    this.emit("game.started", `Game started for ${this.config.durationSeconds} seconds`, "admin");
    return this.snapshot();
  }

  pause(): RoomSnapshot {
    if (this.status !== "running") throw new Error("Only a running game can be paused.");
    this.status = "paused";
    this.pausedAt = this.now();
    this.bump();
    this.emit("game.paused", "Game paused", "admin");
    return this.snapshot();
  }

  resume(): RoomSnapshot {
    if (this.status !== "paused" || this.pausedAt === null || this.deadlineAt === null) {
      throw new Error("Only a paused game can be resumed.");
    }
    const now = this.now();
    this.deadlineAt += now - this.pausedAt;
    this.lastTickAt = now;
    this.pausedAt = null;
    this.status = "running";
    this.bump();
    this.emit("game.resumed", "Game resumed", "admin");
    return this.snapshot();
  }

  end(reason = "Game ended by operator"): RoomSnapshot {
    if (this.status === "ended") return this.snapshot();
    this.status = "ended";
    this.endedAt = this.now();
    this.deadlineAt = this.endedAt;
    this.pausedAt = null;
    for (const player of this.players.values()) player.input = { x: 0, y: 0 };
    this.bump();
    this.emit("game.ended", reason, "admin");
    return this.snapshot();
  }

  reset(): RoomSnapshot {
    this.resetBoard();
    this.status = "lobby";
    this.startedAt = null;
    this.endedAt = null;
    this.deadlineAt = null;
    this.pausedAt = null;
    this.activeBoost = null;
    this.announcement = null;
    for (const player of this.players.values()) {
      player.lastSequence = -1;
      player.recentInputTimes = [];
      player.input = { x: 0, y: 0 };
      player.position = this.spawnPosition(player.team);
    }
    this.bump();
    this.emit("game.reset", "Game reset to lobby", "admin");
    return this.snapshot();
  }

  private resetBoard(): void {
    this.grid = Array.from({ length: this.config.gridWidth * this.config.gridHeight }, () => null);
    this.cellCounts = { A: 0, B: 0 };
    this.changedCellIndexes.clear();
  }

  handleInput(sessionId: string, payload: InputPayload): InputResult {
    if (this.status !== "running") return { ok: false, reason: "not-running" };
    const player = this.players.get(sessionId);
    if (!player || !player.connected) return { ok: false, reason: "unknown-player" };
    if (payload.sequence <= player.lastSequence) return { ok: false, reason: "duplicate" };

    const now = this.now();
    if (payload.sentAt < now - 3000 || payload.sentAt > now + 2000) return { ok: false, reason: "stale" };
    const magnitude = Math.hypot(payload.direction.x, payload.direction.y);
    if (!Number.isFinite(magnitude) || magnitude > 1.05) return { ok: false, reason: "invalid-direction" };
    player.recentInputTimes = player.recentInputTimes.filter((time) => time > now - 1000);
    if (player.recentInputTimes.length >= 20) return { ok: false, reason: "rate-limited" };

    player.lastSequence = payload.sequence;
    player.recentInputTimes.push(now);
    player.input = magnitude > 1 ? { x: payload.direction.x / magnitude, y: payload.direction.y / magnitude } : { ...payload.direction };
    player.lastInputAt = now;
    return { ok: true };
  }

  tick(): boolean {
    const now = this.now();
    let changed = false;
    if (this.activeBoost && new Date(this.activeBoost.endsAt).getTime() <= now) {
      this.activeBoost = null;
      this.bump();
      this.emit("event.paint-boost.finished", "Paint Boost ×2 finished", "system");
      changed = true;
    }
    if (this.status !== "running" || this.deadlineAt === null) {
      this.lastTickAt = now;
      return changed;
    }
    if (now >= this.deadlineAt) {
      this.end("Time expired");
      return true;
    }

    const elapsedSeconds = clamp((now - this.lastTickAt) / 1000, 0, 0.25);
    this.lastTickAt = now;
    if (elapsedSeconds <= 0) return changed;
    for (const player of this.players.values()) {
      if (!player.connected) continue;
      if (now - player.lastInputAt > 400) player.input = { x: 0, y: 0 };
      const previousX = player.position.x;
      const previousY = player.position.y;
      player.position.x = clamp(player.position.x + player.input.x * this.config.playerSpeed * elapsedSeconds, 0, this.config.gridWidth - 0.001);
      player.position.y = clamp(player.position.y + player.input.y * this.config.playerSpeed * elapsedSeconds, 0, this.config.gridHeight - 0.001);
      if (Math.abs(previousX - player.position.x) > 0.001 || Math.abs(previousY - player.position.y) > 0.001) {
        this.paintAt(player.team, player.position.x, player.position.y);
        changed = true;
      }
    }
    if (changed) this.bump();
    return changed;
  }

  activatePaintBoost(durationMs = 10_000): RoomSnapshot {
    const now = this.now();
    this.activeBoost = {
      type: "paint-boost",
      label: "PAINT BOOST ×2",
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + clamp(durationMs, 3000, 30_000)).toISOString(),
      multiplier: 2,
    };
    this.bump();
    this.emit("event.paint-boost.started", "Paint Boost ×2 started", "admin");
    return this.snapshot();
  }

  announce(message: string): RoomSnapshot {
    this.announcement = message.trim().slice(0, 160) || null;
    this.bump();
    this.emit("announcement", this.announcement ?? "Announcement cleared", "admin");
    return this.snapshot();
  }

  private paintAt(team: TeamId, rawX: number, rawY: number): void {
    const x = Math.floor(rawX);
    const y = Math.floor(rawY);
    const multiplier = this.activeBoost ? this.activeBoost.multiplier : 1;
    const radius = Math.max(1, Math.round(this.config.paintRadius * multiplier));
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if ((offsetX * offsetX) + (offsetY * offsetY) > radius * radius) continue;
        const cellX = x + offsetX;
        const cellY = y + offsetY;
        if (cellX < 0 || cellY < 0 || cellX >= this.config.gridWidth || cellY >= this.config.gridHeight) continue;
        const index = cellY * this.config.gridWidth + cellX;
        const previous = this.grid[index];
        if (previous === team) continue;
        if (previous) this.cellCounts[previous] -= 1;
        this.grid[index] = team;
        this.cellCounts[team] += 1;
        this.changedCellIndexes.add(index);
      }
    }
  }

  private remainingMs(at = this.now()): number {
    if (this.status === "lobby") return this.config.durationSeconds * 1000;
    if (this.status === "ended") return 0;
    if (this.status === "paused" && this.pausedAt !== null && this.deadlineAt !== null) {
      return Math.max(0, this.deadlineAt - this.pausedAt);
    }
    return Math.max(0, (this.deadlineAt ?? at) - at);
  }

  private scores(): RoomScores {
    const paintedCells = this.cellCounts.A + this.cellCounts.B;
    const totalCells = this.grid.length;
    return {
      cells: { ...this.cellCounts },
      percentage: {
        A: totalCells === 0 ? 0 : (this.cellCounts.A / totalCells) * 100,
        B: totalCells === 0 ? 0 : (this.cellCounts.B / totalCells) * 100,
      },
      paintedCells,
      totalCells,
    };
  }

  private winner(): TeamId | "draw" | null {
    if (this.status !== "ended") return null;
    if (this.cellCounts.A === this.cellCounts.B) return "draw";
    return this.cellCounts.A > this.cellCounts.B ? "A" : "B";
  }

  snapshot(): RoomSnapshot {
    const now = this.now();
    return {
      roomCode: this.roomCode,
      matchId: this.matchId,
      status: this.status,
      config: cloneConfig(this.config),
      players: [...this.players.values()].map((player) => this.toPublicPlayer(player)),
      grid: [...this.grid],
      scores: this.scores(),
      remainingMs: this.remainingMs(now),
      matchEndsAt: this.deadlineAt === null ? null : new Date(this.deadlineAt).toISOString(),
      winner: this.winner(),
      sequence: this.sequence,
      activeEvents: this.activeBoost ? [{ ...this.activeBoost }] : [],
      announcement: this.announcement,
      server: cloneIdentity(this.serverIdentity),
      createdAt: new Date(this.createdAt).toISOString(),
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt === null ? null : new Date(this.endedAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
      snapshotCreatedAt: new Date(this.snapshotCreatedAt).toISOString(),
    };
  }

  consumeDelta(): StateDelta {
    const snapshot = this.snapshot();
    const changedCells = [...this.changedCellIndexes].map((index) => ({
      x: index % this.config.gridWidth,
      y: Math.floor(index / this.config.gridWidth),
      team: this.grid[index] ?? null,
    }));
    this.changedCellIndexes.clear();
    return {
      roomCode: snapshot.roomCode,
      sequence: snapshot.sequence,
      changedCells,
      players: snapshot.players,
      scores: snapshot.scores,
      remainingMs: snapshot.remainingMs,
      status: snapshot.status,
      winner: snapshot.winner,
      activeEvents: snapshot.activeEvents,
      announcement: snapshot.announcement,
      server: snapshot.server,
      updatedAt: snapshot.updatedAt,
    };
  }

  serialize(): PersistedRoomState {
    this.snapshotCreatedAt = this.now();
    return {
      schemaVersion: 1,
      roomCode: this.roomCode,
      matchId: this.matchId,
      config: cloneConfig(this.config),
      grid: [...this.grid],
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        nickname: player.nickname,
        team: player.team,
        joinedAt: player.joinedAt,
        position: { ...player.position },
        isBot: player.isBot,
        lastSequence: player.lastSequence,
        socketId: player.socketId,
        connected: player.connected,
      })),
      status: this.status,
      cellCounts: { ...this.cellCounts },
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      deadlineAt: this.deadlineAt,
      pausedAt: this.pausedAt,
      sequence: this.sequence,
      activeBoost: this.activeBoost ? { ...this.activeBoost } : null,
      announcement: this.announcement,
      serverIdentity: cloneIdentity(this.serverIdentity),
      snapshotCreatedAt: this.snapshotCreatedAt,
    };
  }
}
