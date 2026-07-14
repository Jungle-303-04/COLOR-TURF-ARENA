import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type { InputPayload, JoinResult, Vector2 } from "@paint-arena/shared";

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const roomCode = argument("room", process.env.BOT_ROOM ?? "").toUpperCase();
const serverUrl = argument("server", process.env.BOT_SERVER_URL ?? "http://localhost:3001");
const socketPath = argument("socket-path", process.env.SOCKET_PATH ?? "/socket.io");
const count = Math.max(1, Math.min(50, Number(argument("count", process.env.BOT_COUNT ?? "1")) || 1));

if (!roomCode) {
  console.error("Usage: npm run bot -- --room ABC12 --count 20 --server http://localhost:3001");
  process.exit(1);
}

const sockets: Socket[] = [];
const timers: NodeJS.Timeout[] = [];
const direction = (): Vector2 => {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

for (let index = 0; index < count; index += 1) {
  const sessionId = `bot-${randomUUID()}`;
  const nickname = `LOAD-BOT-${String(index + 1).padStart(2, "0")}`;
  const socket = io(serverUrl, { path: socketPath, transports: ["websocket"], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });
  sockets.push(socket);
  let sequence = 0;
  let move = direction();
  const join = () => socket.emit("join_room", { roomCode, sessionId, nickname, isBot: true }, (result: JoinResult) => {
    console.log(JSON.stringify({ bot: nickname, connected: result.ok, team: result.player?.team, error: result.error }));
  });
  socket.on("connect", join);
  socket.on("disconnect", (reason) => { if (reason === "io server disconnect") setTimeout(() => socket.connect(), 500); });
  timers.push(setInterval(() => { move = direction(); }, 1000 + Math.random() * 1000));
  timers.push(setInterval(() => {
    if (!socket.connected) return;
    sequence += 1;
    const payload: InputPayload = { roomCode, sessionId, sequence, sentAt: Date.now(), direction: move };
    socket.emit("player_input", payload);
  }, 100));
}

console.log(JSON.stringify({ message: "Bot load started", roomCode, serverUrl, socketPath, count }));

const shutdown = () => {
  for (const timer of timers) clearInterval(timer);
  for (const socket of sockets) socket.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
