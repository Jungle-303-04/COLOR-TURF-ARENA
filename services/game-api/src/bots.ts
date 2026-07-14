import { randomUUID } from "node:crypto";
import { io as createClient, type Socket } from "socket.io-client";
import type { InputPayload, JoinResult, Vector2 } from "@paint-arena/shared";

interface ManagedBot {
  sessionId: string;
  roomCode: string;
  socket: Socket;
  inputTimer: NodeJS.Timeout;
  directionTimer: NodeJS.Timeout;
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
      const socket = createClient(this.serverUrl(), {
        path: this.socketPath(),
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
      });
      let sequence = 0;
      let direction = randomDirection();
      const join = () => socket.emit("room.join", {
        roomCode,
        sessionId,
        nickname,
        isBot: true,
      }, (result: JoinResult) => {
        if (!result.ok) console.warn(JSON.stringify({ level: "warn", message: "bot join rejected", roomCode, sessionId, error: result.error }));
      });
      socket.on("connect", join);
      socket.on("disconnect", (reason) => {
        if (reason === "io server disconnect") setTimeout(() => socket.connect(), 500);
      });
      const directionTimer = setInterval(() => { direction = randomDirection(); }, 900 + Math.random() * 900);
      const inputTimer = setInterval(() => {
        if (!socket.connected) return;
        sequence += 1;
        const payload: InputPayload = { roomCode, sessionId, sequence, sentAt: Date.now(), direction };
        socket.emit("game.input", payload);
      }, 100);
      this.bots.set(sessionId, { sessionId, roomCode, socket, inputTimer, directionTimer });
      created.push(sessionId);
    }
    return created;
  }

  remove(roomCode: string, count: number): string[] {
    const targets = [...this.bots.values()].filter((bot) => bot.roomCode === roomCode).slice(0, Math.max(1, Math.round(count)));
    for (const bot of targets) this.stopBot(bot);
    return targets.map((bot) => bot.sessionId);
  }

  count(roomCode?: string): number {
    return roomCode ? [...this.bots.values()].filter((bot) => bot.roomCode === roomCode).length : this.bots.size;
  }

  stopAll(): void {
    for (const bot of [...this.bots.values()]) this.stopBot(bot);
  }

  private stopBot(bot: ManagedBot): void {
    clearInterval(bot.inputTimer);
    clearInterval(bot.directionTimer);
    bot.socket.disconnect();
    this.bots.delete(bot.sessionId);
    this.onRemoved(bot.roomCode, bot.sessionId);
  }
}
