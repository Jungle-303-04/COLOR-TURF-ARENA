import { useEffect, useState } from "react";
import type { OpsSnapshot } from "@paint-arena/shared";
import { AppShell } from "../components/AppShell";
import { MetricLabel } from "../components/MetricHelp";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { formatNumber, formatTime } from "../lib/format";
import { createSocket } from "../lib/socket";

const formatUptime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safeSeconds / 86_400);
  const hours = Math.floor((safeSeconds % 86_400) / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${remainingSeconds}초`;
  return `${remainingSeconds}초`;
};

const faultPhaseLabels: Record<OpsSnapshot["faultInjection"]["phase"], string> = {
  idle: "대기",
  allocating: "메모리 할당 중",
  restarting: "재시작 중",
  recovered: "복구 완료",
  failed: "실패",
};

export const OpsPage = () => {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [socketLive, setSocketLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const socket = createSocket();
    socket.on("connect", () => {
      setSocketLive(true);
      socket.emit("ops.watch", (initial: OpsSnapshot) => setSnapshot(initial));
    });
    socket.on("disconnect", () => setSocketLive(false));
    socket.on("ops.snapshot", (next: OpsSnapshot) => setSnapshot(next));
    socket.connect();
    void api.ops().then(setSnapshot).catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "관제 상태를 불러오지 못했습니다."));
    return () => {
      socket.disconnect();
    };
  }, []);

  const triggerMemoryOom = async () => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await api.triggerMemoryOom());
    } catch (simulationError) {
      setError(simulationError instanceof Error ? simulationError.message : "실제 메모리 장애 주입에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const server = snapshot?.server;
  const infrastructure = snapshot?.infrastructure;
  const fault = snapshot?.faultInjection;
  const activeRooms = snapshot?.rooms.filter((room) => room.status === "running").length ?? 0;
  const totalPlayers = snapshot?.rooms.reduce((sum, room) => sum + room.connectedPlayers, 0) ?? 0;

  return (
    <AppShell
      eyebrow="관측성 / 실시간 운영"
      title="운영 관제 대시보드"
      actions={<span className={`live-chip ${socketLive ? "" : "is-offline"}`}><i />{socketLive ? "실시간 수신" : "재연결 중"}</span>}
    >
      {error && <div className="notice-bar notice-error">{error}</div>}
      <div className="ops-banner">
        <div><span className="actual-tag">실제 텔레메트리</span><p>서버·게임·Socket 수치는 실제 런타임 상태에서 계산됩니다.</p></div>
        <time>{snapshot ? `관측 ${formatTime(snapshot.observedAt)}` : "연결 중…"}</time>
      </div>

      <section className="ops-metric-grid">
        <article className="ops-metric">
          <MetricLabel label="서버 상태" description="game-api 프로세스의 헬스 상태와 저장소 준비 여부다." source="/api/ops → server.health, server.ready" />
          <strong className="healthy-text"><i />{server?.health === "healthy" ? "정상" : "—"}</strong>
          <small>준비 상태: {server?.ready ? "완료" : "확인 중"}</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="연결 소켓" description="현재 game-api에 연결된 플레이어·봇·관전자·관리자 Socket.IO 연결 수다." source="/api/ops → server.connectedSockets · io.engine.clientsCount" />
          <strong>{server?.connectedSockets ?? 0}</strong>
          <small>플레이어 컨트롤러 {totalPlayers}개</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="초당 입력" description="서버가 최근 1초 동안 받은 플레이어 이동 입력 이벤트 수다." source="/api/ops → server.inputEventsPerSecond" />
          <strong>{server?.inputEventsPerSecond ?? 0}</strong>
          <small>누적 {formatNumber(server?.totalInputEvents ?? 0)}건</small>
        </article>
        <article className="ops-metric ops-metric-emphasis">
          <MetricLabel label="입력 지연 P95" description="휴대폰이 기록한 전송 시각부터 서버가 입력을 검증할 때까지 걸린 시간의 95백분위다." source="/api/ops → server.inputLatencyP95Ms · player_input.sentAt" />
          <strong>{formatNumber(server?.inputLatencyP95Ms ?? 0, 1)}<em>ms</em></strong>
          <small>실제 입력 이벤트 표본</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="게임 틱 P95" description="최근 서버 권위 게임 Tick 처리시간 표본의 95백분위다." source="/api/ops → server.metrics.tickP95Ms · GameRoom.tick() 실행시간" />
          <strong>{formatNumber(server?.metrics.tickP95Ms ?? 0, 1)}<em>ms</em></strong>
          <small>{server?.identity.broadcastMode ?? "—"} 상태 전송</small>
        </article>
        <article className="ops-metric ops-metric-emphasis">
          <MetricLabel label="이벤트 루프 P95" description="Node.js 이벤트 루프가 다른 작업 때문에 제시간에 실행되지 못한 지연의 95백분위다." source="/api/ops → server.metrics.eventLoopLagP95Ms · monitorEventLoopDelay" />
          <strong>{formatNumber(server?.metrics.eventLoopLagP95Ms ?? 0, 1)}<em>ms</em></strong>
          <small>Node.js 런타임 지연</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="활성 경기장" description="현재 상태가 running인 방의 수다." source="/api/ops → rooms[].status" />
          <strong>{activeRooms}</strong>
          <small>전체 경기장 {snapshot?.rooms.length ?? 0}개</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="상태 크기 P95" description="최근 Snapshot 또는 Delta JSON payload 크기의 95백분위다." source="/api/ops → server.metrics.statePayloadBytes · Buffer.byteLength" />
          <strong>{formatNumber(server?.metrics.statePayloadBytes ?? 0)}<em>B</em></strong>
          <small>{server?.identity.version ?? "—"} · {server?.identity.cluster ?? "—"}</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="재접속 누적" description="서버 시작 이후 같은 세션으로 복구된 Socket.IO 재접속 누적 횟수다." source="/api/ops → server.reconnects · resume_session" />
          <strong>{formatNumber(server?.reconnects ?? 0)}</strong>
          <small>동일 세션 복구 성공</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="연결 끊김 누적" description="서버 시작 이후 관측한 모든 Socket.IO disconnect 이벤트 누적 횟수다." source="/api/ops → server.disconnects · socket.on('disconnect')" />
          <strong>{formatNumber(server?.disconnects ?? 0)}</strong>
          <small>플레이어·관전자·관리자 포함</small>
        </article>
        <article className="ops-metric">
          <MetricLabel label="서버 가동 시간" description="현재 game-api 프로세스가 시작된 이후 경과한 시간이다. Pod가 재시작되면 다시 0부터 센다." source="/api/ops → server.uptimeSeconds · process.uptime()" />
          <strong className="ops-uptime-value">{formatUptime(server?.uptimeSeconds ?? 0)}</strong>
          <small>현재 프로세스 기준</small>
        </article>
      </section>

      <div className="ops-main-grid">
        <section className="panel room-telemetry-panel">
          <div className="panel-heading"><div><span className="panel-kicker">게임 상태</span><h2>경기장 현황</h2></div><span className="actual-tag">실제 데이터</span></div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead><tr><th>경기장</th><th>상태</th><th>참가자</th><th>팀 A</th><th>팀 B</th><th>남은 시간</th></tr></thead>
              <tbody>
                {snapshot?.rooms.length === 0 && <tr><td colSpan={6} className="empty-cell">방이 생성되면 실제 상태가 표시됩니다.</td></tr>}
                {snapshot?.rooms.map((room) => (
                  <tr key={room.roomCode}>
                    <td><b>{room.roomCode}</b></td>
                    <td><StatusPill status={room.status} locale="ko" /></td>
                    <td>{room.connectedPlayers}<small> / {room.players}</small></td>
                    <td className="team-a-text">{room.teamPlayers.A} <small>· {room.scores.A} cells</small></td>
                    <td className="team-b-text">{room.teamPlayers.B} <small>· {room.scores.B} cells</small></td>
                    <td>{Math.ceil(room.remainingMs / 1000)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel infra-panel">
          <div className="panel-heading"><div><span className="panel-kicker">런타임 인프라</span><h2>{infrastructure?.mode === "kubernetes" ? "Kubernetes" : "로컬 런타임"}</h2></div><span className={infrastructure?.available ? "actual-tag" : "warning-tag"}>{infrastructure?.available ? "실제 데이터" : "사용 불가"}</span></div>
          <p className="infra-message">{infrastructure?.message ?? "인프라 상태를 확인하는 중입니다."}</p>
          <div className="infra-summary">
            <div><span>버전</span><strong>{infrastructure?.appVersion ?? "—"}</strong></div>
            <div><span>이미지 태그</span><strong>{infrastructure?.imageTag ?? "—"}</strong></div>
            <div><span>레플리카</span><strong>{infrastructure?.readyReplicas ?? "—"} / {infrastructure?.desiredReplicas ?? "—"}</strong></div>
          </div>
          {infrastructure?.mode === "local" && <div className="local-runtime-note"><i />Pod, restart, CPU, memory는 Kubernetes 안에서 실행할 때만 Kubernetes API의 실제 값으로 표시됩니다.</div>}
          {infrastructure && infrastructure.pods.length > 0 && <div className="pod-list">
            {infrastructure.pods.map((pod) => <article key={pod.name}>
              <div><span className={`pod-state ${pod.ready ? "pod-ready" : "pod-not-ready"}`}><i />{pod.phase}</span><b>{pod.name}</b></div>
              <dl><div><dt>재시작</dt><dd>{pod.restarts}</dd></div><div><dt>CPU</dt><dd>{pod.cpu ?? "N/A"}</dd></div><div><dt>메모리</dt><dd>{pod.memory ?? "N/A"}</dd></div></dl>
              <small>{pod.image ?? "이미지 정보 없음"}</small>
            </article>)}
          </div>}
        </section>
      </div>

      <div className="ops-lower-grid">
        <section className="panel simulation-panel">
          <div className="simulation-heading">
            <div><span className="simulation-tag">실제 장애 주입</span><h2>메모리 누수 → OOMKilled</h2><p>애플리케이션 메모리를 실제로 점유하고 Kubernetes의 종료·재시작 상태만 표시합니다.</p></div>
            <span className={`fault-phase phase-${fault?.phase ?? "idle"}`}>{faultPhaseLabels[fault?.phase ?? "idle"]}</span>
          </div>
          <div className="simulation-grid">
            <button type="button" disabled={busy || fault?.phase === "allocating" || fault?.phase === "restarting"} className={`simulation-card phase-${fault?.phase ?? "idle"}`} onClick={() => { if (window.confirm("이 게임 서버 Pod에 실제 메모리 누수를 시작합니다. Kubernetes가 OOMKilled로 종료하고 자동 재시작하는 과정까지 관측할까요?")) void triggerMemoryOom(); }}>
              <span className="sim-icon">!</span><div><b>실제 OOMKilled 시작</b><p>{fault?.message ?? "실제 메모리 할당 전입니다."}</p></div><strong>{fault?.phase === "allocating" ? `${fault.allocatedMiB.toFixed(0)} MiB 할당` : fault?.lastTerminationReason ?? "대기"}</strong>
            </button>
          </div>
          <div className="fault-observation-grid"><div><span>대상 Pod</span><b>{fault?.targetPod ?? "—"}</b></div><div><span>재시작 횟수</span><b>{fault?.restartCount ?? "—"}</b></div><div><span>마지막 종료</span><b>{fault?.lastTerminationReason ?? "—"}</b></div><div><span>관측 시각</span><b>{fault ? formatTime(fault.observedAt) : "—"}</b></div></div>
          <div className="simulation-disclaimer"><b>실측 경계</b><span>완료는 API 응답이 아니라 Kubernetes Pod의 <code>lastState.terminated.reason=OOMKilled</code>와 Ready 복귀로 판정합니다.</span></div>
        </section>

        <section className="panel ops-event-panel">
          <div className="panel-heading"><div><span className="panel-kicker">감사 로그</span><h2>최근 이벤트</h2></div><span className="count-badge">{snapshot?.recentEvents.length ?? 0}</span></div>
          <ol className="event-list compact-events">
            {snapshot?.recentEvents.slice(0, 16).map((event) => <li key={event.id}>
              <time>{formatTime(event.at)}</time><span className={`event-dot source-${event.source}`} /><div><b>{event.type}</b><p>{event.roomCode ? `[${event.roomCode}] ` : ""}{event.message}</p></div>
            </li>)}
          </ol>
        </section>
      </div>
    </AppShell>
  );
};
