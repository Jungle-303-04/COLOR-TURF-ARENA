import { randomUUID } from "node:crypto";
import { io as createClient, type Socket } from "socket.io-client";
import type {
  InputPayload,
  JoinResult,
  PlayerPublic,
  RoomSnapshot,
  StateDelta,
  TeamId,
  Vector2,
} from "@paint-arena/shared";

interface ManagedBot {
  sessionId: string;
  roomCode: string;
  playerId: string | null;
  team: TeamId | null;
  socket: Socket;
  inputTimer: NodeJS.Timeout;
  directionTimer: NodeJS.Timeout;
  cancelJoinRetry: () => void;
}

export interface BotWorldView {
  sequence: number;
  width: number;
  height: number;
  grid: Array<TeamId | null>;
  players: PlayerPublic[];
}

const randomDirection = (): Vector2 => {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

const normalized = (x: number, y: number): Vector2 => {
  const length = Math.hypot(x, y);
  return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
};

export const chooseBotDirection = (
  world: BotWorldView | undefined,
  playerId: string | null,
  team: TeamId | null,
  random = Math.random,
): Vector2 => {
  const player = world?.players.find((candidate) => candidate.id === playerId);
  const currentTeam = player?.team ?? team;
  if (!world || !player || !currentTeam || world.grid.length !== world.width * world.height) return randomDirection();

  const directionCount = 24;
  const maximumDistance = Math.min(42, Math.max(8, Math.floor(Math.min(world.width, world.height) / 3)));
  let best: { score: number; direction: Vector2 } | null = null;

  for (let index = 0; index < directionCount; index += 1) {
    const angle = (index / directionCount) * Math.PI * 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    let score = 0;
    let samples = 0;

    for (let distance = 3; distance <= maximumDistance; distance += 3) {
      const x = Math.round(player.position.x + direction.x * distance);
      const y = Math.round(player.position.y + direction.y * distance);
      if (x < 0 || y < 0 || x >= world.width || y >= world.height) {
        score -= 5;
        break;
      }
      const owner = world.grid[y * world.width + x] ?? null;
      const distanceWeight = 1 / Math.max(1, distance / 3);
      score += owner === null ? 3.2 * distanceWeight : owner !== currentTeam ? 4.2 * distanceWeight : -0.45 * distanceWeight;
      samples += 1;
    }

    score += random() * 0.35;
    if (samples > 0 && (!best || score > best.score)) best = { score, direction };
  }

  if (!best || best.score <= 0) return randomDirection();
  const jitter = (random() - 0.5) * 0.22;
  return normalized(
    best.direction.x * Math.cos(jitter) - best.direction.y * Math.sin(jitter),
    best.direction.x * Math.sin(jitter) + best.direction.y * Math.cos(jitter),
  );
};

export class BotManager {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly worlds = new Map<string, BotWorldView>();

  constructor(
    private readonly serverUrl: () => string,
    private readonly socketPath: () => string,
    private readonly onRemoved: (roomCode: string, sessionId: string) => void,
  ) {}

  add(roomCode: string, count: number): string[] {
    const created: string[] = [];
    const safeCount = Math.max(1, Math.min(500, Math.round(count)));
    for (let index = 0; index < safeCount; index += 1) {
      const sessionId = `bot-${randomUUID()}`;
      const nickname = `BOT-${String(this.bots.size + 1).padStart(2, "0")}`;
      this.startBot(roomCode, sessionId, nickname);
      created.push(sessionId);
    }
    return created;
  }

  restore(roomCode: string, players: Array<{ sessionId: string; nickname: string; lastSequence: number }>): string[] {
    const restored: string[] = [];
    for (const player of players) {
      if (this.bots.has(player.sessionId)) continue;
      this.startBot(roomCode, player.sessionId, player.nickname, player.lastSequence);
      restored.push(player.sessionId);
    }
    return restored;
  }

  private startBot(roomCode: string, sessionId: string, nickname: string, initialSequence = 0): void {
    const socket = createClient(this.serverUrl(), {
      path: this.socketPath(),
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    let sequence = initialSequence;
    let joined = false;
    let joinRetry: NodeJS.Timeout | null = null;
    let direction = randomDirection();
    let playerId: string | null = null;
    let team: TeamId | null = null;
    const cancelJoinRetry = () => {
      if (joinRetry) clearTimeout(joinRetry);
      joinRetry = null;
    };
    const join = () => {
      if (!socket.connected || joined) return;
      socket.emit("room.join", {
        roomCode,
        sessionId,
        nickname,
        isBot: true,
      }, (result: JoinResult) => {
        if (result.ok) {
          joined = true;
          playerId = result.player?.id ?? sessionId;
          team = result.player?.team ?? null;
          const managed = this.bots.get(sessionId);
          if (managed) {
            managed.playerId = playerId;
            managed.team = team;
          }
          if (result.snapshot) this.acceptSnapshot(roomCode, result.snapshot);
          cancelJoinRetry();
          return;
        }
        console.warn(JSON.stringify({ level: "warn", message: "bot join rejected; retrying", roomCode, sessionId, error: result.error }));
        cancelJoinRetry();
        joinRetry = setTimeout(join, 500);
      });
    };
    socket.on("connect", join);
    socket.on("room_snapshot", (snapshot: RoomSnapshot) => this.acceptSnapshot(roomCode, snapshot));
    socket.on("state_delta", (delta: StateDelta) => this.acceptDelta(roomCode, delta));
    socket.on("disconnect", (reason) => {
      joined = false;
      cancelJoinRetry();
      if (reason === "io server disconnect") setTimeout(() => socket.connect(), 500);
    });
    const directionTimer = setInterval(() => {
      direction = chooseBotDirection(this.worlds.get(roomCode), playerId, team);
    }, 900 + Math.random() * 900);
    const inputTimer = setInterval(() => {
      if (!socket.connected || !joined) return;
      sequence += 1;
      const payload: InputPayload = { roomCode, sessionId, sequence, sentAt: Date.now(), direction };
      socket.emit("game.input", payload);
    }, 100);
    this.bots.set(sessionId, {
      sessionId,
      roomCode,
      playerId,
      team,
      socket,
      inputTimer,
      directionTimer,
      cancelJoinRetry,
    });
  }

  private acceptSnapshot(roomCode: string, snapshot: RoomSnapshot): void {
    const current = this.worlds.get(roomCode);
    if (current && snapshot.sequence <= current.sequence) return;
    this.worlds.set(roomCode, {
      sequence: snapshot.sequence,
      width: snapshot.config.gridWidth,
      height: snapshot.config.gridHeight,
      grid: [...snapshot.grid],
      players: snapshot.players,
    });
  }

  private acceptDelta(roomCode: string, delta: StateDelta): void {
    const current = this.worlds.get(roomCode);
    if (!current || delta.sequence <= current.sequence) return;
    for (const cell of delta.changedCells) {
      if (cell.x < 0 || cell.y < 0 || cell.x >= current.width || cell.y >= current.height) continue;
      current.grid[cell.y * current.width + cell.x] = cell.team;
    }
    current.sequence = delta.sequence;
    current.players = delta.players;
  }

  remove(roomCode: string, count: number): string[] {
    const targets = [...this.bots.values()].filter((bot) => bot.roomCode === roomCode).slice(0, Math.max(1, Math.round(count)));
    for (const bot of targets) this.stopBot(bot, true);
    return targets.map((bot) => bot.sessionId);
  }

  count(roomCode?: string): number {
    return roomCode ? [...this.bots.values()].filter((bot) => bot.roomCode === roomCode).length : this.bots.size;
  }

  stopRoom(roomCode: string, removeFromRoom = false): void {
    for (const bot of [...this.bots.values()].filter((current) => current.roomCode === roomCode)) {
      this.stopBot(bot, removeFromRoom);
    }
  }

  stopAll(removeFromRoom = true): void {
    for (const bot of [...this.bots.values()]) this.stopBot(bot, removeFromRoom);
  }

  private stopBot(bot: ManagedBot, removeFromRoom: boolean): void {
    clearInterval(bot.inputTimer);
    clearInterval(bot.directionTimer);
    bot.cancelJoinRetry();
    bot.socket.disconnect();
    this.bots.delete(bot.sessionId);
    if (![...this.bots.values()].some((candidate) => candidate.roomCode === bot.roomCode)) this.worlds.delete(bot.roomCode);
    if (removeFromRoom) this.onRemoved(bot.roomCode, bot.sessionId);
  }
}
