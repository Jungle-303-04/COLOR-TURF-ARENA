import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { io } from "socket.io-client";

if (!parentPort) throw new Error("The broadcast load worker requires a parent port");

const {
  baseUrl,
  roomCode,
  startIndex,
  botCount,
  inputRateHz,
} = workerData;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const emitAck = (socket, event, payload, timeoutMs = 5_000) => (
  socket.timeout(timeoutMs).emitWithAck(event, payload)
);

const deterministicDirection = (botIndex, sequence) => {
  const phase = (botIndex * 0.61803398875) + (Math.floor(sequence / 10) * 0.17320508075);
  const angle = (phase % 1) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

const percentile = (values, quantile = 0.95) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
};

let measuring = false;
let aggregateMessages = 0;
let representativeMessages = 0;
let representativeBytes = 0;
let deltaMessages = 0;
let fullSnapshotMessages = 0;
let inputEventsSent = 0;
let scheduleLagMs = [];

const resetMeasurement = () => {
  aggregateMessages = 0;
  representativeMessages = 0;
  representativeBytes = 0;
  deltaMessages = 0;
  fullSnapshotMessages = 0;
  inputEventsSent = 0;
  scheduleLagMs = [];
};

const onEvent = (kind, botIndex) => (payload) => {
  if (!measuring) return;
  aggregateMessages += 1;
  if (kind === "delta") deltaMessages += 1;
  else fullSnapshotMessages += 1;
  if (botIndex === 0) {
    representativeMessages += 1;
    representativeBytes += Buffer.byteLength(JSON.stringify(payload));
  }
};

const connectBot = async (botIndex) => {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ["websocket"],
    reconnection: false,
    timeout: 5_000,
  });
  socket.on("state_delta", onEvent("delta", botIndex));
  socket.on("room_snapshot", onEvent("snapshot", botIndex));
  const connected = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.connect();
  await connected;
  const displayIndex = botIndex + 1;
  const sessionId = `load-${displayIndex.toString().padStart(3, "0")}-${Date.now().toString(36)}`;
  const joined = await emitAck(socket, "join_room", {
    roomCode,
    sessionId,
    nickname: `LOAD-${displayIndex.toString().padStart(3, "0")}`,
    isBot: true,
  });
  if (!joined?.ok) {
    socket.disconnect();
    throw new Error(`Bot ${displayIndex} join failed: ${JSON.stringify(joined)}`);
  }
  return { socket, sessionId, sequence: 0, botIndex };
};

const bots = [];

const sendInputBatch = (scheduledAt) => {
  const sentAt = Date.now();
  scheduleLagMs.push(Math.max(0, performance.now() - scheduledAt));
  for (const bot of bots) {
    bot.sequence += 1;
    bot.socket.emit("player_input", {
      roomCode,
      sessionId: bot.sessionId,
      sequence: bot.sequence,
      sentAt,
      direction: deterministicDirection(bot.botIndex, bot.sequence),
    });
    if (measuring) inputEventsSent += 1;
  }
};

const runWindow = async (startAt, durationMs, collectMeasurement) => {
  await delay(Math.max(0, startAt - Date.now()));
  if (collectMeasurement) resetMeasurement();
  measuring = collectMeasurement;

  const intervalMs = 1000 / inputRateHz;
  const batchCount = Math.floor(durationMs / intervalMs);
  const startedAt = performance.now();
  const endAt = startedAt + durationMs;
  let sentBatches = 0;

  await new Promise((resolve) => {
    const pump = () => {
      const now = performance.now();
      const dueBatches = Math.min(
        batchCount,
        Math.max(0, Math.floor((now - startedAt) / intervalMs) + 1),
      );
      while (sentBatches < dueBatches) {
        sendInputBatch(startedAt + (sentBatches * intervalMs));
        sentBatches += 1;
      }
      if (now >= endAt && sentBatches >= batchCount) {
        resolve();
        return;
      }
      const nextDueAt = sentBatches < batchCount
        ? startedAt + (sentBatches * intervalMs)
        : endAt;
      const waitMs = Math.max(0, Math.min(10, nextDueAt - performance.now()));
      if (waitMs > 1) setTimeout(pump, waitMs);
      else setImmediate(pump);
    };
    pump();
  });

  measuring = false;
  const endedAt = performance.now();
  return {
    durationMs: endedAt - startedAt,
    inputEventsSent,
    aggregateMessages,
    representativeMessages,
    representativeBytes,
    deltaMessages,
    fullSnapshotMessages,
    inputScheduleLagP95Ms: percentile(scheduleLagMs),
  };
};

const shutdown = () => {
  measuring = false;
  for (const bot of bots) bot.socket.disconnect();
};

parentPort.on("message", (message) => {
  const respond = (ok, result) => parentPort.postMessage({
    type: "response",
    requestId: message.requestId,
    ok,
    ...(ok ? { result } : { error: result }),
  });
  void (async () => {
    if (message.type === "run-window") {
      respond(true, await runWindow(message.startAt, message.durationMs, message.collectMeasurement));
      return;
    }
    if (message.type === "shutdown") {
      shutdown();
      respond(true, null);
      return;
    }
    throw new Error(`Unknown worker command: ${message.type}`);
  })().catch((error) => {
    respond(false, error instanceof Error ? error.message : String(error));
  });
});

try {
  const connected = await Promise.all(Array.from(
    { length: botCount },
    (_, offset) => connectBot(startIndex + offset),
  ));
  bots.push(...connected);
  parentPort.postMessage({ type: "ready", connectedBots: bots.length });
} catch (error) {
  shutdown();
  parentPort.postMessage({
    type: "fatal",
    error: error instanceof Error ? error.message : String(error),
  });
}
