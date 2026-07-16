import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { RoomSnapshot, RoomSummary, ServerIdentity, StateDelta } from "@paint-arena/shared";

const durationBuckets = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

export interface SnapshotAgeSample {
  roomCode: string;
  cluster: string;
  ageSeconds: number;
}

export interface ClientRenderMetricSummary {
  fpsP10: number;
  frameTimeP95Ms: number;
  frameDropP95Percent: number;
  clients: number;
}

const emptyClientRenderMetricSummary = (): ClientRenderMetricSummary => ({
  fpsP10: 0,
  frameTimeP95Ms: 0,
  frameDropP95Percent: 0,
  clients: 0,
});

export const createMetrics = () => {
  const register = new Registry();
  register.setDefaultLabels({ service: "color-turf-game-server" });
  collectDefaultMetrics({ register, prefix: "nodejs_" });

  const gameTickDuration = new Histogram({
    name: "game_tick_duration_seconds",
    help: "Authoritative game tick duration",
    labelNames: ["room_id", "version", "cluster", "release_channel"] as const,
    buckets: durationBuckets,
    registers: [register],
  });
  const gameBroadcastDuration = new Histogram({
    name: "game_state_broadcast_duration_seconds",
    help: "State serialization and Socket.IO broadcast duration",
    labelNames: ["room_id", "version", "cluster", "release_channel"] as const,
    buckets: durationBuckets,
    registers: [register],
  });
  const gamePayloadBytes = new Histogram({
    name: "game_state_payload_bytes",
    help: "Serialized state payload bytes",
    labelNames: ["mode", "version", "cluster", "release_channel"] as const,
    buckets: [256, 512, 1024, 4096, 16_384, 65_536, 262_144],
    registers: [register],
  });
  const gameInputQueueDelay = new Histogram({
    name: "game_input_queue_delay_seconds",
    help: "Delay from client timestamp to accepted server input",
    labelNames: ["room_id", "version", "cluster"] as const,
    buckets: durationBuckets,
    registers: [register],
  });
  const gameWebsocketConnections = new Gauge({
    name: "game_websocket_connections",
    help: "Current Socket.IO connections",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });
  const gameActivePlayers = new Gauge({
    name: "game_active_players",
    help: "Connected players by room and team",
    labelNames: ["room_id", "team", "version", "cluster"] as const,
    registers: [register],
  });
  const gameActiveRooms = new Gauge({
    name: "game_active_rooms",
    help: "Rooms hosted by server identity",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });
  const gameClientReconnects = new Counter({
    name: "game_client_reconnect_total",
    help: "Players restored using an existing session",
    labelNames: ["room_id", "version", "cluster"] as const,
    registers: [register],
  });
  const gameSnapshotSaveDuration = new Histogram({
    name: "game_snapshot_save_duration_seconds",
    help: "Room snapshot persistence duration",
    labelNames: ["cluster"] as const,
    buckets: durationBuckets,
    registers: [register],
  });
  const gameSnapshotAge = new Gauge({
    name: "game_snapshot_age_seconds",
    help: "Age of the most recent room snapshot",
    labelNames: ["room_id", "cluster"] as const,
    registers: [register],
  });
  const gameRoomRecoveryDuration = new Histogram({
    name: "game_room_recovery_duration_seconds",
    help: "Room recovery duration from persisted snapshot",
    labelNames: ["room_id", "source_cluster", "target_cluster"] as const,
    buckets: durationBuckets,
    registers: [register],
  });
  const gameChangedCells = new Counter({
    name: "game_changed_cells_total",
    help: "Cells changed by authoritative paint processing",
    labelNames: ["room_id", "team"] as const,
    registers: [register],
  });
  const gameOpsEvents = new Counter({
    name: "game_ops_events_total",
    help: "Operational platform events accepted",
    labelNames: ["type", "cluster", "version"] as const,
    registers: [register],
  });
  const gameInputEvents = new Counter({
    name: "game_input_events_total",
    help: "Player input results",
    labelNames: ["result"] as const,
    registers: [register],
  });
  const gameClientRenderFpsP10 = new Gauge({
    name: "game_client_render_fps_p10",
    help: "10th percentile of recent browser render frames per second",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });
  const gameClientRenderFrameTimeP95 = new Gauge({
    name: "game_client_render_frame_time_p95_seconds",
    help: "95th percentile of browser-reported p95 render frame time",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });
  const gameClientRenderFrameDropRatioP95 = new Gauge({
    name: "game_client_render_frame_drop_ratio_p95",
    help: "95th percentile of browser-reported dropped-frame ratio",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });
  const gameClientRenderTelemetryClients = new Gauge({
    name: "game_client_render_telemetry_clients",
    help: "Connected browser sockets with a recent valid render telemetry sample",
    labelNames: ["version", "cluster", "release_channel"] as const,
    registers: [register],
  });

  const refresh = (
    identity: ServerIdentity,
    sockets: number,
    rooms: RoomSummary[],
    snapshotAges: SnapshotAgeSample[] = [],
    clientRender = emptyClientRenderMetricSummary(),
  ) => {
    gameWebsocketConnections.reset();
    gameWebsocketConnections.set({
      version: identity.version,
      cluster: identity.cluster,
      release_channel: identity.releaseChannel,
    }, sockets);
    gameActiveRooms.reset();
    for (const channel of ["stable", "canary"] as const) {
      gameActiveRooms.set({ version: identity.version, cluster: identity.cluster, release_channel: channel }, rooms.filter((room) => room.releaseChannel === channel).length);
    }
    gameActivePlayers.reset();
    for (const room of rooms) {
      for (const team of ["A", "B"] as const) {
        gameActivePlayers.set({
          room_id: room.roomCode,
          team,
          version: room.version,
          cluster: room.cluster,
        }, room.connectedTeamPlayers[team]);
      }
    }
    gameSnapshotAge.reset();
    for (const snapshot of snapshotAges) {
      gameSnapshotAge.set({
        room_id: snapshot.roomCode,
        cluster: snapshot.cluster,
      }, Math.max(0, snapshot.ageSeconds));
    }
    const renderLabels = {
      version: identity.version,
      cluster: identity.cluster,
      release_channel: identity.releaseChannel,
    };
    gameClientRenderFpsP10.reset();
    gameClientRenderFpsP10.set(renderLabels, clientRender.fpsP10);
    gameClientRenderFrameTimeP95.reset();
    gameClientRenderFrameTimeP95.set(renderLabels, clientRender.frameTimeP95Ms / 1000);
    gameClientRenderFrameDropRatioP95.reset();
    gameClientRenderFrameDropRatioP95.set(renderLabels, clientRender.frameDropP95Percent / 100);
    gameClientRenderTelemetryClients.reset();
    gameClientRenderTelemetryClients.set(renderLabels, clientRender.clients);
  };

  const observeTick = (snapshot: RoomSnapshot, seconds: number) => gameTickDuration.observe({
    room_id: snapshot.roomCode,
    version: snapshot.server.version,
    cluster: snapshot.server.cluster,
    release_channel: snapshot.config.releaseChannel,
  }, seconds);

  const observeBroadcast = (snapshot: RoomSnapshot, mode: "delta" | "full", seconds: number, bytes: number, delta?: StateDelta) => {
    const labels = {
      room_id: snapshot.roomCode,
      version: snapshot.server.version,
      cluster: snapshot.server.cluster,
      release_channel: snapshot.config.releaseChannel,
    };
    gameBroadcastDuration.observe(labels, seconds);
    gamePayloadBytes.observe({
      mode,
      version: snapshot.server.version,
      cluster: snapshot.server.cluster,
      release_channel: snapshot.config.releaseChannel,
    }, bytes);
    if (delta) {
      for (const team of ["A", "B"] as const) {
        const count = delta.changedCells.filter((cell) => cell.team === team).length;
        if (count > 0) gameChangedCells.inc({ room_id: snapshot.roomCode, team }, count);
      }
    }
  };

  return {
    register,
    gameTickDuration,
    gameBroadcastDuration,
    gamePayloadBytes,
    gameInputQueueDelay,
    gameWebsocketConnections,
    gameActivePlayers,
    gameActiveRooms,
    gameClientReconnects,
    gameSnapshotSaveDuration,
    gameSnapshotAge,
    gameRoomRecoveryDuration,
    gameChangedCells,
    gameOpsEvents,
    gameInputEvents,
    gameClientRenderFpsP10,
    gameClientRenderFrameTimeP95,
    gameClientRenderFrameDropRatioP95,
    gameClientRenderTelemetryClients,
    refresh,
    observeTick,
    observeBroadcast,
  };
};

export type ColorTurfMetrics = ReturnType<typeof createMetrics>;
