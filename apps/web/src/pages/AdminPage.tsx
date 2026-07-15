import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpsSnapshot, RoomSnapshot, RoomStatus, StateDelta, TeamId, WatchResult } from "@paint-arena/shared";
import type { Socket } from "socket.io-client";
import { AppShell } from "../components/AppShell";
import { MetricChart } from "../components/MetricChart";
import { QrCode } from "../components/QrCode";
import { StatusPill } from "../components/StatusPill";
import { ArenaCanvasRenderer } from "../game/arenaCanvas";
import { api, clearAdminToken, getAdminToken, setAdminToken } from "../lib/api";
import { formatNumber, formatTime, formatTimer } from "../lib/format";
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
}

const DEFAULT_WORLD_SIZE = 216;

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

export const AdminPage = () => {
  const [tokenInput, setTokenInput] = useState(getAdminToken());
  const [authorized, setAuthorized] = useState(false);
  const [rooms, setRooms] = useState<OpsSnapshot["rooms"]>([]);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [ops, setOps] = useState<OpsSnapshot | null>(null);
  const [selectedCode, setSelectedCode] = useState(() => new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? localStorage.getItem("color-turf-admin-room") ?? "");
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [tickRateHz, setTickRateHz] = useState(20);
  const [settings, setSettings] = useState(initialSettings);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("운영 명령을 기다리는 중입니다.");
  const [error, setError] = useState("");
  const [streamConnected, setStreamConnected] = useState(false);
  const [updatesPerSecond, setUpdatesPerSecond] = useState(0);
  const [metricHistory, setMetricHistory] = useState<OpsHistorySample[]>([]);
  const [botBatchSize, setBotBatchSize] = useState(100);
  const [isArenaModalOpen, setIsArenaModalOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const modalRendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const selectedCodeRef = useRef(selectedCode);
  const adminSocketReadyRef = useRef(false);
  const updateCountRef = useRef(0);

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
      setRoom(null);
    }
  }, [acceptOpsSnapshot, authorized, selectedCode]);

  useEffect(() => { void refresh().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "상태를 불러오지 못했습니다.")); }, [refresh]);

  const subscribeAdminRoom = useCallback((code: string) => {
    const socket = socketRef.current;
    if (!code || !socket?.connected || !adminSocketReadyRef.current) return;
    socket.emit("admin.room.watch", { roomCode: code }, (result: WatchResult) => {
      if (!result.ok || !result.snapshot) {
        setError(result.error ?? "관리자 실시간 관제 구독에 실패했습니다.");
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
        socket.emit("ops.watch", acceptOpsSnapshot);
        subscribeAdminRoom(selectedCodeRef.current);
      });
    });
    socket.on("disconnect", () => { adminSocketReadyRef.current = false; setStreamConnected(false); setUpdatesPerSecond(0); });
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
    const resyncTimer = window.setInterval(() => subscribeAdminRoom(selectedCodeRef.current), 5000);
    return () => {
      window.clearInterval(rateTimer);
      window.clearInterval(resyncTimer);
      adminSocketReadyRef.current = false;
      if (socketRef.current === socket) socketRef.current = null;
      socket.disconnect();
    };
  }, [acceptOpsSnapshot, authorized, subscribeAdminRoom]);

  useEffect(() => {
    if (!room) return;
    setSettings({
      durationSeconds: room.config.durationSeconds,
      gridWidth: DEFAULT_WORLD_SIZE,
      gridHeight: DEFAULT_WORLD_SIZE,
      paintRadius: room.config.paintRadius,
      releaseChannel: room.config.releaseChannel,
      colorA: room.config.teams.A.color,
      colorB: room.config.teams.B.color,
    });
  }, [room?.roomCode]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;
    if (room) renderer.update(room);
    return () => { renderer.destroy(); rendererRef.current = null; };
  }, [Boolean(room)]);

  useEffect(() => { if (room) rendererRef.current?.update(room); }, [room]);

  useEffect(() => {
    if (!isArenaModalOpen || !room || !modalCanvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(modalCanvasRef.current);
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

  if (!authorized) return <div className="admin-login-page"><div className="admin-login-card"><span className="panel-kicker">관리자 전용 운영</span><h1>컬러 터프 관리실</h1><p>게임·봇·장애 시연 API는 관리자 토큰으로 보호됩니다.</p><label><span>관리자 토큰</span><input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void login(); }} placeholder="demo-admin" /></label><button type="button" className="button button-primary button-block" onClick={() => void login()}>관리자 화면 열기</button>{error && <div className="notice-bar notice-error">{error}</div>}</div></div>;

  return (
    <AppShell eyebrow="게임 디렉터 / KUBERNETES 운영" title="컬러 터프 관리실" actions={<>
      <span className={`live-chip ${streamConnected ? "" : "is-offline"}`}><i /> {streamConnected ? `실시간 · 초당 ${updatesPerSecond}회` : "재연결 중"}</span>
      <button className="button button-secondary admin-canvas-open" type="button" disabled={!room} onClick={() => setIsArenaModalOpen(true)}>캔버스 크게 보기 ↗</button>
      <button className="button button-ghost" type="button" onClick={logout}>잠금</button>
    </>}>
      <div className="admin-layout color-turf-admin">
        <aside className="room-rail panel">
          <div className="panel-heading"><div><span className="panel-kicker">경기방</span><h2>경기장 목록</h2></div><span className="count-badge">{rooms.length}</span></div>
          <div className="room-list">{rooms.length === 0 && <p className="empty-copy">아직 생성된 방이 없습니다.</p>}{rooms.map((item) => <button type="button" key={item.roomCode} className={`room-list-item ${selectedCode === item.roomCode ? "is-selected" : ""}`} onClick={() => selectRoom(item.roomCode)}><span><b>{item.roomCode}</b><small>{item.releaseChannel.toUpperCase()} · {item.connectedPlayers}/{item.players}명 연결</small></span><StatusPill status={item.status} locale="ko" /></button>)}</div>
          <div className="compact-create-fields"><label><span>배포 채널</span><select value={settings.releaseChannel} onChange={(event) => setSettings({ ...settings, releaseChannel: event.target.value as "stable" | "canary" })}><option value="stable">Stable v1.1.3 · 델타 전송</option><option value="canary">Canary v1.2.0 · 전체 전송</option></select></label><label><span>경기 시간(초)</span><input type="number" min="15" max="300" value={settings.durationSeconds} onChange={(event) => setSettings({ ...settings, durationSeconds: Number(event.target.value) })} /></label></div>
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

          <section className="panel service-status-panel"><div className="panel-heading"><div><span className="panel-kicker">서비스 운영</span><h2>실시간 서버 상태</h2></div><span className="actual-tag">실측 지표</span></div><div className="service-metric-grid"><div><span>서버 Tick</span><strong>{tickRateHz}Hz</strong></div><div><span>연결 소켓</span><strong>{ops?.server.connectedSockets ?? 0}</strong></div><div><span>게임 틱 P95</span><strong>{formatNumber(ops?.server.metrics.tickP95Ms ?? 0, 1)}ms</strong></div><div><span>전송 P95</span><strong>{formatNumber(ops?.server.metrics.broadcastP95Ms ?? 0, 1)}ms</strong></div><div><span>왕복 지연 P95</span><strong>{formatNumber(ops?.server.metrics.websocketRttP95Ms ?? 0, 1)}ms</strong></div><div><span>상태 크기 P95</span><strong>{formatNumber(ops?.server.metrics.statePayloadBytes ?? 0)}B</strong></div><div><span>스냅샷 경과</span><strong>{formatNumber(ops?.server.metrics.snapshotAgeSeconds ?? 0, 1)}초</strong></div><div><span>버전</span><strong>{ops?.server.identity.version ?? "—"}</strong></div><div><span>클러스터</span><strong>{ops?.server.identity.cluster.toUpperCase() ?? "—"}</strong></div></div></section>

          <section className="panel event-panel"><div className="panel-heading"><div><span className="panel-kicker">운영 이벤트 기록</span><h2>배포·장애·복구 이벤트</h2></div><span className="live-chip"><i /> 실시간</span></div><ol className="event-list admin-timeline">{ops?.recentEvents.slice(0, 18).map((event) => <li key={event.id}><time>{formatTime(event.at)}</time><span className={`event-dot source-${event.source}`} /><div><b>{event.type}</b><p>{event.roomCode ? `[${event.roomCode}] ` : ""}{event.message}</p></div></li>)}</ol></section>

          <details className="panel chaos-panel"><summary><span><b>실제 장애 주입</b><small>단 하나의 정직한 경로: 메모리 누수 → OOMKilled → 자동 재시작</small></span><span>펼치기 ▾</span></summary><div className="chaos-grid"><button type="button" className="button-danger" disabled={busy || ops?.faultInjection.phase === "allocating" || ops?.faultInjection.phase === "restarting"} onClick={runMemoryOom}>실제 OOMKilled 시작</button></div><div className="fault-observation-grid"><div><span>상태</span><b>{ops?.faultInjection.phase ?? "idle"}</b></div><div><span>할당량</span><b>{ops?.faultInjection.allocatedMiB.toFixed(0) ?? "0"} MiB</b></div><div><span>대상 Pod</span><b>{ops?.faultInjection.targetPod ?? "—"}</b></div><div><span>종료 이유</span><b>{ops?.faultInjection.lastTerminationReason ?? "—"}</b></div></div><p>{ops?.faultInjection.message ?? "내부 상태를 꾸미지 않고 Kubernetes가 관측한 실제 종료와 복귀만 완료로 표시합니다."}</p></details>
          <section className="panel metric-history-panel">
            <div className="panel-heading">
              <div><span className="panel-kicker">실시간 트래픽 추이</span><h2>운영·부하 지표</h2></div>
              <span className="actual-tag">최근 120초</span>
            </div>
            <div className="ops-health-strip">
              <div><span>초당 입력</span><strong>{formatNumber(ops?.server.inputEventsPerSecond ?? 0)}</strong></div>
              <div><span>입력 지연 P95</span><strong>{formatNumber(ops?.server.inputLatencyP95Ms ?? 0, 1)}ms</strong></div>
              <div><span>입력 거부율</span><strong>{formatNumber(ops?.server.metrics.inputRejectRate ?? 0, 2)}%</strong></div>
              <div><span>이벤트 루프 P95</span><strong>{formatNumber(ops?.server.metrics.eventLoopLagP95Ms ?? 0, 1)}ms</strong></div>
              <div><span>CPU 사용률</span><strong>{formatNumber(ops?.server.metrics.cpuPercent ?? 0, 1)}%</strong></div>
              <div><span>RSS 메모리</span><strong>{formatNumber(ops?.server.metrics.memoryRssMb ?? 0, 1)}MB</strong></div>
            </div>
            <div className="metric-chart-grid">
              <MetricChart title="입력 처리량" unit="/초" description="플레이어 이동 입력 처리량" color="#93ff4f" points={chartPoints((sample) => sample.inputRate)} decimals={0} />
              <MetricChart title="연결 소켓 수" unit="" description="사람·관전자·봇 연결 수" color="#25a8ff" points={chartPoints((sample) => sample.sockets)} decimals={0} />
              <MetricChart title="입력 지연 P95" unit="ms" description="입력 수신부터 검증까지의 지연" color="#ffbf47" points={chartPoints((sample) => sample.inputLatency)} decimals={1} />
              <MetricChart title="게임 틱 P95" unit="ms" description="게임 루프 한 회 처리 시간" color="#ff405a" points={chartPoints((sample) => sample.tick)} decimals={1} />
              <MetricChart title="이벤트 루프 지연 P95" unit="ms" description="Node.js 이벤트 루프 정체" color="#c98cff" points={chartPoints((sample) => sample.eventLoopLag)} decimals={1} />
              <MetricChart title="CPU 사용률" unit="%" description="게임 서버 프로세스 CPU" color="#51e2c2" points={chartPoints((sample) => sample.cpu)} decimals={1} />
              <MetricChart title="RSS 메모리" unit="MB" description="게임 서버 실제 메모리 점유" color="#f28ac7" points={chartPoints((sample) => sample.memory)} decimals={1} />
              <MetricChart title="상태 전송 크기 P95" unit="KB" description="클라이언트 상태 전송 크기" color="#9eb5ff" points={chartPoints((sample) => sample.payload)} decimals={1} />
            </div>
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
          <div className="panel-heading"><div><span className="panel-kicker">모바일 참가</span><h2>QR과 운영 기능</h2></div></div>
          {room ? <><div className="qr-frame"><QrCode value={joinUrl} label={`방 ${room.roomCode} 입장`} size={210} /></div><strong className="join-room-code">{room.roomCode}</strong><div className="url-box"><span>참가 링크</span><code>{joinUrl}</code></div><a className="button button-secondary button-block" href={watchUrl} target="_blank" rel="noreferrer">관전 화면 열기 ↗</a><div className="admin-event-actions"><button className="button boost-button button-block" type="button" disabled={busy} onClick={() => void run(async () => { const result = await api.paintBoost(room.roomCode); setRoom(result.room); }, "페인트 강화 ×2 시작")}>페인트 강화 ×2 · 10초</button><div className="bot-control"><button type="button" disabled={busy} onClick={() => void run(() => api.bots(room.roomCode, "remove", 5), "봇 5개 회수 완료")}>− 봇 5개</button><span>{bots}개 활성</span><button type="button" disabled={busy} onClick={() => void run(() => api.bots(room.roomCode, "add", 5), "봇 5개 추가 완료")}>＋ 봇 5개</button></div><label className="announcement-control"><span>운영 공지</span><textarea maxLength={160} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="관전/플레이 화면 공지" /><button type="button" onClick={() => void run(async () => { const result = await api.announcement(room.roomCode, announcement); setRoom(result.room); }, "공지 전송 완료")}>전송</button></label></div></> : <div className="qr-empty"><div className="qr-placeholder-icon">＋</div><h3>활성 경기장 없음</h3><p>경기장을 만들면 입장 QR과 운영 기능이 표시됩니다.</p></div>}
        </aside>
      </div>
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
