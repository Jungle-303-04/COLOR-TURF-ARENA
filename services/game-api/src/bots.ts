import { randomUUID } from "node:crypto";
import { io as createClient, type Socket } from "socket.io-client";
import type { InputPayload, JoinResult, Vector2 } from "@paint-arena/shared";

interface ManagedBot {
  sessionId: string;
  roomCode: string;
  socket: Socket;
  inputTimer: NodeJS.Timeout;
  directionTimer: NodeJS.Timeout;
  cancelJoinRetry: () => void;
}

const randomDirection = (): Vector2 => {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

export class BotManager {
  private readonly bots = new Map<string, ManagedBot>();

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
          cancelJoinRetry();
          return;
        }
        console.warn(JSON.stringify({ level: "warn", message: "bot join rejected; retrying", roomCode, sessionId, error: result.error }));
        cancelJoinRetry();
        joinRetry = setTimeout(join, 500);
      });
    };
    socket.on("connect", join);
    socket.on("disconnect", (reason) => {
      joined = false;
      cancelJoinRetry();
      if (reason === "io server disconnect") setTimeout(() => socket.connect(), 500);
    });
    const directionTimer = setInterval(() => { direction = randomDirection(); }, 900 + Math.random() * 900);
    const inputTimer = setInterval(() => {
      if (!socket.connected || !joined) return;
      sequence += 1;
      const payload: InputPayload = { roomCode, sessionId, sequence, sentAt: Date.now(), direction };
      socket.emit("game.input", payload);
    }, 100);
    this.bots.set(sessionId, { sessionId, roomCode, socket, inputTimer, directionTimer, cancelJoinRetry });
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
    if (removeFromRoom) this.onRemoved(bot.roomCode, bot.sessionId);
  }
}
