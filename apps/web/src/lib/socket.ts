import { io, type Socket } from "socket.io-client";

export const createSocket = (path = "/socket.io"): Socket => io({
  path,
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 5000,
  transports: ["websocket", "polling"],
});
