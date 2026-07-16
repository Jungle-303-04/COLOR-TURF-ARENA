import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { EventLogEntry, RoomSnapshot, StateDelta, TeamId, WatchResult } from "@paint-arena/shared";
import { BrandMark } from "../components/AppShell";
import { QrCode } from "../components/QrCode";
import { StatusPill } from "../components/StatusPill";
import { ArenaCanvasRenderer, selectWorldLabelPlayers } from "../game/arenaCanvas";
import { api } from "../lib/api";
import { formatTime, formatTimer } from "../lib/format";
import { startRenderTelemetry } from "../lib/renderTelemetry";
import { isRoomRecoveryPending, retryWithBackoff, ROOM_RECOVERY_ACK_TIMEOUT_MS, ROOM_RECOVERY_RETRY_POLICY } from "../lib/retry";
import { createSocket } from "../lib/socket";
import { applyStateDelta } from "../lib/state";

export const ScreenPage = () => {
  const { roomCode: rawCode = "" } = useParams();
  const roomCode = rawCode.toUpperCase();
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [tickRateHz, setTickRateHz] = useState(30);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState<EventLogEntry[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const socketRef = useRef<ReturnType<typeof createSocket> | null>(null);

  useEffect(() => startRenderTelemetry(() => socketRef.current), []);

  useEffect(() => {
    void api.config().then((config) => { setBaseUrl(config.publicBaseUrl); setTickRateHz(config.tickRateHz); }).catch(() => undefined);
    let disposed = false;
    let socket: ReturnType<typeof createSocket> | null = null;
    let watchAttempt: AbortController | null = null;

    const watch = () => {
      watchAttempt?.abort();
      const controller = new AbortController();
      watchAttempt = controller;
      setConnected(false);
      setError("");
      void retryWithBackoff<WatchResult>(
        async () => {
          if (!socket?.connected) throw new Error("Socket disconnected during room recovery");
          return await socket.timeout(ROOM_RECOVERY_ACK_TIMEOUT_MS).emitWithAck("spectator_subscribe", { roomCode }) as WatchResult;
        },
        {
          ...ROOM_RECOVERY_RETRY_POLICY,
          signal: controller.signal,
          shouldRetry: (result) => !result.ok && isRoomRecoveryPending(result.error),
        },
      ).then((outcome) => {
        if (controller.signal.aborted || watchAttempt !== controller || outcome.status === "aborted") return;
        watchAttempt = null;
        const result = outcome.status === "complete" || outcome.status === "exhausted" ? outcome.value : undefined;
        if (result?.ok && result.snapshot) {
          setSnapshot(result.snapshot);
          setConnected(true);
          setError("");
          return;
        }
        setConnected(false);
        setError(result?.error ?? "게임 서버가 방 상태를 복구하지 못했습니다.");
      });
    };

    const connect = async () => {
      let socketPath = "/socket.io";
      try {
        socketPath = (await api.roomConnection(roomCode)).socketPath;
      } catch {
        // Stable remains a valid coordination gateway during a short routing
        // lookup outage, so keep the spectator reconnect path available.
      }
      if (disposed) return;

      socket = createSocket(socketPath);
      socketRef.current = socket;
      socket.on("connect", watch);
      socket.on("disconnect", () => {
        watchAttempt?.abort();
        watchAttempt = null;
        setConnected(false);
      });
      socket.on("room_snapshot", (next: RoomSnapshot) => setSnapshot((current) => !current || next.sequence >= current.sequence ? next : current));
      socket.on("state_delta", (delta: StateDelta) => setSnapshot((current) => applyStateDelta(current, delta)));
      socket.on("ops_event", (event: EventLogEntry) => setTimeline((current) => [event, ...current.filter((item) => item.id !== event.id)].slice(0, 8)));
      socket.connect();
    };

    void connect();
    void api.ops().then((ops) => setTimeline(ops.recentEvents.slice(0, 8))).catch(() => undefined);
    return () => {
      disposed = true;
      watchAttempt?.abort();
      watchAttempt = null;
      socket?.disconnect();
      socketRef.current = null;
    };
  }, [roomCode]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(canvasRef.current, { showPlayerLabels: true, maxPlayerLabels: 24 });
    rendererRef.current = renderer;
    if (snapshot) renderer.update(snapshot);
    return () => { renderer.destroy(); rendererRef.current = null; };
  }, [Boolean(snapshot)]);

  useEffect(() => { if (snapshot) rendererRef.current?.update(snapshot); }, [snapshot]);

  const counts = useMemo(() => {
    const result: Record<TeamId, number> = { A: 0, B: 0 };
    snapshot?.players.forEach((player) => { result[player.team] += 1; });
    return result;
  }, [snapshot]);

  const joinUrl = `${baseUrl}/play/${roomCode}`;
  const winnerName = snapshot?.winner && snapshot.winner !== "draw" ? snapshot.config.teams[snapshot.winner].name : null;
  const humans = snapshot?.players.filter((player) => !player.isBot).length ?? 0;
  const bots = snapshot?.players.filter((player) => player.isBot).length ?? 0;
  const degraded = snapshot?.server.broadcastMode === "full";
  const rosterPlayers = useMemo(() => selectWorldLabelPlayers(snapshot?.players ?? [], 8), [snapshot]);

  return (
    <div className="screen-page">
      <header className="screen-header">
        <BrandMark />
        <div className="screen-room-id"><span>ROOM</span><strong>{roomCode || "-----"}</strong></div>
        <div className="screen-health">
          {degraded && <span className="degraded-chip">DEGRADED · FULL BROADCAST</span>}
          <span className={connected ? "is-connected" : "is-disconnected"}><i />{connected ? "LIVE SYNC" : "RECONNECTING"}</span>
          <button type="button" className="fullscreen-button" onClick={() => void document.documentElement.requestFullscreen?.()}>FULLSCREEN</button>
        </div>
      </header>

      {error && <div className="screen-error"><p className="eyebrow">ARENA UNAVAILABLE</p><h1>{error}</h1><p>운영자 콘솔에서 방 코드를 확인하세요.</p></div>}

      {snapshot && <>
        <section className="score-ribbon">
          <div className="team-score team-score-a" style={{ "--team-color": snapshot.config.teams.A.color } as React.CSSProperties}>
            <div><span>RED · {snapshot.config.teams.A.name}</span><strong>{snapshot.scores.cells.A}</strong></div><b>{snapshot.scores.percentage.A.toFixed(1)}%</b>
          </div>
          <div className="match-clock"><StatusPill status={snapshot.status} /><strong>{formatTimer(snapshot.remainingMs)}</strong><span>{humans} HUMANS · {bots} BOTS</span></div>
          <div className="team-score team-score-b" style={{ "--team-color": snapshot.config.teams.B.color } as React.CSSProperties}>
            <b>{snapshot.scores.percentage.B.toFixed(1)}%</b><div><span>BLUE · {snapshot.config.teams.B.name}</span><strong>{snapshot.scores.cells.B}</strong></div>
          </div>
        </section>

        <main className="arena-stage watch-arena-stage">
          <canvas ref={canvasRef} className="arena-canvas" aria-label="서버 상태로 렌더링한 Color Turf Arena" />
          <div className="arena-vignette" />

          {snapshot.status === "lobby" && <div className="lobby-overlay">
            <div className="lobby-copy"><p className="eyebrow">READY FOR PLAYERS</p><h1>SCAN. JOIN.<br /><span>PAINT THE TURF.</span></h1><p>휴대폰으로 QR을 스캔하면 인원이 적은 팀에 자동 배정됩니다.</p><div className="lobby-teams"><span style={{ color: snapshot.config.teams.A.color }}><i /> RED <b>{counts.A}</b></span><span style={{ color: snapshot.config.teams.B.color }}><i /> BLUE <b>{counts.B}</b></span></div></div>
            <div className="big-qr-card"><QrCode value={joinUrl} label={`방 ${roomCode} 모바일 입장`} size={260} /><span>ROOM CODE</span><strong>{roomCode}</strong><p>{joinUrl}</p></div>
          </div>}

          {snapshot.status === "paused" && <div className="state-overlay pause-overlay"><span>GAME PAUSED</span><h1>잠시 멈춤</h1><p>운영자가 곧 경기를 재개합니다.</p></div>}
          {snapshot.status === "ended" && <div className="state-overlay result-overlay"><p className="eyebrow">MATCH COMPLETE</p><h1 style={{ color: snapshot.winner === "draw" || !snapshot.winner ? "#ffffff" : snapshot.config.teams[snapshot.winner].color }}>{snapshot.winner === "draw" ? "DRAW" : `${winnerName} WINS`}</h1><div className="result-score"><div><span>RED</span><strong>{snapshot.scores.cells.A}</strong><small>{snapshot.scores.percentage.A.toFixed(1)}%</small></div><b>FINAL</b><div><span>BLUE</span><strong>{snapshot.scores.cells.B}</strong><small>{snapshot.scores.percentage.B.toFixed(1)}%</small></div></div><p>{humans}명 참가 · {bots} bots · {snapshot.scores.paintedCells} cells painted</p></div>}

          {snapshot.activeEvents.some((event) => event.type === "paint-boost") && <div className="watch-event-toast"><b>PAINT BOOST ×2</b><span>모든 플레이어 Paint 반경 증가</span></div>}
          {snapshot.announcement && <div className="watch-announcement">{snapshot.announcement}</div>}

          <aside className="watch-timeline"><span>LIVE OPERATIONS</span>{timeline.slice(0, 5).map((event) => <article key={event.id}><time>{formatTime(event.at)}</time><div><b>{event.type}</b><p>{event.message}</p></div></article>)}</aside>
          {snapshot.status !== "lobby" && <aside className="watch-player-roster" aria-label="실시간 참가자 닉네임">
            <span>실시간 참가자</span>
            <div role="list">{rosterPlayers.map((player) => <div role="listitem" className={player.connected ? "" : "is-disconnected"} key={player.id}>
              <i style={{ backgroundColor: snapshot.config.teams[player.team].color }} />
              <b>{player.nickname}</b>
              <small>{player.isBot ? "봇" : "참가자"} · {player.team === "A" ? "빨강" : "파랑"}</small>
            </div>)}</div>
            {snapshot.players.length > rosterPlayers.length && <em>외 {snapshot.players.length - rosterPlayers.length}명</em>}
          </aside>}
          <div className="arena-corner-label"><span>{snapshot.server.cluster.toUpperCase()} · {snapshot.server.releaseChannel.toUpperCase()}</span><b>{snapshot.server.version}</b></div>
        </main>

        <footer className="screen-footer"><span><i className="legend-dot" style={{ background: snapshot.config.teams.A.color }} />SERVER AUTHORITATIVE · {tickRateHz}Hz</span><span>{snapshot.server.cluster.toUpperCase()} · {snapshot.server.releaseChannel.toUpperCase()} · {snapshot.server.broadcastMode.toUpperCase()}</span><span><i className="legend-dot" style={{ background: snapshot.config.teams.B.color }} />SEQUENCE {snapshot.sequence}</span></footer>
      </>}
    </div>
  );
};
