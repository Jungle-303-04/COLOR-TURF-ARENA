import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DemoChaosActionResponse,
  OpsSnapshot,
  RoomSnapshot,
  RoomStatus,
  StateDelta,
  TeamId,
  WatchResult,
} from "@paint-arena/shared";
import type { Socket } from "socket.io-client";
import { AppShell } from "../components/AppShell";
import { MetricLabel } from "../components/MetricHelp";
import { MetricChart } from "../components/MetricChart";
import { QrCode } from "../components/QrCode";
import { StatusPill } from "../components/StatusPill";
import { ArenaCanvasRenderer } from "../game/arenaCanvas";
import { api, clearAdminToken, getAdminToken, setAdminToken } from "../lib/api";
import { formatNumber, formatTime, formatTimer } from "../lib/format";
import { isRoomRecoveryPending, retryWithBackoff, ROOM_RECOVERY_ACK_TIMEOUT_MS, ROOM_RECOVERY_RETRY_POLICY } from "../lib/retry";
import { createSocket } from "../lib/socket";
import { applyStateDelta } from "../lib/state";

interface SettingsState {
  durationSeconds: number;
  gridWidth: number;
  gridHeight: number;
  paintRadius: number;
  releaseChannel: "stable" | "canary";
  colorA: string;
  colorB: string;
}

interface OpsHistorySample {
  at: number;
  sockets: number;
  inputRate: number;
  inputLatency: number;
  tick: number;
  eventLoopLag: number;
  memory: number;
  cpu: number;
  rejectRate: number;
  payload: number;
  clientFps: number;
  clientFrameDrop: number;
}

type AdminTab = "overview" | "controls" | "metrics";
type MetricTone = "good" | "warning" | "danger";

interface MetricKpiProps {
  label: string;
  value: string;
  unit: string;
  description: string;
  source: string;
  refreshInterval?: string;
  threshold: string;
  utilization: number;
  tone: MetricTone;
}

const DEFAULT_WORLD_SIZE = 216;
const WORLD_SIZE_PRESETS = [108, DEFAULT_WORLD_SIZE, 270] as const;
const PAINT_RADIUS_OPTIONS = [1, 2, 3, 4, 5] as const;

const initialSettings: SettingsState = {
  durationSeconds: 90,
  gridWidth: DEFAULT_WORLD_SIZE,
  gridHeight: DEFAULT_WORLD_SIZE,
  paintRadius: 2,
  releaseChannel: "stable",
  colorA: "#ff405a",
  colorB: "#25a8ff",
};

const actionsByStatus: Record<RoomStatus, Array<"start" | "pause" | "resume" | "end" | "reset">> = {
  lobby: ["start", "reset"],
  running: ["pause", "end"],
  paused: ["resume", "end"],
  ended: ["start", "reset"],
};

const actionLabels = { start: "게임 시작", pause: "일시정지", resume: "계속하기", end: "즉시 종료", reset: "초기화", reassign: "팀 다시 배정" } as const;

const roomStatusLabels: Record<RoomStatus, string> = {
  lobby: "대기",
  running: "진행 중",
  paused: "일시정지",
  ended: "종료",
};

const adminTabs: Array<{ id: AdminTab; label: string; description: string }> = [
  { id: "overview", label: "전체 게임 진행", description: "캔버스·참가자·게임 제어" },
  { id: "controls", label: "봇·부하 제어", description: "봇·OOM·Demo / Chaos" },
  { id: "metrics", label: "운영 지표", description: "KPI·그래프·데이터 출처" },
];

const isAdminTab = (value: string | null): value is AdminTab => adminTabs.some((tab) => tab.id === value);
const metricTone = (utilization: number): MetricTone => utilization >= 1 ? "danger" : utilization >= 0.7 ? "warning" : "good";

const MetricKpi = ({ label, value, unit, description, source, refreshInterval, threshold, utilization, tone }: MetricKpiProps) => (
  <article className={`ops-kpi-card tone-${tone}`}>
    <header>
      <MetricLabel label={label} description={description} source={source} unit={unit} refreshInterval={refreshInterval ?? "Socket.IO Ops Snapshot 수신 시 · 약 1초"} valueKind="actual" />
      <span className="ops-kpi-state">{tone === "good" ? "정상" : tone === "warning" ? "주의" : "위험"}</span>
    </header>
    <strong>{value}</strong>
    <div className="ops-kpi-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(2, utilization * 100))}%` }} /></div>
    <small>{threshold}</small>
  </article>
);

export const AdminPage = () => {
  const [tokenInput, setTokenInput] = useState(getAdminToken());
  const [authorized, setAuthorized] = useState(false);
  const [rooms, setRooms] = useState<OpsSnapshot["rooms"]>([]);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [ops, setOps] = useState<OpsSnapshot | null>(null);
  const [selectedCode, setSelectedCode] = useState(() => new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? localStorage.getItem("color-turf-admin-room") ?? "");
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [tickRateHz, setTickRateHz] = useState(30);
  const [settings, setSettings] = useState(initialSettings);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("운영 명령을 기다리는 중입니다.");
  const [error, setError] = useState("");
  const [streamConnected, setStreamConnected] = useState(false);
  const [updatesPerSecond, setUpdatesPerSecond] = useState(0);
  const [metricHistory, setMetricHistory] = useState<OpsHistorySample[]>([]);
  const [botBatchSize, setBotBatchSize] = useState(100);
  const [demoTickDelayMs, setDemoTickDelayMs] = useState(250);
  const [chaosBusyAction, setChaosBusyAction] = useState<DemoChaosActionResponse["action"] | null>(null);
  const [isArenaModalOpen, setIsArenaModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    const queryTab = new URLSearchParams(window.location.search).get("tab");
    const savedTab = localStorage.getItem("color-turf-admin-tab");
    return isAdminTab(queryTab) ? queryTab : isAdminTab(savedTab) ? savedTab : "overview";
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const modalRendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const tabButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedCodeRef = useRef(selectedCode);
  const adminSocketReadyRef = useRef(false);
  const adminWatchAttemptRef = useRef<AbortController | null>(null);
  const updateCountRef = useRef(0);
  const selectedMetricChannelRef = useRef<"stable" | "canary">("stable");

  const verify = useCallback(async () => {
    try {
      await api.verifyAdmin();
      setAuthorized(true);
      setError("");
    } catch {
      setAuthorized(false);
      setError("ADMIN_TOKEN이 올바르지 않습니다.");
    }
  }, []);

  useEffect(() => {
    void api.config().then((config) => {
      setBaseUrl(config.publicBaseUrl);
      setTickRateHz(config.tickRateHz);
      if (!config.adminTokenRequired) {
        setAuthorized(true);
        setError("");
      } else if (getAdminToken()) {
        void verify();
      }
    }).catch(() => undefined);
  }, [verify]);

  const acceptOpsSnapshot = useCallback((snapshot: OpsSnapshot) => {
    const selectedRoomCode = selectedCodeRef.current;
    if (selectedRoomCode) {
      if (snapshot.demoChaos.scope.kind !== "room-owner-process"
        || snapshot.demoChaos.scope.roomCode !== selectedRoomCode) return;
    } else if (snapshot.server.identity.releaseChannel !== selectedMetricChannelRef.current) {
      return;
    }
    setOps(snapshot);
    setRooms(snapshot.rooms);
    const observedAt = Date.parse(snapshot.observedAt);
    const sample: OpsHistorySample = {
      at: Math.floor(observedAt / 1000) * 1000,
      sockets: snapshot.server.connectedSockets,
      inputRate: snapshot.server.inputEventsPerSecond,
      inputLatency: snapshot.server.inputLatencyP95Ms,
      tick: snapshot.server.metrics.tickP95Ms,
      eventLoopLag: snapshot.server.metrics.eventLoopLagP95Ms,
      memory: snapshot.server.metrics.memoryRssMb,
      cpu: snapshot.server.metrics.cpuPercent,
      rejectRate: snapshot.server.metrics.inputRejectRate,
      payload: snapshot.server.metrics.statePayloadBytes / 1024,
      clientFps: snapshot.server.metrics.clientTelemetryClients > 0 ? snapshot.server.metrics.clientFpsP10 : Number.NaN,
      clientFrameDrop: snapshot.server.metrics.clientTelemetryClients > 0 ? snapshot.server.metrics.clientFrameDropP95Percent : Number.NaN,
    };
    setMetricHistory((current) => {
      if (!Number.isFinite(sample.at)) return current;
      if (current.at(-1)?.at === sample.at) return [...current.slice(0, -1), sample];
      return [...current, sample].slice(-120);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!authorized) return;
    const [roomList, opsSnapshot] = await Promise.all([api.listRooms(), api.ops()]);
    setRooms(roomList.rooms);
    acceptOpsSnapshot(opsSnapshot);
    const availableCode = roomList.rooms.some((item) => item.roomCode === selectedCode)
      ? selectedCode
      : roomList.rooms[0]?.roomCode ?? "";
    if (availableCode) {
      if (availableCode !== selectedCode) {
        setSelectedCode(availableCode);
        localStorage.setItem("color-turf-admin-room", availableCode);
      }
      try { setRoom((await api.getRoom(availableCode)).room); }
      catch { setRoom(null); }
    } else {
      if (selectedCode) {
        setSelectedCode("");
        localStorage.removeItem("color-turf-admin-room");
      }
      setRoom(null);
    }
  }, [acceptOpsSnapshot, authorized, selectedCode]);

  useEffect(() => { void refresh().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "상태를 불러오지 못했습니다.")); }, [refresh]);

  const subscribeAdminRoom = useCallback((code: string) => {
    adminWatchAttemptRef.current?.abort();
    adminWatchAttemptRef.current = null;
    const socket = socketRef.current;
    if (!code || !socket?.connected || !adminSocketReadyRef.current) return;
    const controller = new AbortController();
    adminWatchAttemptRef.current = controller;
    void retryWithBackoff<WatchResult>(
      async () => {
        if (!socket.connected || !adminSocketReadyRef.current) throw new Error("Admin socket disconnected during room recovery");
        return await socket.timeout(ROOM_RECOVERY_ACK_TIMEOUT_MS).emitWithAck("admin.room.watch", { roomCode: code }) as WatchResult;
      },
      {
        ...ROOM_RECOVERY_RETRY_POLICY,
        signal: controller.signal,
        shouldRetry: (result) => !result.ok && isRoomRecoveryPending(result.error),
      },
    ).then((outcome) => {
      if (controller.signal.aborted || adminWatchAttemptRef.current !== controller || outcome.status === "aborted") return;
      adminWatchAttemptRef.current = null;
      const result = outcome.status === "complete" || outcome.status === "exhausted" ? outcome.value : undefined;
      if (!result?.ok || !result.snapshot) {
        setError(result?.error ?? "관리자 실시간 관제 구독에 실패했습니다.");
        return;
      }
      if (selectedCodeRef.current !== result.snapshot.roomCode) return;
      setRoom(result.snapshot);
      setError("");
    });
  }, []);

  useEffect(() => {
    selectedCodeRef.current = selectedCode;
    subscribeAdminRoom(selectedCode);
  }, [selectedCode, subscribeAdminRoom]);

  useEffect(() => {
    if (!authorized) return;
    const socket = createSocket();
    socketRef.current = socket;
    socket.on("connect", () => {
      setStreamConnected(true);
      adminSocketReadyRef.current = false;
      socket.emit("admin_subscribe", { token: getAdminToken() }, (result: { ok: boolean }) => {
        if (!result.ok) {
          setStreamConnected(false);
          setError("관리자 실시간 관제 인증에 실패했습니다.");
          return;
        }
        adminSocketReadyRef.current = true;
        socket.emit(
          "ops.watch",
          selectedCodeRef.current ? { roomCode: selectedCodeRef.current } : {},
          acceptOpsSnapshot,
        );
        subscribeAdminRoom(selectedCodeRef.current);
      });
    });
    socket.on("disconnect", () => {
      adminWatchAttemptRef.current?.abort();
      adminWatchAttemptRef.current = null;
      adminSocketReadyRef.current = false;
      setStreamConnected(false);
      setUpdatesPerSecond(0);
    });
    socket.on("connect_error", () => { setStreamConnected(false); });
    socket.on("ops.snapshot", acceptOpsSnapshot);
    socket.on("room_snapshot", (snapshot: RoomSnapshot) => {
      if (snapshot.roomCode !== selectedCodeRef.current) return;
      updateCountRef.current += 1;
      setRoom(snapshot);
    });
    socket.on("state_delta", (delta: StateDelta) => {
      if (delta.roomCode !== selectedCodeRef.current) return;
      updateCountRef.current += 1;
      setRoom((current) => applyStateDelta(current, delta));
    });
    socket.connect();
    const rateTimer = window.setInterval(() => {
      setUpdatesPerSecond(updateCountRef.current);
      updateCountRef.current = 0;
    }, 1000);
    const resyncTimer = window.setInterval(() => subscribeAdminRoom(selectedCodeRef.current), 15000);
    return () => {
      window.clearInterval(rateTimer);
      window.clearInterval(resyncTimer);
      adminWatchAttemptRef.current?.abort();
      adminWatchAttemptRef.current = null;
      adminSocketReadyRef.current = false;
      if (socketRef.current === socket) socketRef.current = null;
      socket.disconnect();
    };
  }, [acceptOpsSnapshot, authorized, subscribeAdminRoom]);

  useEffect(() => {
    if (!room) return;
    setSettings({
      durationSeconds: room.config.durationSeconds,
      gridWidth: room.config.gridWidth,
      gridHeight: room.config.gridWidth,
      paintRadius: room.config.paintRadius,
      releaseChannel: room.config.releaseChannel,
      colorA: room.config.teams.A.color,
      colorB: room.config.teams.B.color,
    });
  }, [room?.roomCode]);

  useEffect(() => {
    const releaseChannel = room?.config.releaseChannel ?? "stable";
    selectedMetricChannelRef.current = releaseChannel;
    setMetricHistory([]);
    if (!authorized) return;

    let disposed = false;
    const refreshSelectedChannel = () => {
      void api.ops(releaseChannel, room?.roomCode).then((snapshot) => {
        if (disposed) return;
        // A local single-process setup truthfully reports Stable process
        // telemetry even for a logical Canary room. Dedicated deployments
        // return Canary identity here and the Stable socket stream is ignored.
        selectedMetricChannelRef.current = snapshot.server.identity.releaseChannel;
        acceptOpsSnapshot(snapshot);
      }).catch((loadError: unknown) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : "선택 채널의 운영 지표를 불러오지 못했습니다.");
      });
    };
    refreshSelectedChannel();
    const timer = window.setInterval(refreshSelectedChannel, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [acceptOpsSnapshot, authorized, room?.config.releaseChannel, room?.roomCode]);

  useEffect(() => {
    if (activeTab !== "overview" || !canvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;
    if (room) renderer.update(room);
    return () => { renderer.destroy(); rendererRef.current = null; };
  }, [activeTab, Boolean(room)]);

  useEffect(() => { if (room) rendererRef.current?.update(room); }, [room]);

  useEffect(() => {
    if (!isArenaModalOpen || !room || !modalCanvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(modalCanvasRef.current, { showPlayerLabels: true, maxPlayerLabels: 24 });
    modalRendererRef.current = renderer;
    renderer.update(room);
    return () => {
      renderer.destroy();
      modalRendererRef.current = null;
    };
  }, [isArenaModalOpen, room?.roomCode]);

  useEffect(() => { if (room) modalRendererRef.current?.update(room); }, [room]);

  useEffect(() => {
    if (!isArenaModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setIsArenaModalOpen(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isArenaModalOpen]);

  const login = async () => {
    setAdminToken(tokenInput);
    await verify();
  };

  const logout = () => {
    clearAdminToken();
    setAuthorized(false);
    setTokenInput("");
  };

  const selectRoom = (code: string) => {
    setSelectedCode(code);
    localStorage.setItem("color-turf-admin-room", code);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("room", code);
    window.history.replaceState({}, "", nextUrl);
  };

  const selectTab = (tab: AdminTab) => {
    setActiveTab(tab);
    localStorage.setItem("color-turf-admin-tab", tab);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("tab", tab);
    window.history.replaceState({}, "", nextUrl);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let targetIndex: number | null = null;
    if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % adminTabs.length;
    if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + adminTabs.length) % adminTabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = adminTabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    const targetTab = adminTabs[targetIndex];
    if (!targetTab) return;
    selectTab(targetTab.id);
    window.requestAnimationFrame(() => tabButtonRefs.current[targetIndex]?.focus());
  };

  const setSquareGridSize = (size: number) => {
    setSettings((current) => ({ ...current, gridWidth: size, gridHeight: size }));
  };

  const run = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true); setError("");
    try { await task(); setNotice(success); await refresh(); }
    catch (taskError) { setError(taskError instanceof Error ? taskError.message : "운영 명령에 실패했습니다."); }
    finally { setBusy(false); }
  };

  const createRoom = () => run(async () => {
    const created = await api.createRoom({
      durationSeconds: settings.durationSeconds,
      gridWidth: settings.gridWidth,
      gridHeight: settings.gridHeight,
      paintRadius: settings.paintRadius,
      releaseChannel: settings.releaseChannel,
      teams: { A: { color: settings.colorA }, B: { color: settings.colorB } },
    });
    setRoom(created.room);
    selectRoom(created.room.roomCode);
  }, `${settings.releaseChannel.toUpperCase()} 경기장 생성 완료`);

  const runAction = (action: "start" | "pause" | "resume" | "end" | "reset" | "reassign") => {
    if (!room) return;
    void run(async () => { const result = await api.roomAction(room.roomCode, action); setRoom(result.room); }, `${actionLabels[action]} 반영 완료`);
  };

  const runMemoryOom = () => {
    if (!window.confirm("선택된 게임 서버 Pod에 실제 메모리 누수를 시작합니다. Kubernetes가 OOMKilled로 종료하고 자동 재시작하는 과정을 계속 관측할까요?")) return;
    void run(async () => { setOps(await api.triggerMemoryOom()); }, "실제 메모리 장애 주입을 시작했습니다");
  };

  const runDemoChaos = (
    action: DemoChaosActionResponse["action"],
    confirmation: string,
    task: () => Promise<DemoChaosActionResponse>,
    success: string,
  ) => {
    if (!window.confirm(confirmation)) return;
    setChaosBusyAction(action);
    setError("");
    void task()
      .then((result) => {
        setOps((current) => current ? { ...current, demoChaos: result.status } : current);
        setNotice(success);
      })
      .catch((taskError: unknown) => {
        setError(taskError instanceof Error ? taskError.message : "Demo / Chaos 명령에 실패했습니다.");
      })
      .finally(() => setChaosBusyAction(null));
  };

  const applyDemoTickLag = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const delayMs = Math.max(0, Math.min(5_000, Math.round(demoTickDelayMs)));
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    setDemoTickDelayMs(delayMs);
    runDemoChaos(
      "lag",
      delayMs === 0
        ? `${releaseChannel.toUpperCase()} 게임 서버에 적용된 실제 Tick 지연 오버라이드를 0ms로 변경합니다. 런타임 게임 루프가 즉시 정상 지연으로 돌아가도록 요청할까요?`
        : `${releaseChannel.toUpperCase()} 게임 서버의 실제 Tick마다 ${delayMs}ms 지연을 추가합니다. 같은 프로세스가 담당하는 게임의 이동·페인트 판정과 화면 반영이 실제로 느려질 수 있습니다. 계속할까요?`,
      () => api.setDemoTickLag(delayMs, releaseChannel, roomCode),
      delayMs === 0 ? `${releaseChannel.toUpperCase()} 실제 Tick 지연을 0ms로 변경했습니다` : `${releaseChannel.toUpperCase()} 실제 Tick 지연 ${delayMs}ms를 적용했습니다`,
    );
  };

  const toggleDemoFullBroadcast = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    const enabled = !(ops?.demoChaos.runtime.fullBroadcastEnabled ?? false);
    runDemoChaos(
      "full-broadcast",
      enabled
        ? `${releaseChannel.toUpperCase()} 게임 서버의 실제 런타임 전송을 전체 상태 Broadcast로 변경합니다. 매 Tick 전체 Grid가 전송되어 Payload·전송시간·브라우저 프레임이 실제로 악화될 수 있습니다. 계속할까요?`
        : `${releaseChannel.toUpperCase()} 게임 서버의 실제 전체 상태 Broadcast 오버라이드를 해제하고 Delta 전송으로 변경합니다. 계속할까요?`,
      () => api.setDemoFullBroadcast(enabled, releaseChannel, roomCode),
      enabled ? `${releaseChannel.toUpperCase()} 실제 전체 상태 Broadcast를 활성화했습니다` : `${releaseChannel.toUpperCase()} 실제 전체 상태 Broadcast를 비활성화했습니다`,
    );
  };

  const requestDemoServerShutdown = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    runDemoChaos(
      "server-shutdown",
      `${releaseChannel.toUpperCase()}의 실제 game-api 프로세스 종료를 요청합니다. 환경에서 명시적으로 허용된 경우 현재 WebSocket 연결이 끊기고 Kubernetes 또는 Compose의 재시작 정책이 동작합니다. 자동 복구 환경이 준비되어 있는지 확인했습니까?`,
      () => api.requestDemoServerShutdown(releaseChannel, "관리자 Demo / Chaos 패널에서 실제 서버 종료 요청", roomCode),
      `${releaseChannel.toUpperCase()} 환경 게이트를 통과한 실제 서버 종료 요청을 전송했습니다`,
    );
  };

  const simulateDemoPrimaryFailure = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    runDemoChaos(
      "primary-failure",
      "Primary 장애 이벤트를 타임라인에 시뮬레이션으로 기록합니다. 실제 Primary 클러스터 상태, 트래픽 라우팅, 현재 서버 identity는 변경하지 않습니다. 시뮬레이션을 시작할까요?",
      () => api.simulateDemoPrimaryFailure(releaseChannel, "관리자 패널에서 Primary 장애 타임라인 시뮬레이션", roomCode),
      `${releaseChannel.toUpperCase()} 타임라인에 Primary 장애 시뮬레이션을 기록했습니다`,
    );
  };

  const simulateDemoFailover = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    runDemoChaos(
      "failover",
      "DR Failover 과정을 타임라인에 시뮬레이션으로 기록합니다. 실제 DR 라우팅이나 Room 권위 이전은 실행하지 않으며 현재 클러스터 표시는 바뀌지 않습니다. 계속할까요?",
      () => api.simulateDemoFailover(releaseChannel, "dr", roomCode),
      `${releaseChannel.toUpperCase()} 타임라인에 DR Failover 시뮬레이션을 기록했습니다`,
    );
  };

  const resetDemoChaos = () => {
    if (!room) {
      setError("먼저 제어할 경기방을 선택해 주세요.");
      return;
    }
    const releaseChannel = room.config.releaseChannel;
    const roomCode = room.roomCode;
    runDemoChaos(
      "reset",
      `${releaseChannel.toUpperCase()}의 실제 Tick 지연·전체 Broadcast 관리자 오버라이드와 Primary/Failover 시뮬레이션 표식을 모두 해제합니다. 런타임 값은 서버 환경변수 기준으로 복귀합니다. 초기화할까요?`,
      () => api.resetDemoChaos(releaseChannel, roomCode),
      `${releaseChannel.toUpperCase()} Demo / Chaos 상태를 환경 설정 기준으로 초기화했습니다`,
    );
  };

  const joinUrl = room ? `${baseUrl}/play/${room.roomCode}` : "";
  const watchUrl = room ? `${baseUrl}/watch/${room.roomCode}` : "";
  const playerCounts = useMemo(() => {
    const counts: Record<TeamId, number> = { A: 0, B: 0 };
    room?.players.forEach((player) => { counts[player.team] += 1; });
    return counts;
  }, [room]);
  const bots = room?.players.filter((player) => player.isBot).length ?? 0;
  const connectedBots = room?.players.filter((player) => player.isBot && player.connected).length ?? 0;
  const visiblePlayers = useMemo(() => [...(room?.players ?? [])]
    .sort((left, right) => Number(right.connected) - Number(left.connected) || left.nickname.localeCompare(right.nickname))
    .slice(0, 12), [room]);
  const chartPoints = (select: (sample: OpsHistorySample) => number) => metricHistory.map((sample) => ({
    at: sample.at,
    value: select(sample),
  }));
  const runBots = (action: "add" | "remove", requestedCount: number) => {
    if (!room) return;
    const count = Math.max(1, Math.min(500, Math.round(requestedCount)));
    void run(() => api.bots(room.roomCode, action, count), `봇 ${count}개 ${action === "add" ? "추가" : "회수"} 완료`);
  };
  const tickBudgetMs = 1000 / Math.max(1, tickRateHz);
  const tickP95Ms = ops?.server.metrics.tickP95Ms ?? 0;
  const inputLatencyP95Ms = ops?.server.inputLatencyP95Ms ?? 0;
  const eventLoopLagP95Ms = ops?.server.metrics.eventLoopLagP95Ms ?? 0;
  const cpuPercent = ops?.server.metrics.cpuPercent ?? 0;
  const clientTelemetryClients = ops?.server.metrics.clientTelemetryClients ?? 0;
  const clientFpsP10 = ops?.server.metrics.clientFpsP10 ?? 0;
  const clientFrameDropP95Percent = ops?.server.metrics.clientFrameDropP95Percent ?? 0;
  const tickUtilization = tickP95Ms / tickBudgetMs;
  const inputLatencyUtilization = inputLatencyP95Ms / 100;
  const eventLoopUtilization = eventLoopLagP95Ms / 50;
  const cpuUtilization = cpuPercent / 80;
  const clientFpsUtilization = clientTelemetryClients === 0 ? 0 : clientFpsP10 < 45 ? 1.1 : clientFpsP10 < 55 ? .8 : .3;
  const clientFrameDropUtilization = clientTelemetryClients === 0 ? 0 : clientFrameDropP95Percent / 10;
  const demoChaos = ops?.demoChaos;
  const demoChaosBusy = chaosBusyAction !== null;
  const chaosTokenReady = getAdminToken().length > 0;
  const chaosScopeReady = Boolean(
    room
      && demoChaos?.scope.kind === "room-owner-process"
      && demoChaos.scope.roomCode === room.roomCode,
  );
  const shutdownReady = Boolean(
    chaosScopeReady
      && demoChaos?.serverShutdown.allowed
      && demoChaos.serverShutdown.handlerAvailable,
  );

  if (!authorized) return <div className="admin-login-page"><div className="admin-login-card"><span className="panel-kicker">관리자 전용 운영</span><h1>컬러 터프 관리실</h1><p>게임·봇·장애 시연 API는 관리자 토큰으로 보호됩니다.</p><label><span>관리자 토큰</span><input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void login(); }} placeholder="demo-admin" /></label><button type="button" className="button button-primary button-block" onClick={() => void login()}>관리자 화면 열기</button>{error && <div className="notice-bar notice-error">{error}</div>}</div></div>;

  return (
    <AppShell eyebrow="게임 디렉터 / KUBERNETES 운영" title="컬러 터프 관리실" actions={<>
      <span className={`live-chip ${streamConnected ? "" : "is-offline"}`}><i /> {streamConnected ? `실시간 · 초당 ${updatesPerSecond}회` : "재연결 중"}</span>
      <button className="button button-secondary admin-canvas-open" type="button" disabled={!room} onClick={() => setIsArenaModalOpen(true)}>캔버스 크게 보기 ↗</button>
      <button className="button button-ghost" type="button" onClick={logout}>잠금</button>
    </>}>
      <nav className="admin-tab-list" role="tablist" aria-label="관리자 화면 구분">
        {adminTabs.map((tab, index) => <button
          type="button"
          role="tab"
          key={tab.id}
          ref={(element) => { tabButtonRefs.current[index] = element; }}
          id={`admin-tab-${tab.id}`}
          aria-controls={`admin-panel-${tab.id}`}
          aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={activeTab === tab.id ? "is-active" : ""}
          onClick={() => selectTab(tab.id)}
          onKeyDown={(event) => handleTabKeyDown(event, index)}
        ><b>{tab.label}</b><small>{tab.description}</small></button>)}
      </nav>
      {adminTabs.map((tab) => <section
        className="admin-tab-panel"
        id={`admin-panel-${tab.id}`}
        key={tab.id}
        role="tabpanel"
        aria-labelledby={`admin-tab-${tab.id}`}
        hidden={activeTab !== tab.id}
      >
      {activeTab === tab.id && <div className={`admin-layout color-turf-admin admin-tab-${activeTab}`}>
        <aside className="room-rail panel">
          <div className="panel-heading"><div><span className="panel-kicker">경기방</span><h2>경기장 목록</h2></div><span className="count-badge">{rooms.length}</span></div>
          <div className="room-list">{rooms.length === 0 && <p className="empty-copy">아직 생성된 방이 없습니다.</p>}{rooms.map((item) => <button type="button" key={item.roomCode} className={`room-list-item ${selectedCode === item.roomCode ? "is-selected" : ""}`} onClick={() => selectRoom(item.roomCode)}><span><b>{item.roomCode}</b><small>{item.releaseChannel.toUpperCase()} · {item.connectedPlayers}/{item.players}명 연결</small></span><StatusPill status={item.status} locale="ko" /></button>)}</div>
          <section className="create-room-settings" aria-labelledby="create-room-settings-title">
            <div className="create-room-settings-heading">
              <div><span className="panel-kicker">생성 옵션</span><h3 id="create-room-settings-title">새 경기장 설정</h3></div>
              <span className="square-size-badge">{settings.gridWidth} × {settings.gridHeight}</span>
            </div>
            <div className="compact-create-fields">
              <label className="create-field-wide"><span>배포 채널</span><select value={settings.releaseChannel} onChange={(event) => setSettings({ ...settings, releaseChannel: event.target.value as "stable" | "canary" })}><option value="stable">Stable v1.1.3 · 델타 전송</option><option value="canary">Canary v1.2.0 · 전체 전송</option></select></label>
              <label><span>경기 시간(초)</span><input type="number" min="15" max="300" value={settings.durationSeconds} onChange={(event) => setSettings({ ...settings, durationSeconds: Number(event.target.value) })} /></label>
              <label><span>정사각형 맵 크기</span><div className="square-size-input"><input type="number" min="40" max="270" value={settings.gridWidth} aria-describedby="square-size-hint" onChange={(event) => setSquareGridSize(Number(event.target.value))} /><span>× {settings.gridHeight}</span></div></label>
              <div className="create-field-wide square-size-presets" role="group" aria-label="맵 크기 빠른 선택">
                {WORLD_SIZE_PRESETS.map((size) => <button type="button" key={size} className={settings.gridWidth === size ? "is-selected" : ""} aria-pressed={settings.gridWidth === size} onClick={() => setSquareGridSize(size)}>{size}×{size}</button>)}
              </div>
              <small className="create-field-wide create-field-hint" id="square-size-hint">한 값이 가로·세로에 함께 적용됩니다. 40~270칸</small>
              <div className="create-field-wide paint-radius-field">
                <div className="create-field-label"><span>페인트 반경</span><strong>{settings.paintRadius}칸</strong></div>
                <div className="paint-radius-options" role="group" aria-label="페인트 반경 선택">
                  {PAINT_RADIUS_OPTIONS.map((radius) => <button type="button" key={radius} className={settings.paintRadius === radius ? "is-selected" : ""} aria-pressed={settings.paintRadius === radius} onClick={() => setSettings((current) => ({ ...current, paintRadius: radius }))}>{radius}</button>)}
                </div>
                <small className="create-field-hint">플레이어 중심에서 한 번에 칠하는 범위</small>
              </div>
              <div className="create-field-wide team-color-grid" role="group" aria-label="팀 색상 설정">
                <label className="team-color-field team-color-a"><span>팀 A 색상</span><div><input type="color" value={settings.colorA} aria-label="팀 A 색상 선택" onChange={(event) => setSettings({ ...settings, colorA: event.target.value })} /><code>{settings.colorA.toUpperCase()}</code></div></label>
                <label className="team-color-field team-color-b"><span>팀 B 색상</span><div><input type="color" value={settings.colorB} aria-label="팀 B 색상 선택" onChange={(event) => setSettings({ ...settings, colorB: event.target.value })} /><code>{settings.colorB.toUpperCase()}</code></div></label>
              </div>
            </div>
          </section>
          <button className="button button-primary button-block" type="button" onClick={() => void createRoom()} disabled={busy}>＋ 새 경기장 만들기</button>
        </aside>

        <section className="admin-center">
          <div className="control-hero panel">
            <div className="control-hero-top"><div><span className="panel-kicker">선택된 경기장</span><div className="room-code-line"><h2>{room?.roomCode ?? "-----"}</h2>{room && <StatusPill status={room.status} locale="ko" />}</div><p>{room ? `${room.server.cluster.toUpperCase()} · ${room.server.releaseChannel.toUpperCase()} · ${room.server.version}` : "왼쪽에서 경기장을 생성하세요."}</p></div>{room && <div className="mini-score"><span style={{ color: room.config.teams.A.color }}>빨강 <b>{room.scores.percentage.A.toFixed(1)}%</b></span><i>대결</i><span style={{ color: room.config.teams.B.color }}>파랑 <b>{room.scores.percentage.B.toFixed(1)}%</b></span></div>}</div>

            {room && <><div className="admin-minimap-wrap"><canvas ref={canvasRef} className="admin-minimap" aria-label="관리자 실시간 미니 관전 화면" /><div className={`admin-stream-badge ${streamConnected ? "is-live" : ""}`}><i />{streamConnected ? `실시간 · 초당 ${updatesPerSecond}회` : "스트림 재연결 중"}</div><div className="admin-minimap-meta"><span>{room.config.gridWidth}×{room.config.gridHeight}</span><span>순번 {room.sequence}</span><span>{room.server.broadcastMode === "delta" ? "델타 전송" : "전체 전송"}</span><span>갱신 {formatTime(room.updatedAt)}</span></div></div><div className="admin-player-feed" aria-label="실시간 플레이어 위치"><div className="admin-player-feed-head"><span>실시간 참가자 위치</span><small>서버 좌표 · 초당 {updatesPerSecond}회 갱신</small></div><div className="admin-player-feed-grid">{visiblePlayers.map((player) => <div className={`admin-player-live-row ${player.connected ? "" : "is-disconnected"}`} key={player.id}><i style={{ backgroundColor: room.config.teams[player.team].color }} /><div><b>{player.nickname}</b><small>{player.isBot ? "봇" : "참가자"} · {player.team === "A" ? "빨강 팀" : "파랑 팀"}</small></div><code>X {player.position.x.toFixed(1)} · Y {player.position.y.toFixed(1)}</code></div>)}</div>{room.players.length > visiblePlayers.length && <small className="admin-player-more">외 {room.players.length - visiblePlayers.length}명도 실시간 관제 중</small>}</div></>}

            <div className="player-stat-grid"><div className="metric-tile"><span>참가자</span><strong>{room?.players.filter((player) => !player.isBot).length ?? 0}</strong><small>{room?.players.filter((player) => player.connected).length ?? 0}명 연결</small></div><div className="metric-tile team-a"><span>빨강 팀</span><strong>{playerCounts.A}</strong><small>{room?.scores.cells.A ?? 0}칸</small></div><div className="metric-tile team-b"><span>파랑 팀</span><strong>{playerCounts.B}</strong><small>{room?.scores.cells.B ?? 0}칸</small></div><div className="metric-tile"><span>부하 봇</span><strong>{bots}</strong><small>실제 WebSocket 연결</small></div></div>

            <div className="action-strip">{room ? actionsByStatus[room.status].map((action) => <button type="button" key={action} className={`button ${action === "start" || action === "resume" ? "button-primary" : action === "end" ? "button-danger" : "button-secondary"}`} disabled={busy} onClick={() => runAction(action)}>{actionLabels[action]}</button>) : <button className="button button-primary" type="button" onClick={() => void createRoom()}>첫 경기장 만들기</button>}<button className="button button-ghost" type="button" disabled={!room || busy} onClick={() => runAction("reassign")}>{actionLabels.reassign}</button></div>
            <div className={`notice-bar ${error ? "notice-error" : ""}`}>{error || notice}</div>
          </div>

          <section className="panel ops-summary-panel">
            <div className="panel-heading"><div><span className="panel-kicker">한눈에 보는 상태</span><h2>게임·화면 성능 여유</h2></div><span className="actual-tag">{ops?.server.identity.releaseChannel.toUpperCase() ?? "—"} · 최근 최대 120초</span></div>
            <div className="ops-kpi-grid">
              <MetricKpi label="게임 틱 P95" value={`${formatNumber(tickP95Ms, 1)}ms`} unit="밀리초(ms)" description="최근 Tick 처리시간의 95백분위다. 30Hz에서는 한 Tick이 약 33.3ms 안에 끝나야 다음 판정을 제시간에 수행한다." source="/api/ops → server.metrics.tickP95Ms · GameRoom.tick() 실행시간" threshold={`Tick 예산 ${formatNumber(tickBudgetMs, 1)}ms`} utilization={tickUtilization} tone={metricTone(tickUtilization)} />
              <MetricKpi label="입력 지연 P95" value={`${formatNumber(inputLatencyP95Ms, 1)}ms`} unit="밀리초(ms)" description="휴대폰이 기록한 전송 시각부터 서버가 입력을 검증할 때까지 걸린 시간의 95백분위다." source="/api/ops → server.inputLatencyP95Ms · player_input.sentAt" threshold="주의 70ms · 위험 100ms" utilization={inputLatencyUtilization} tone={metricTone(inputLatencyUtilization)} />
              <MetricKpi label="이벤트 루프 P95" value={`${formatNumber(eventLoopLagP95Ms, 1)}ms`} unit="밀리초(ms)" description="Node.js 이벤트 루프가 다른 작업 때문에 제시간에 실행되지 못한 지연의 95백분위다." source="/api/ops → server.metrics.eventLoopLagP95Ms · monitorEventLoopDelay" threshold="주의 35ms · 위험 50ms" utilization={eventLoopUtilization} tone={metricTone(eventLoopUtilization)} />
              <MetricKpi label="CPU 사용률" value={`${formatNumber(cpuPercent, 1)}%`} unit="퍼센트(%)" description="게임 서버 프로세스가 최근 관측 구간에 사용한 CPU 시간 비율이다." source="/api/ops → server.metrics.cpuPercent · process.cpuUsage()" threshold="주의 56% · 위험 80%" utilization={cpuUtilization} tone={metricTone(cpuUtilization)} />
              <MetricKpi label="게임 화면 FPS P10" value={clientTelemetryClients > 0 ? `${formatNumber(clientFpsP10, 1)}fps` : "표본 대기"} unit="초당 프레임(fps)" description="연결된 플레이·관전 브라우저가 requestAnimationFrame으로 직접 잰 FPS 중 하위 10% 값이다. 서버 Tick과 다른 실제 화면 부드러움 지표다." source="/api/ops → server.metrics.clientFpsP10 · 브라우저 requestAnimationFrame → client_render_stats" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" threshold={`${clientTelemetryClients}개 화면 실측 · 정상 55fps 이상`} utilization={clientFpsUtilization} tone={metricTone(clientFpsUtilization)} />
              <MetricKpi label="프레임 누락 P95" value={clientTelemetryClients > 0 ? `${formatNumber(clientFrameDropP95Percent, 1)}%` : "표본 대기"} unit="퍼센트(%)" description="60fps 기준 프레임 간격보다 길어진 requestAnimationFrame 구간에서 추정한 누락률의 95백분위다." source="/api/ops → server.metrics.clientFrameDropP95Percent · 브라우저 rAF 간격 기반 추정" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" threshold="주의 7% · 위험 10%" utilization={clientFrameDropUtilization} tone={metricTone(clientFrameDropUtilization)} />
            </div>
          </section>

          <section className="panel service-status-panel"><div className="panel-heading"><div><span className="panel-kicker">서비스 운영</span><h2>실시간 서버 상태</h2></div><span className="actual-tag">{ops ? `${ops.server.identity.releaseChannel.toUpperCase()} · ${ops.server.identity.version}` : "연결 중"}</span></div><div className="service-metric-grid">
            <div><MetricLabel label="서버 Tick" unit="헤르츠(Hz)" description="서버 권위 판정과 상태 Delta 전송의 목표 빈도다." source="/api/config → tickRateHz" refreshInterval="관리자 화면 진입 시 설정 조회" valueKind="configured" /><strong>{tickRateHz}Hz</strong></div>
            <div><MetricLabel label="연결 소켓" unit="연결 수(개)" description="현재 game-api에 연결된 플레이어·봇·관전자·관리자 Socket.IO 연결 수다." source="/api/ops → server.connectedSockets · io.engine.clientsCount" /><strong>{ops?.server.connectedSockets ?? 0}</strong></div>
            <div><MetricLabel label="게임 틱 P95" unit="밀리초(ms)" description="최근 게임 Tick 처리시간 표본의 95백분위다." source="/api/ops → server.metrics.tickP95Ms" /><strong>{formatNumber(tickP95Ms, 1)}ms</strong></div>
            <div><MetricLabel label="전송 P95" unit="밀리초(ms)" description="상태 Snapshot 또는 Delta를 직렬화하고 전송 요청하는 처리시간의 95백분위다." source="/api/ops → server.metrics.broadcastP95Ms" /><strong>{formatNumber(ops?.server.metrics.broadcastP95Ms ?? 0, 1)}ms</strong></div>
            <div><MetricLabel label="왕복 지연 P95" unit="밀리초(ms)" description="브라우저가 Socket ping을 보내고 ACK를 받을 때까지 직접 측정해 서버에 보고한 실제 왕복시간의 95백분위다." source="/api/ops → server.metrics.websocketRttP95Ms · client_ping ACK → client_rtt.rttMs" /><strong>{formatNumber(ops?.server.metrics.websocketRttP95Ms ?? 0, 1)}ms</strong></div>
            <div><MetricLabel label="게임 화면 FPS P10" unit="초당 프레임(fps)" description="최근 플레이·관전 브라우저의 실제 화면 FPS 중 하위 10% 값이다." source="/api/ops → server.metrics.clientFpsP10 · Socket.IO client_render_stats · requestAnimationFrame" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" /><strong>{clientTelemetryClients > 0 ? `${formatNumber(clientFpsP10, 1)}fps` : "—"}</strong></div>
            <div><MetricLabel label="화면 프레임 P95" unit="밀리초(ms)" description="플레이·관전 브라우저가 관측한 프레임 간격의 95백분위다." source="/api/ops → server.metrics.clientFrameTimeP95Ms · Socket.IO client_render_stats" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" /><strong>{clientTelemetryClients > 0 ? `${formatNumber(ops?.server.metrics.clientFrameTimeP95Ms ?? 0, 1)}ms` : "—"}</strong></div>
            <div><MetricLabel label="화면 표본" unit="브라우저 수(개)" description="최근 5초 안에 렌더 성능을 보고한 플레이·관전 브라우저 수다." source="/api/ops → server.metrics.clientTelemetryClients · 활성 client_render_stats 송신자" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" /><strong>{clientTelemetryClients}개</strong></div>
            <div><MetricLabel label="상태 크기 P95" unit="바이트(B)" description="최근 Snapshot 또는 Delta JSON payload 크기의 95백분위다." source="/api/ops → server.metrics.statePayloadBytes · Buffer.byteLength" /><strong>{formatNumber(ops?.server.metrics.statePayloadBytes ?? 0)}B</strong></div>
            <div><MetricLabel label="스냅샷 경과" unit="초(s)" description="가장 최근 Redis Snapshot 저장 이후 흐른 시간이다." source="/api/ops → server.metrics.snapshotAgeSeconds" /><strong>{formatNumber(ops?.server.metrics.snapshotAgeSeconds ?? 0, 1)}초</strong></div>
            <div><MetricLabel label="RSS 메모리" unit="메비바이트(MB)" description="힙과 네이티브 메모리를 포함한 게임 서버 프로세스의 실제 상주 메모리다." source="/api/ops → server.metrics.memoryRssMb · process.memoryUsage().rss" /><strong>{formatNumber(ops?.server.metrics.memoryRssMb ?? 0, 1)}MB</strong></div>
            <div><MetricLabel label="클러스터" unit="식별자" description="현재 방 권위를 제공하는 서버의 클러스터 식별자다." source="/api/ops → server.identity.cluster · CLUSTER_NAME" valueKind="identity" /><strong>{ops?.server.identity.cluster.toUpperCase() ?? "—"}</strong></div>
          </div></section>

          <section className="panel event-panel"><div className="panel-heading"><div><span className="panel-kicker">운영 이벤트 기록</span><h2>배포·장애·복구 이벤트</h2></div><span className="live-chip"><i /> 실시간</span></div><ol className="event-list admin-timeline">{ops?.recentEvents.slice(0, 18).map((event) => <li key={event.id}><time>{formatTime(event.at)}</time><span className={`event-dot source-${event.source}`} /><div><b>{event.type}</b><p>{event.roomCode ? `[${event.roomCode}] ` : ""}{event.message}</p></div></li>)}</ol></section>

          <details className="panel demo-chaos-panel">
            <summary>
              <span>
                <b>Demo / Chaos 제어</b>
                <small>실제 런타임 제어와 타임라인 전용 시뮬레이션을 구분해 실행합니다.</small>
              </span>
              <span className="demo-chaos-summary-meta"><b>{room ? `${room.roomCode} · ${room.config.releaseChannel.toUpperCase()} · ${room.server.version}` : "방 미선택"}</b><small>펼치기 ▾</small></span>
            </summary>
            <div className="demo-chaos-boundary" role="note">
              <b>표시 경계</b>
              <span>
                아래 상태는 <code>/api/ops?roomCode=… → demoChaos</code>에서 선택 방의 lease owner 프로세스가 직접 보고한 값입니다.
                실제 런타임 제어는 그 담당 프로세스의 모든 Room에 영향을 줄 수 있습니다.
                Primary 장애와 Failover는 타임라인 표식일 뿐 실제 Kubernetes·라우팅·클러스터 상태가 아닙니다.
              </span>
            </div>
            {room && !chaosScopeReady && <p className="demo-chaos-token-warning" role="status">선택 방 담당 서버의 운영 상태를 확인하는 중입니다. 확인이 끝나면 제어 버튼이 활성화됩니다.</p>}
            {!chaosTokenReady && <p className="demo-chaos-token-warning" role="alert">Chaos API는 일반 관리자 인증 우회 설정과 관계없이 ADMIN_TOKEN Bearer 인증이 필수입니다. 상단의 ‘잠금’을 누른 뒤 관리자 토큰으로 다시 열어 주세요.</p>}

            <div className="demo-chaos-action-grid" aria-busy={demoChaosBusy}>
              <article className="demo-chaos-action is-actual">
                <span className="demo-chaos-kind">실제 런타임</span>
                <h3>Tick 지연 주입</h3>
                <p id="demo-chaos-lag-help">게임 루프의 매 Tick에 지연을 실제 추가합니다. 모든 담당 Room의 이동·페인트 판정에 영향을 줍니다.</p>
                <label className="demo-chaos-delay-input">
                  <span>지연 시간</span>
                  <span><input type="number" min="0" max="5000" step="10" value={demoTickDelayMs} onChange={(event) => setDemoTickDelayMs(Math.max(0, Math.min(5_000, Number(event.target.value) || 0)))} /> ms</span>
                </label>
                <div className="demo-chaos-presets" role="group" aria-label="Tick 지연 빠른 선택">
                  {[0, 100, 250, 500].map((delay) => <button type="button" key={delay} aria-pressed={demoTickDelayMs === delay} onClick={() => setDemoTickDelayMs(delay)}>{delay}ms</button>)}
                </div>
                <button type="button" aria-describedby="demo-chaos-lag-help" disabled={!chaosScopeReady || !chaosTokenReady || busy || demoChaosBusy} onClick={applyDemoTickLag}>
                  {chaosBusyAction === "lag" ? "적용 중…" : "실제 지연 적용"}
                </button>
              </article>

              <article className="demo-chaos-action is-actual">
                <span className="demo-chaos-kind">실제 런타임</span>
                <h3>전체 상태 Broadcast</h3>
                <p id="demo-chaos-broadcast-help">Delta 대신 매 Tick 전체 Grid를 실제 전송합니다. Payload·전송시간·화면 FPS가 악화될 수 있습니다.</p>
                <strong>{demoChaos?.runtime.effectiveBroadcastMode.toUpperCase() ?? "상태 대기"}</strong>
                <button type="button" aria-describedby="demo-chaos-broadcast-help" disabled={!chaosScopeReady || !chaosTokenReady || busy || demoChaosBusy} onClick={toggleDemoFullBroadcast}>
                  {chaosBusyAction === "full-broadcast" ? "변경 중…" : demoChaos?.runtime.fullBroadcastEnabled ? "전체 Broadcast 끄기" : "전체 Broadcast 켜기"}
                </button>
              </article>

              <article className="demo-chaos-action is-gated">
                <span className="demo-chaos-kind">환경 허용 시 실제</span>
                <h3>Game Server 종료</h3>
                <p id="demo-chaos-shutdown-help">환경 게이트와 종료 핸들러가 모두 준비된 경우 실제 프로세스를 종료해 WebSocket 재연결을 유발합니다.</p>
                <strong>{shutdownReady ? "실행 가능" : "환경에서 차단됨"}</strong>
                <button type="button" className="is-danger" aria-describedby="demo-chaos-shutdown-help demo-chaos-shutdown-state" disabled={!chaosScopeReady || !chaosTokenReady || !shutdownReady || busy || demoChaosBusy} onClick={requestDemoServerShutdown}>
                  {chaosBusyAction === "server-shutdown" ? "요청 중…" : "실제 서버 종료 요청"}
                </button>
                <small id="demo-chaos-shutdown-state">허용 {demoChaos?.serverShutdown.allowed ? "예" : "아니오"} · 핸들러 {demoChaos?.serverShutdown.handlerAvailable ? "준비" : "없음"}</small>
              </article>

              <article className="demo-chaos-action is-simulation">
                <span className="demo-chaos-kind">시뮬레이션 · 타임라인 전용</span>
                <h3>Primary 장애 이벤트</h3>
                <p id="demo-chaos-primary-help">운영 타임라인에 장애 이벤트만 기록합니다. 실제 Primary 상태나 현재 트래픽은 바꾸지 않습니다.</p>
                <strong>{demoChaos?.simulations.primaryFailure.active ? "SIMULATION 활성" : "대기"}</strong>
                <button type="button" aria-describedby="demo-chaos-primary-help" disabled={!chaosScopeReady || !chaosTokenReady || busy || demoChaosBusy} onClick={simulateDemoPrimaryFailure}>
                  {chaosBusyAction === "primary-failure" ? "기록 중…" : "장애 시뮬레이션"}
                </button>
              </article>

              <article className="demo-chaos-action is-simulation">
                <span className="demo-chaos-kind">시뮬레이션 · 타임라인 전용</span>
                <h3>DR Failover 이벤트</h3>
                <p id="demo-chaos-failover-help">DR 전환 타임라인만 기록합니다. 실제 라우팅·Room 권위·서버 identity는 변경하지 않습니다.</p>
                <strong>{demoChaos?.simulations.failover.active ? `SIMULATION → ${demoChaos.simulations.failover.targetCluster?.toUpperCase() ?? "DR"}` : "대기"}</strong>
                <button type="button" aria-describedby="demo-chaos-failover-help" disabled={!chaosScopeReady || !chaosTokenReady || busy || demoChaosBusy} onClick={simulateDemoFailover}>
                  {chaosBusyAction === "failover" ? "기록 중…" : "Failover 시뮬레이션"}
                </button>
              </article>

              <article className="demo-chaos-action is-reset">
                <span className="demo-chaos-kind">안전 복귀</span>
                <h3>Demo 상태 초기화</h3>
                <p id="demo-chaos-reset-help">관리자 런타임 오버라이드와 시뮬레이션 표식을 지우고 환경변수의 기본 설정으로 돌아갑니다.</p>
                <strong>{demoChaos?.runtime.overrideActive || demoChaos?.simulations.primaryFailure.active || demoChaos?.simulations.failover.active ? "초기화 필요" : "기본 상태"}</strong>
                <button type="button" className="chaos-reset" aria-describedby="demo-chaos-reset-help" disabled={!chaosScopeReady || !chaosTokenReady || busy || demoChaosBusy} onClick={resetDemoChaos}>
                  {chaosBusyAction === "reset" ? "초기화 중…" : "모든 Demo 상태 해제"}
                </button>
              </article>
            </div>

            <section className="demo-chaos-status" aria-live="polite" aria-label="game-api가 보고한 Demo Chaos 상태">
              <header>
                <div><span className="panel-kicker">game-api-runtime 응답</span><h3>현재 DemoChaosStatus</h3></div>
                <time dateTime={demoChaos?.observedAt}>{demoChaos ? formatTime(demoChaos.observedAt) : "관측 대기"}</time>
              </header>
              <div className="demo-chaos-status-grid">
                <div>
                  <span>적용 대상</span>
                  <b>{demoChaos?.scope.kind === "room-owner-process" ? "ROOM OWNER" : "PROCESS"}</b>
                  <small>{demoChaos ? `${demoChaos.scope.roomCode ?? "전체 프로세스"} · ${demoChaos.scope.podName}` : "담당 서버 확인 중"}</small>
                </div>
                <div>
                  <span>실제 Tick 지연</span>
                  <b>{demoChaos ? `${demoChaos.runtime.tickDelayMs}ms` : "—"}</b>
                  <small>환경 기본 {demoChaos?.runtime.configuredTickDelayMs ?? "—"}ms · {demoChaos?.runtime.source === "admin-api" ? "관리자 API 적용" : "환경 설정"}</small>
                </div>
                <div>
                  <span>실제 전송 모드</span>
                  <b>{demoChaos?.runtime.effectiveBroadcastMode.toUpperCase() ?? "—"}</b>
                  <small>{demoChaos?.runtime.fullBroadcastEnabled ? "전체 Grid Broadcast 활성" : "Delta Broadcast 활성"}</small>
                </div>
                <div className="is-simulation-status">
                  <span>Primary 이벤트</span>
                  <b>{demoChaos?.simulations.primaryFailure.active ? "SIMULATION" : "비활성"}</b>
                  <small>{demoChaos?.simulations.primaryFailure.requestedAt ? formatTime(demoChaos.simulations.primaryFailure.requestedAt) : "타임라인 표식 없음"}</small>
                </div>
                <div className="is-simulation-status">
                  <span>Failover 이벤트</span>
                  <b>{demoChaos?.simulations.failover.active ? "SIMULATION" : "비활성"}</b>
                  <small>{demoChaos?.simulations.failover.targetCluster ? `표식 대상 ${demoChaos.simulations.failover.targetCluster.toUpperCase()}` : "실제 라우팅 변경 없음"}</small>
                </div>
                <div>
                  <span>서버 종료 게이트</span>
                  <b>{shutdownReady ? "READY" : "BLOCKED"}</b>
                  <small>환경 허용 {demoChaos?.serverShutdown.allowed ? "예" : "아니오"} · 핸들러 {demoChaos?.serverShutdown.handlerAvailable ? "준비" : "없음"}</small>
                </div>
                <div>
                  <span>마지막 런타임 변경</span>
                  <b>{demoChaos?.runtime.overrideActive ? "OVERRIDE" : "ENVIRONMENT"}</b>
                  <small>{demoChaos?.runtime.updatedAt ? formatTime(demoChaos.runtime.updatedAt) : "관리자 변경 없음"}</small>
                </div>
              </div>
            </section>
          </details>

          <details className="panel chaos-panel"><summary><span><b>실제 OOM 장애 주입</b><small>별도 실험 경로: 메모리 누수 → OOMKilled → Kubernetes 자동 재시작</small></span><span>펼치기 ▾</span></summary><div className="chaos-grid"><button type="button" className="button-danger" disabled={busy || demoChaosBusy || ops?.faultInjection.phase === "allocating" || ops?.faultInjection.phase === "restarting"} onClick={runMemoryOom}>실제 OOMKilled 시작</button></div><div className="fault-observation-grid"><div><span>상태</span><b>{ops?.faultInjection.phase ?? "idle"}</b></div><div><span>할당량</span><b>{ops?.faultInjection.allocatedMiB.toFixed(0) ?? "0"} MiB</b></div><div><span>대상 Pod</span><b>{ops?.faultInjection.targetPod ?? "—"}</b></div><div><span>종료 이유</span><b>{ops?.faultInjection.lastTerminationReason ?? "—"}</b></div></div><p>{ops?.faultInjection.message ?? "내부 상태를 꾸미지 않고 Kubernetes가 관측한 실제 종료와 복귀만 완료로 표시합니다."}</p></details>
          <section className="panel metric-history-panel">
            <div className="panel-heading">
              <div><span className="panel-kicker">실시간 트래픽 추이</span><h2>운영·부하 지표</h2></div>
              <span className="actual-tag">{ops?.server.identity.releaseChannel.toUpperCase() ?? "—"} · 최근 120초</span>
            </div>
            <div className="ops-health-strip">
              <div><MetricLabel label="초당 입력" unit="이벤트/초" description="서버가 최근 1초 동안 받은 player_input 이벤트 수다." source="/api/ops → server.inputEventsPerSecond" /><strong>{formatNumber(ops?.server.inputEventsPerSecond ?? 0)}</strong></div>
              <div><MetricLabel label="입력 지연 P95" unit="밀리초(ms)" description="입력 전송부터 서버 검증까지 지연의 95백분위다." source="/api/ops → server.inputLatencyP95Ms" /><strong>{formatNumber(inputLatencyP95Ms, 1)}ms</strong></div>
              <div><MetricLabel label="입력 거부율" unit="퍼센트(%)" description="누적 입력 중 범위·세션·빈도·순서 검증에서 거부된 비율이다." source="/api/ops → server.metrics.inputRejectRate" /><strong>{formatNumber(ops?.server.metrics.inputRejectRate ?? 0, 2)}%</strong></div>
              <div><MetricLabel label="재접속" unit="누적 횟수(회)" description="서버 시작 이후 같은 세션으로 복구된 Socket.IO 재접속 누적 횟수다." source="/api/ops → server.reconnects" /><strong>{formatNumber(ops?.server.reconnects ?? 0)}</strong></div>
              <div><MetricLabel label="연결 끊김" unit="누적 횟수(회)" description="서버 시작 이후 관측한 Socket.IO disconnect 누적 횟수다." source="/api/ops → server.disconnects" /><strong>{formatNumber(ops?.server.disconnects ?? 0)}</strong></div>
              <div><MetricLabel label="가동 시간" unit="초(s)" description="현재 game-api 프로세스가 시작된 이후 경과한 시간이다." source="/api/ops → server.uptimeSeconds · process.uptime()" /><strong>{formatNumber(ops?.server.uptimeSeconds ?? 0)}초</strong></div>
              <div><MetricLabel label="게임 화면 FPS" unit="초당 프레임(fps)" description="플레이·관전 브라우저의 실제 FPS 하위 10% 값이다." source="/api/ops → server.metrics.clientFpsP10 · Socket.IO client_render_stats" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" /><strong>{clientTelemetryClients > 0 ? formatNumber(clientFpsP10, 1) : "—"}</strong></div>
              <div><MetricLabel label="프레임 누락" unit="퍼센트(%)" description="60fps 기준 requestAnimationFrame 간격으로 추정한 누락률 P95다." source="/api/ops → server.metrics.clientFrameDropP95Percent · Socket.IO client_render_stats" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" /><strong>{clientTelemetryClients > 0 ? `${formatNumber(clientFrameDropP95Percent, 1)}%` : "—"}</strong></div>
            </div>
            <div className="metric-chart-grid">
              <MetricChart title="입력 처리량" unit="/초" description="플레이어 이동 입력 처리량" source="/api/ops → server.inputEventsPerSecond" color="#93ff4f" points={chartPoints((sample) => sample.inputRate)} decimals={0} />
              <MetricChart title="연결 소켓 수" unit="" description="사람·관전자·봇·관리자 연결 수" source="/api/ops → server.connectedSockets" color="#25a8ff" points={chartPoints((sample) => sample.sockets)} decimals={0} />
              <MetricChart title="입력 지연 P95" unit="ms" description="입력 전송부터 검증까지의 지연" source="/api/ops → server.inputLatencyP95Ms" color="#ffbf47" points={chartPoints((sample) => sample.inputLatency)} decimals={1} />
              <MetricChart title="게임 틱 P95" unit="ms" description="게임 루프 한 회 처리 시간" source="/api/ops → server.metrics.tickP95Ms" color="#ff405a" points={chartPoints((sample) => sample.tick)} decimals={1} />
              <MetricChart title="이벤트 루프 지연 P95" unit="ms" description="Node.js 이벤트 루프 정체" source="/api/ops → server.metrics.eventLoopLagP95Ms" color="#c98cff" points={chartPoints((sample) => sample.eventLoopLag)} decimals={1} />
              <MetricChart title="CPU 사용률" unit="%" description="게임 서버 프로세스 CPU" source="/api/ops → server.metrics.cpuPercent" color="#51e2c2" points={chartPoints((sample) => sample.cpu)} decimals={1} />
              <MetricChart title="RSS 메모리" unit="MB" description="게임 서버 실제 상주 메모리" source="/api/ops → server.metrics.memoryRssMb" color="#f28ac7" points={chartPoints((sample) => sample.memory)} decimals={1} />
              <MetricChart title="상태 전송 크기 P95" unit="KB" description="클라이언트 상태 전송 크기" source="/api/ops → server.metrics.statePayloadBytes" color="#9eb5ff" points={chartPoints((sample) => sample.payload)} decimals={1} />
              <MetricChart title="게임 화면 FPS P10" unit="fps" description="플레이·관전 브라우저 실제 FPS 하위 10%" source="/api/ops → server.metrics.clientFpsP10 · Socket.IO client_render_stats · requestAnimationFrame" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" color="#7dffdc" points={chartPoints((sample) => sample.clientFps)} decimals={1} />
              <MetricChart title="프레임 누락률 P95" unit="%" description="60fps 기준 브라우저 프레임 누락 추정치" source="/api/ops → server.metrics.clientFrameDropP95Percent · Socket.IO client_render_stats" refreshInterval="브라우저 최근 5초 표본 · Ops Snapshot 약 1초" color="#ff7e67" points={chartPoints((sample) => sample.clientFrameDrop)} decimals={1} />
            </div>
          </section>

          <section className="panel infrastructure-panel">
            <div className="panel-heading"><div><span className="panel-kicker">실행 환경</span><h2>배포·Kubernetes 관측</h2></div><span className="actual-tag">{ops?.infrastructure.source === "kubernetes-api" ? "Kubernetes API" : "로컬 런타임"}</span></div>
            <div className="service-metric-grid infrastructure-metric-grid">
              <div><MetricLabel label="관측 모드" unit="모드 식별자" description="인프라 값이 Kubernetes API 실측인지 로컬 런타임 정보인지 구분한다." source="/api/ops → infrastructure.source" refreshInterval="Ops Snapshot 약 1초 · Kubernetes API 결과는 최대 5초 캐시" valueKind="identity" /><strong>{ops?.infrastructure.mode.toUpperCase() ?? "—"}</strong></div>
              <div><MetricLabel label="준비 Replica" unit="Replica 수(개)" description="Deployment가 Ready로 보고한 Replica 수와 목표 Replica 수다." source="Kubernetes Apps API → readyReplicas / desiredReplicas" refreshInterval="Ops Snapshot 약 1초 · Kubernetes API 결과는 최대 5초 캐시" /><strong>{ops?.infrastructure.readyReplicas ?? "—"} / {ops?.infrastructure.desiredReplicas ?? "—"}</strong></div>
              <div><MetricLabel label="관측 Pod" unit="Pod 수(개)" description="Kubernetes API에서 조회한 game-api Pod 수다. 로컬에서는 0이다." source="Kubernetes Core API → pods.items" refreshInterval="Ops Snapshot 약 1초 · Kubernetes API 결과는 최대 5초 캐시" /><strong>{ops?.infrastructure.pods.length ?? 0}</strong></div>
              <div><MetricLabel label="이미지" unit="이미지 태그" description="현재 배포가 보고한 컨테이너 이미지 태그 또는 로컬 이미지 식별자다." source="/api/ops → infrastructure.imageTag" refreshInterval="Ops Snapshot 약 1초 · Kubernetes API 결과는 최대 5초 캐시" valueKind="identity" /><strong>{ops?.infrastructure.imageTag ?? "—"}</strong></div>
            </div>
            <p className="infrastructure-message">{ops?.infrastructure.message ?? "인프라 관측을 기다리는 중입니다."}</p>
          </section>

          {room && <section className="panel bulk-bot-panel">
            <div className="panel-heading">
              <div><span className="panel-kicker">WebSocket 부하 생성기</span><h2>대량 봇 부하 테스트</h2></div>
              <span className="count-badge">{connectedBots}/{bots}개 연결</span>
            </div>
            <p>각 봇은 실제 WebSocket으로 접속해 이동 입력을 보냅니다. 한 번에 최대 500개까지 추가하거나 회수할 수 있습니다.</p>
            <div className="bot-load-controls">
              <label><span>한 번에 투입할 수</span><input type="number" min="1" max="500" value={botBatchSize} onChange={(event) => setBotBatchSize(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} /></label>
              <button type="button" className="button button-primary" disabled={busy} onClick={() => runBots("add", botBatchSize)}>봇 추가</button>
              <button type="button" className="button button-secondary" disabled={busy || bots === 0} onClick={() => runBots("remove", botBatchSize)}>봇 회수</button>
              <button type="button" className="button button-danger" disabled={busy || bots === 0} onClick={() => runBots("remove", 500)}>모두 회수</button>
            </div>
            <div className="bot-load-presets" aria-label="봇 수 빠른 선택">
              {[50, 100, 250, 500].map((count) => <button type="button" key={count} className={botBatchSize === count ? "is-selected" : ""} onClick={() => setBotBatchSize(count)}>{count}개 봇</button>)}
            </div>
          </section>}
        </section>

        <aside className="join-panel panel admin-actions-panel">
          <div className="panel-heading"><div><span className="panel-kicker">{activeTab === "controls" ? "선택 Room 부하" : "입장·게임 이벤트"}</span><h2>{activeTab === "controls" ? "빠른 봇 제어" : "QR·Paint Boost·공지"}</h2></div></div>
          {room ? <><div className="qr-frame"><QrCode value={joinUrl} label={`방 ${room.roomCode} 입장`} size={210} /></div><strong className="join-room-code">{room.roomCode}</strong><div className="url-box"><span>참가 링크</span><code>{joinUrl}</code></div><a className="button button-secondary button-block" href={watchUrl} target="_blank" rel="noreferrer">관전 화면 열기 ↗</a><div className="admin-event-actions"><button className="button boost-button button-block" type="button" disabled={busy} onClick={() => void run(async () => { const result = await api.paintBoost(room.roomCode); setRoom(result.room); }, "페인트 강화 ×2 시작")}>페인트 강화 ×2 · 10초</button><div className="bot-control"><button type="button" disabled={busy} onClick={() => void run(() => api.bots(room.roomCode, "remove", 5), "봇 5개 회수 완료")}>− 봇 5개</button><span>{bots}개 활성</span><button type="button" disabled={busy} onClick={() => void run(() => api.bots(room.roomCode, "add", 5), "봇 5개 추가 완료")}>＋ 봇 5개</button></div><label className="announcement-control"><span>운영 공지</span><textarea maxLength={160} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="관전/플레이 화면 공지" /><button type="button" onClick={() => void run(async () => { const result = await api.announcement(room.roomCode, announcement); setRoom(result.room); }, "공지 전송 완료")}>전송</button></label></div></> : <div className="qr-empty"><div className="qr-placeholder-icon">＋</div><h3>활성 경기장 없음</h3><p>경기장을 만들면 입장 QR과 운영 기능이 표시됩니다.</p></div>}
        </aside>
      </div>}
      </section>)}
      {isArenaModalOpen && room && <div className="admin-canvas-modal" role="dialog" aria-modal="true" aria-label={`${room.roomCode} 실시간 확대 관전`} onMouseDown={(event) => { if (event.target === event.currentTarget) setIsArenaModalOpen(false); }}>
        <section className="admin-canvas-modal-panel panel">
          <header>
            <div><span className="panel-kicker">실시간 경기장 전체 보기</span><h2>{room.roomCode} · 전체 캔버스 관전</h2></div>
            <div className="admin-canvas-modal-actions"><span className={`live-chip ${streamConnected ? "" : "is-offline"}`}><i /> 초당 {updatesPerSecond}회</span><button type="button" autoFocus aria-label="확대 관전 닫기" onClick={() => setIsArenaModalOpen(false)}>닫기 ×</button></div>
          </header>
          <div className="admin-canvas-modal-stage"><canvas ref={modalCanvasRef} aria-label="관리자 전체 월드 실시간 확대 관전 화면" />{room.announcement && <div className="watch-announcement">{room.announcement}</div>}</div>
          <footer>
            <span><small>월드</small><b>{room.config.gridWidth}×{room.config.gridHeight}</b></span>
            <span><small>상태</small><b>{roomStatusLabels[room.status]} · {formatTimer(room.remainingMs)}</b></span>
            <span style={{ color: room.config.teams.A.color }}><small>빨강</small><b>{room.scores.percentage.A.toFixed(1)}% · {playerCounts.A}명</b></span>
            <span style={{ color: room.config.teams.B.color }}><small>파랑</small><b>{room.scores.percentage.B.toFixed(1)}% · {playerCounts.B}명</b></span>
            <span><small>부하</small><b>봇 {bots}개 · 소켓 {ops?.server.connectedSockets ?? 0}개</b></span>
          </footer>
        </section>
      </div>}
    </AppShell>
  );
};
