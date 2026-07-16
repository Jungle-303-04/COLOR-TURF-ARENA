import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../services/game-api/dist/index.js", import.meta.url));
const workerEntry = fileURLToPath(new URL("./broadcast-load-worker.mjs", import.meta.url));
const adminToken = "load-comparison-admin";

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.round(parsed)))
    : fallback;
};

const botCount = boundedInteger(process.env.LOAD_BOT_COUNT, 50, 1, 500);
const config = {
  botCount,
  inputRateHz: boundedInteger(process.env.LOAD_INPUT_RATE_HZ, 10, 1, 30),
  gridSize: boundedInteger(process.env.LOAD_GRID_SIZE, 108, 40, 270),
  warmupMs: boundedInteger(process.env.LOAD_WARMUP_MS, 1_500, 250, 60_000),
  measureMs: boundedInteger(process.env.LOAD_MEASURE_MS, 5_000, 1_000, 120_000),
  clientWorkers: Math.min(
    botCount,
    boundedInteger(process.env.LOAD_CLIENT_WORKERS, Math.min(10, botCount), 1, 32),
  ),
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getFreePort = async () => {
  const server = createNetServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Unable to reserve an ephemeral load-test port");
  return port;
};

const requestJson = async (baseUrl, path, init = {}) => {
  const { admin = false, ...requestInit } = init;
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestInit,
    headers: {
      ...(requestInit.body ? { "content-type": "application/json" } : {}),
      ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...requestInit.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${requestInit.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  }
  return body;
};

const waitForServer = async (baseUrl, child, logs, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Load server exited before readiness (${child.exitCode})\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // The process is still binding its ephemeral port.
    }
    await delay(100);
  }
  throw new Error(`Load server did not become ready within ${timeoutMs}ms\n${logs()}`);
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => true);
  if (await Promise.race([exited, delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "exit"), delay(1_000)]);
};

let nextWorkerRequestId = 1;

const requestWorker = (worker, type, payload = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const requestId = nextWorkerRequestId;
  nextWorkerRequestId += 1;
  const cleanup = () => {
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const onMessage = (message) => {
    if (message.type !== "response" || message.requestId !== requestId) return;
    cleanup();
    if (message.ok) resolve(message.result);
    else reject(new Error(message.error));
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const onExit = (code) => {
    cleanup();
    reject(new Error(`Load client worker exited before responding (${code})`));
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`Load client worker timed out handling ${type}`));
  }, timeoutMs);
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.postMessage({ requestId, type, ...payload });
});

const createClientWorker = (workerData) => new Promise((resolve, reject) => {
  const worker = new Worker(workerEntry, { workerData });
  const cleanup = () => {
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const onMessage = (message) => {
    if (message.type === "ready") {
      cleanup();
      resolve({ worker, connectedBots: message.connectedBots });
    } else if (message.type === "fatal") {
      cleanup();
      void worker.terminate();
      reject(new Error(message.error));
    }
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const onExit = (code) => {
    cleanup();
    reject(new Error(`Load client worker exited during startup (${code})`));
  };
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
});

const stopWorkers = async (workerGroups) => {
  await Promise.allSettled(workerGroups.map(({ worker }) => (
    requestWorker(worker, "shutdown", {}, 3_000)
  )));
  await Promise.allSettled(workerGroups.map(({ worker }) => worker.terminate()));
};

const runScenario = async (mode) => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const childEnv = { ...process.env };
  delete childEnv.REDIS_URL;
  delete childEnv.TEST_REDIS_URL;
  Object.assign(childEnv, {
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: baseUrl,
    ADMIN_TOKEN: adminToken,
    OPS_EVENT_TOKEN: "load-comparison-ops",
    SERVER_VERSION: `load-${mode}`,
    RELEASE_CHANNEL: "stable",
    BROADCAST_MODE: mode,
    DEMO_TICK_DELAY_MS: "0",
    SNAPSHOT_INTERVAL_MS: "1000",
    DEMO_AUTO_SEED: "false",
    NODE_ENV: "production",
  });

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: childEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  const capture = (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const logs = () => childOutput;
  const workerGroups = [];

  try {
    await waitForServer(baseUrl, child, logs);
    const created = await requestJson(baseUrl, "/api/rooms", {
      method: "POST",
      admin: true,
      body: JSON.stringify({
        durationSeconds: Math.max(30, Math.ceil((config.warmupMs + config.measureMs) / 1000) + 10),
        gridWidth: config.gridSize,
        gridHeight: config.gridSize,
        paintRadius: 2,
        releaseChannel: "stable",
      }),
    });
    const roomCode = created.room.roomCode;

    const workersToStart = [];
    let assignedBots = 0;
    for (let index = 0; index < config.clientWorkers; index += 1) {
      const remainingWorkers = config.clientWorkers - index;
      const groupBotCount = Math.ceil((config.botCount - assignedBots) / remainingWorkers);
      workersToStart.push(createClientWorker({
        baseUrl,
        roomCode,
        startIndex: assignedBots,
        botCount: groupBotCount,
        inputRateHz: config.inputRateHz,
      }));
      assignedBots += groupBotCount;
    }
    workerGroups.push(...await Promise.all(workersToStart));

    const started = await requestJson(baseUrl, `/api/admin/rooms/${roomCode}/start`, {
      method: "POST",
      admin: true,
    });
    if (started.room.server.broadcastMode !== mode) {
      throw new Error(`Expected ${mode} room identity, received ${started.room.server.broadcastMode}`);
    }

    await Promise.all(workerGroups.map(({ worker }) => requestWorker(worker, "run-window", {
      startAt: Date.now() + 200,
      durationMs: config.warmupMs,
      collectMeasurement: false,
    }, config.warmupMs + 15_000)));
    const measurementResults = await Promise.all(workerGroups.map(({ worker }) => requestWorker(worker, "run-window", {
      startAt: Date.now() + 200,
      durationMs: config.measureMs,
      collectMeasurement: true,
    }, config.measureMs + 15_000)));
    const measurementDurationMs = Math.max(...measurementResults.map((result) => result.durationMs));
    const inputEventsSent = measurementResults.reduce((sum, result) => sum + result.inputEventsSent, 0);
    const aggregateMessages = measurementResults.reduce((sum, result) => sum + result.aggregateMessages, 0);
    const representativeMessages = measurementResults.reduce((sum, result) => sum + result.representativeMessages, 0);
    const representativeBytes = measurementResults.reduce((sum, result) => sum + result.representativeBytes, 0);
    const deltaMessages = measurementResults.reduce((sum, result) => sum + result.deltaMessages, 0);
    const fullSnapshotMessages = measurementResults.reduce((sum, result) => sum + result.fullSnapshotMessages, 0);
    const inputScheduleLagP95Ms = Math.max(...measurementResults.map((result) => result.inputScheduleLagP95Ms));

    const [ops, finalRoom] = await Promise.all([
      requestJson(baseUrl, "/api/ops"),
      requestJson(baseUrl, `/api/rooms/${roomCode}`),
    ]);
    const seconds = measurementDurationMs / 1000;
    const connectedBots = finalRoom.room.players.filter((player) => player.isBot && player.connected).length;
    const expectedInputEvents = (
      Math.floor(config.measureMs / (1000 / config.inputRateHz)) * config.botCount
    );

    return {
      mode,
      roomCode,
      serverVersion: finalRoom.room.server.version,
      connectedBots,
      measurementDurationMs: Number(measurementDurationMs.toFixed(1)),
      inputRateHzPerBot: config.inputRateHz,
      expectedInputEvents,
      inputEventsSent,
      inputDeliveryRatio: Number((inputEventsSent / expectedInputEvents).toFixed(3)),
      measuredInputEventsPerSecond: Number((inputEventsSent / seconds).toFixed(1)),
      inputScheduleLagP95Ms: Number(inputScheduleLagP95Ms.toFixed(3)),
      aggregateMessages,
      aggregateMessagesPerSecond: Number((aggregateMessages / seconds).toFixed(1)),
      representativeMessages,
      representativeAveragePayloadBytes: representativeMessages === 0
        ? 0
        : Number((representativeBytes / representativeMessages).toFixed(1)),
      estimatedAggregateClientBytesPerSecond: Number(((representativeBytes * connectedBots) / seconds).toFixed(1)),
      deltaMessages,
      fullSnapshotMessages,
      server: {
        totalInputEvents: ops.server.totalInputEvents,
        rejectedInputEvents: ops.server.rejectedInputEvents,
        inputEventsPerSecond: ops.server.inputEventsPerSecond,
        inputLatencyP95Ms: Number(ops.server.inputLatencyP95Ms.toFixed(3)),
        tickMeanMs: Number(ops.server.metrics.tickMeanMs.toFixed(3)),
        tickP95Ms: Number(ops.server.metrics.tickP95Ms.toFixed(3)),
        broadcastP95Ms: Number(ops.server.metrics.broadcastP95Ms.toFixed(3)),
        statePayloadP95Bytes: ops.server.metrics.statePayloadBytes,
        eventLoopLagP95Ms: Number(ops.server.metrics.eventLoopLagP95Ms.toFixed(3)),
        cpuPercent: Number(ops.server.metrics.cpuPercent.toFixed(3)),
        memoryRssMb: Number(ops.server.metrics.memoryRssMb.toFixed(3)),
      },
    };
  } catch (error) {
    throw new Error(`${mode} load scenario failed: ${error instanceof Error ? error.message : String(error)}\n${logs()}`);
  } finally {
    await stopWorkers(workerGroups);
    await stopChild(child);
  }
};

const ratio = (full, delta) => (
  delta > 0 ? Number((full / delta).toFixed(3)) : null
);

if (!existsSync(serverEntry)) {
  throw new Error("Game API build is missing. Run `npm run --silent load:compare` so the workspace is built first.");
}

const startedAt = performance.now();
const delta = await runScenario("delta");
const full = await runScenario("full");
const comparison = {
  representativeAveragePayloadRatio: ratio(full.representativeAveragePayloadBytes, delta.representativeAveragePayloadBytes),
  estimatedAggregateClientBytesPerSecondRatio: ratio(full.estimatedAggregateClientBytesPerSecond, delta.estimatedAggregateClientBytesPerSecond),
  serverStatePayloadP95Ratio: ratio(full.server.statePayloadP95Bytes, delta.server.statePayloadP95Bytes),
  broadcastP95Ratio: ratio(full.server.broadcastP95Ms, delta.server.broadcastP95Ms),
  tickP95Ratio: ratio(full.server.tickP95Ms, delta.server.tickP95Ms),
  eventLoopLagP95Ratio: ratio(full.server.eventLoopLagP95Ms, delta.server.eventLoopLagP95Ms),
  cpuRatio: ratio(full.server.cpuPercent, delta.server.cpuPercent),
};
const ok = delta.connectedBots === config.botCount
  && full.connectedBots === config.botCount
  && delta.inputEventsSent === delta.expectedInputEvents
  && full.inputEventsSent === full.expectedInputEvents
  && delta.deltaMessages > 0
  && delta.fullSnapshotMessages === 0
  && full.fullSnapshotMessages > 0
  && full.deltaMessages === 0
  && full.representativeAveragePayloadBytes > delta.representativeAveragePayloadBytes;

process.stdout.write(`${JSON.stringify({
  ok,
  testedAt: new Date().toISOString(),
  config,
  delta,
  full,
  comparison,
  totalRuntimeMs: Number((performance.now() - startedAt).toFixed(1)),
}, null, 2)}\n`);

if (!ok) process.exitCode = 1;
