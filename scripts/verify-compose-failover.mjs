import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = (process.env.DEMO_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN ?? "demo-admin";
const timeoutMs = Math.max(10_000, Number(process.env.FAILOVER_TIMEOUT_MS ?? 30_000));
const failureMode = (process.env.FAILOVER_FAILURE_MODE ?? "crash").toLowerCase();
const sessionId = `failover-${randomUUID()}`;
const nickname = `Failover-QA-${sessionId.slice(-6)}`;

if (failureMode !== "crash" && failureMode !== "graceful") {
  throw new Error("FAILOVER_FAILURE_MODE must be either crash or graceful");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestJson = async (path, init = {}) => {
  const { admin = false, ...requestInit } = init;
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestInit,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  return body;
};

const runDockerCompose = (...args) => new Promise((resolve, reject) => {
  const child = spawn("docker", ["compose", ...args], {
    cwd: repoRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(`docker compose ${args.join(" ")} failed (${code})\n${stderr || stdout}`));
  });
});

const loadPersistedRoom = async (roomCode) => {
  const raw = await runDockerCompose(
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "--raw",
    "GET",
    `color-turf:room:${roomCode.toUpperCase()}:snapshot`,
  );
  return raw ? JSON.parse(raw) : null;
};

const waitForPersistedPaint = async (roomCode, matchId, deadline) => {
  while (Date.now() < deadline) {
    const state = await loadPersistedRoom(roomCode);
    const paintedCells = state ? state.cellCounts.A + state.cellCounts.B : 0;
    if (state?.matchId === matchId && paintedCells > 0) return state;
    await delay(250);
  }
  throw new Error("Redis did not persist the painted room before the failure timeout");
};

const emitAck = (socket, event, payload, ackTimeoutMs = 2_500) => new Promise((resolve, reject) => {
  socket.timeout(ackTimeoutMs).emit(event, payload, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});

const waitForSocketEvent = (socket, event, predicate, waitMs = timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, waitMs);
  const handler = (value) => {
    if (!predicate(value)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(value);
  };
  socket.on(event, handler);
});

const resumeOnDr = async (socket, roomCode, expectedMatchId, deadline) => {
  while (Date.now() < deadline) {
    if (!socket.connected) {
      await delay(200);
      continue;
    }
    try {
      const result = await emitAck(socket, "resume_session", { roomCode, sessionId, nickname });
      if (result?.ok && result.snapshot?.server?.cluster === "dr" && result.snapshot.matchId === expectedMatchId) return result;
    } catch {
      // The transport can reconnect before the DR authority acquires the room lease.
    }
    await delay(300);
  }
  throw new Error("DR authority did not restore the room before the timeout");
};

let socket;
let stableStopped = false;
const startedAt = Date.now();

try {
  const initialVersion = await requestJson("/version");
  if (initialVersion.cluster !== "primary") {
    throw new Error(`Expected PRIMARY before the test, received ${initialVersion.cluster}`);
  }

  const created = await requestJson("/api/rooms", {
    method: "POST",
    admin: true,
    body: JSON.stringify({ durationSeconds: 90, gridWidth: 80, gridHeight: 80, releaseChannel: "stable" }),
  });
  const roomCode = created.room.roomCode;
  socket = io(baseUrl, {
    autoConnect: false,
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3_000,
  });
  const connected = waitForSocketEvent(socket, "connect", () => true);
  socket.connect();
  await connected;

  const joined = await emitAck(socket, "room.join", { roomCode, sessionId, nickname });
  if (!joined?.ok || !joined.player || !joined.snapshot) throw new Error(`Initial join failed: ${JSON.stringify(joined)}`);
  const expectedTeam = joined.player.team;

  await requestJson(`/api/admin/rooms/${roomCode}/start`, { method: "POST", admin: true });
  const moved = waitForSocketEvent(socket, "state_delta", (delta) => delta.changedCells?.length > 0);
  const input = await emitAck(socket, "game.input", {
    roomCode,
    sessionId,
    sequence: 1,
    sentAt: Date.now(),
    direction: { x: 1, y: 0 },
  });
  if (!input?.ok) throw new Error(`Movement input failed: ${JSON.stringify(input)}`);
  await moved;
  await delay(1_200);

  const before = (await requestJson(`/api/rooms/${roomCode}`)).room;
  const persistedBefore = await waitForPersistedPaint(roomCode, before.matchId, Date.now() + timeoutMs);
  const persistedPaintedCells = persistedBefore.cellCounts.A + persistedBefore.cellCounts.B;
  const disconnected = waitForSocketEvent(socket, "disconnect", () => true);
  const failureStartedAt = Date.now();
  if (failureMode === "crash") {
    await runDockerCompose("kill", "--signal", "SIGKILL", "server-stable");
  } else {
    await runDockerCompose("stop", "server-stable");
  }
  stableStopped = true;
  await disconnected;

  const resumed = await resumeOnDr(socket, roomCode, before.matchId, failureStartedAt + timeoutMs);
  const after = resumed.snapshot;
  const versionAfter = await requestJson("/version");
  const recoveryTimeMs = Date.now() - failureStartedAt;

  if (versionAfter.cluster !== "dr") throw new Error(`Public /version did not switch to DR: ${JSON.stringify(versionAfter)}`);
  if (resumed.player?.team !== expectedTeam) throw new Error(`Team changed across failover: ${expectedTeam} -> ${resumed.player?.team}`);
  if (resumed.player?.nickname !== nickname) throw new Error(`Nickname changed across failover: ${resumed.player?.nickname}`);
  if (after.scores.paintedCells <= 0) throw new Error("Recovered room lost all painted cells");
  if (after.matchEndsAt !== before.matchEndsAt) throw new Error("Recovered room changed matchEndsAt");
  if (after.sequence < persistedBefore.sequence) throw new Error(`Recovered sequence regressed behind Redis: ${persistedBefore.sequence} -> ${after.sequence}`);
  if (after.scores.paintedCells < persistedPaintedCells) throw new Error(`Recovered paint regressed behind Redis: ${persistedPaintedCells} -> ${after.scores.paintedCells}`);
  if (failureMode === "graceful" && after.sequence < before.sequence) throw new Error(`Graceful recovery regressed live sequence: ${before.sequence} -> ${after.sequence}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    testedAt: new Date().toISOString(),
    baseUrl,
    failureMode,
    roomCode,
    matchId: before.matchId,
    sessionId,
    nickname,
    team: expectedTeam,
    recoveryTimeMs,
    before: {
      cluster: before.server.cluster,
      podName: before.server.podName,
      sequence: before.sequence,
      paintedCells: before.scores.paintedCells,
      matchEndsAt: before.matchEndsAt,
    },
    persistedBefore: {
      sequence: persistedBefore.sequence,
      paintedCells: persistedPaintedCells,
      snapshotCreatedAt: persistedBefore.snapshotCreatedAt,
    },
    after: {
      cluster: after.server.cluster,
      podName: after.server.podName,
      sequence: after.sequence,
      paintedCells: after.scores.paintedCells,
      matchEndsAt: after.matchEndsAt,
    },
    liveRollback: {
      sequence: Math.max(0, before.sequence - after.sequence),
      paintedCells: Math.max(0, before.scores.paintedCells - after.scores.paintedCells),
    },
    totalTestTimeMs: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  socket?.disconnect();
  if (stableStopped) {
    try {
      await runDockerCompose("start", "server-stable");
    } catch (error) {
      process.stderr.write(`WARNING: stable restore failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
