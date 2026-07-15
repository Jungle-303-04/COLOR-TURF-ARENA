import { useEffect, useState } from "react";
import type { OpsSnapshot } from "@paint-arena/shared";
import { AppShell } from "../components/AppShell";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { formatNumber, formatTime } from "../lib/format";
import { createSocket } from "../lib/socket";

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
      eyebrow="OBSERVABILITY / REAL-TIME OPERATIONS"
      title="Live Operations"
      actions={<span className={`live-chip ${socketLive ? "" : "is-offline"}`}><i />{socketLive ? "STREAMING" : "RECONNECTING"}</span>}
    >
      {error && <div className="notice-bar notice-error">{error}</div>}
      <div className="ops-banner">
        <div><span className="actual-tag">ACTUAL TELEMETRY</span><p>서버·게임·Socket 수치는 실제 런타임 상태에서 계산됩니다.</p></div>
        <time>{snapshot ? `OBSERVED ${formatTime(snapshot.observedAt)}` : "CONNECTING…"}</time>
      </div>

      <section className="ops-metric-grid">
        <article className="ops-metric"><span>SERVER HEALTH</span><strong className="healthy-text"><i />{server?.health.toUpperCase() ?? "—"}</strong><small>ready: {server?.ready ? "true" : "—"}</small></article>
        <article className="ops-metric"><span>SOCKET CONNECTIONS</span><strong>{server?.connectedSockets ?? 0}</strong><small>{totalPlayers} player controllers</small></article>
        <article className="ops-metric"><span>INPUT EVENTS / SEC</span><strong>{server?.inputEventsPerSecond ?? 0}</strong><small>{formatNumber(server?.totalInputEvents ?? 0)} total</small></article>
        <article className="ops-metric"><span>TICK P95</span><strong>{formatNumber(server?.metrics.tickP95Ms ?? 0, 1)}<em>ms</em></strong><small>{server?.identity.broadcastMode ?? "—"} broadcast</small></article>
        <article className="ops-metric"><span>ACTIVE ROOMS</span><strong>{activeRooms}</strong><small>{snapshot?.rooms.length ?? 0} rooms total</small></article>
        <article className="ops-metric"><span>PAYLOAD P95</span><strong>{formatNumber(server?.metrics.statePayloadBytes ?? 0)}<em>B</em></strong><small>{server?.identity.version ?? "—"} · {server?.identity.cluster ?? "—"}</small></article>
      </section>

      <div className="ops-main-grid">
        <section className="panel room-telemetry-panel">
          <div className="panel-heading"><div><span className="panel-kicker">GAME STATE</span><h2>Room telemetry</h2></div><span className="actual-tag">ACTUAL</span></div>
          <div className="table-wrap">
            <table className="ops-table">
              <thead><tr><th>ROOM</th><th>STATE</th><th>PLAYERS</th><th>TEAM A</th><th>TEAM B</th><th>TIME</th></tr></thead>
              <tbody>
                {snapshot?.rooms.length === 0 && <tr><td colSpan={6} className="empty-cell">방이 생성되면 실제 상태가 표시됩니다.</td></tr>}
                {snapshot?.rooms.map((room) => (
                  <tr key={room.roomCode}>
                    <td><b>{room.roomCode}</b></td>
                    <td><StatusPill status={room.status} /></td>
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
          <div className="panel-heading"><div><span className="panel-kicker">RUNTIME INFRASTRUCTURE</span><h2>{infrastructure?.mode === "kubernetes" ? "Kubernetes" : "Local runtime"}</h2></div><span className={infrastructure?.available ? "actual-tag" : "warning-tag"}>{infrastructure?.available ? "ACTUAL" : "UNAVAILABLE"}</span></div>
          <p className="infra-message">{infrastructure?.message ?? "인프라 상태를 확인하는 중입니다."}</p>
          <div className="infra-summary">
            <div><span>VERSION</span><strong>{infrastructure?.appVersion ?? "—"}</strong></div>
            <div><span>IMAGE TAG</span><strong>{infrastructure?.imageTag ?? "—"}</strong></div>
            <div><span>REPLICAS</span><strong>{infrastructure?.readyReplicas ?? "—"} / {infrastructure?.desiredReplicas ?? "—"}</strong></div>
          </div>
          {infrastructure?.mode === "local" && <div className="local-runtime-note"><i />Pod, restart, CPU, memory는 Kubernetes 안에서 실행할 때만 Kubernetes API의 실제 값으로 표시됩니다.</div>}
          {infrastructure && infrastructure.pods.length > 0 && <div className="pod-list">
            {infrastructure.pods.map((pod) => <article key={pod.name}>
              <div><span className={`pod-state ${pod.ready ? "pod-ready" : "pod-not-ready"}`}><i />{pod.phase}</span><b>{pod.name}</b></div>
              <dl><div><dt>RESTARTS</dt><dd>{pod.restarts}</dd></div><div><dt>CPU</dt><dd>{pod.cpu ?? "N/A"}</dd></div><div><dt>MEM</dt><dd>{pod.memory ?? "N/A"}</dd></div></dl>
              <small>{pod.image ?? "image unknown"}</small>
            </article>)}
          </div>}
        </section>
      </div>

      <div className="ops-lower-grid">
        <section className="panel simulation-panel">
          <div className="simulation-heading">
            <div><span className="simulation-tag">실제 장애 주입</span><h2>메모리 누수 → OOMKilled</h2><p>애플리케이션 메모리를 실제로 점유하고 Kubernetes의 종료·재시작 상태만 표시합니다.</p></div>
            <span className={`fault-phase phase-${fault?.phase ?? "idle"}`}>{fault?.phase ?? "idle"}</span>
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
          <div className="panel-heading"><div><span className="panel-kicker">AUDIT TRAIL</span><h2>Event feed</h2></div><span className="count-badge">{snapshot?.recentEvents.length ?? 0}</span></div>
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
