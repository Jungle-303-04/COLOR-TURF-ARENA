import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useParams } from "react-router-dom";
import type { InputPayload, InputResult, JoinResult, PlayerPublic, RoomSnapshot, StateDelta, Vector2 } from "@paint-arena/shared";
import { BrandMark } from "../components/AppShell";
import { ArenaCanvasRenderer } from "../game/arenaCanvas";
import { createClientSessionId } from "../lib/clientId";
import { formatTimer } from "../lib/format";
import { createSocket } from "../lib/socket";
import { applyStateDelta } from "../lib/state";

interface StoredSession {
  sessionId: string;
  nickname: string;
  playerId?: string;
  team?: "A" | "B";
  lastReceivedSequence: number;
}

const sessionKey = (roomCode: string) => `color-turf-session:${roomCode}`;

const loadSession = (roomCode: string): StoredSession => {
  try {
    const raw = localStorage.getItem(sessionKey(roomCode));
    if (raw) return JSON.parse(raw) as StoredSession;
  } catch {
    // A corrupt local demo session is replaced below.
  }
  return { sessionId: createClientSessionId(), nickname: "", lastReceivedSequence: 0 };
};

export const JoinPage = () => {
  const { roomCode: rawCode = "" } = useParams();
  const roomCode = rawCode.toUpperCase();
  const storedRef = useRef(loadSession(roomCode));
  const [nickname, setNickname] = useState(storedRef.current.nickname);
  const [hasJoined, setHasJoined] = useState(Boolean(storedRef.current.nickname));
  const [player, setPlayer] = useState<PlayerPublic | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connection, setConnection] = useState<"connecting" | "restoring" | "connected" | "offline">("connecting");
  const [message, setMessage] = useState("닉네임을 입력하고 Arena에 입장하세요.");
  const [rtt, setRtt] = useState(0);
  const [stick, setStick] = useState<Vector2>({ x: 0, y: 0 });
  const socketRef = useRef<ReturnType<typeof createSocket> | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const minimapRendererRef = useRef<ArenaCanvasRenderer | null>(null);
  const sequenceRef = useRef(storedRef.current.lastReceivedSequence);
  const joinedRef = useRef(hasJoined);
  const nicknameRef = useRef(nickname);
  const vectorRef = useRef<Vector2>({ x: 0, y: 0 });
  const inputTimerRef = useRef<number | null>(null);

  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);
  useEffect(() => { joinedRef.current = hasJoined; }, [hasJoined]);

  const saveSession = useCallback((patch: Partial<StoredSession>) => {
    storedRef.current = { ...storedRef.current, ...patch };
    try { localStorage.setItem(sessionKey(roomCode), JSON.stringify(storedRef.current)); }
    catch { /* Session remains available in memory when browser storage is restricted. */ }
  }, [roomCode]);

  const join = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !joinedRef.current) return;
    setConnection(storedRef.current.playerId ? "restoring" : "connecting");
    socket.emit(storedRef.current.playerId ? "resume_session" : "join_room", {
      roomCode,
      sessionId: storedRef.current.sessionId,
      nickname: nicknameRef.current,
    }, (result: JoinResult) => {
      if (!result.ok || !result.player || !result.snapshot) {
        setMessage(result.error ?? "입장하지 못했습니다.");
        setConnection("offline");
        return;
      }
      setPlayer(result.player);
      setSnapshot(result.snapshot);
      setConnection("connected");
      sequenceRef.current = Math.max(sequenceRef.current, result.snapshot.sequence);
      saveSession({
        nickname: result.player.nickname,
        playerId: result.player.id,
        team: result.player.team,
        lastReceivedSequence: result.snapshot.sequence,
      });
      setMessage(result.reconnected ? "최근 Snapshot부터 같은 팀으로 복구했습니다." : `TEAM ${result.player.team} 배정 완료`);
    });
  }, [roomCode, saveSession]);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnection(joinedRef.current ? "restoring" : "connected");
      join();
    });
    socket.on("disconnect", (reason) => {
      setConnection("offline");
      if (joinedRef.current) setMessage("최근 게임 상태를 복구하고 있습니다.");
      if (reason === "io server disconnect") window.setTimeout(() => socket.connect(), 500);
    });
    socket.on("connect_error", () => setConnection("offline"));
    socket.on("join_accepted", (assigned: PlayerPublic) => setPlayer(assigned));
    socket.on("room_snapshot", (next: RoomSnapshot) => {
      setSnapshot((current) => !current || next.sequence >= current.sequence ? next : current);
      setPlayer(next.players.find((candidate) => candidate.id === storedRef.current.sessionId) ?? null);
      sequenceRef.current = Math.max(sequenceRef.current, next.sequence);
      saveSession({ lastReceivedSequence: next.sequence });
    });
    socket.on("state_delta", (delta: StateDelta) => {
      setSnapshot((current) => applyStateDelta(current, delta));
      const me = delta.players.find((candidate) => candidate.id === storedRef.current.sessionId);
      if (me) setPlayer(me);
      sequenceRef.current = Math.max(sequenceRef.current, delta.sequence);
      saveSession({ lastReceivedSequence: delta.sequence });
    });
    socket.connect();
    const pingTimer = window.setInterval(() => {
      if (!socket.connected) return;
      const sentAt = Date.now();
      socket.emit("client_ping", { sentAt }, () => setRtt(Date.now() - sentAt));
    }, 2000);
    return () => {
      if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
      window.clearInterval(pingTimer);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [join, saveSession]);

  useEffect(() => {
    if (!canvasRef.current || !minimapCanvasRef.current) return;
    const renderer = new ArenaCanvasRenderer(canvasRef.current, { mode: "follow", viewportWidthCells: 96, viewportHeightCells: 54 });
    const minimapRenderer = new ArenaCanvasRenderer(minimapCanvasRef.current, { mode: "minimap", viewportWidthCells: 96, viewportHeightCells: 54 });
    rendererRef.current = renderer;
    minimapRendererRef.current = minimapRenderer;
    if (snapshot) {
      renderer.update(snapshot, player?.id);
      minimapRenderer.update(snapshot, player?.id);
    }
    return () => {
      renderer.destroy();
      minimapRenderer.destroy();
      rendererRef.current = null;
      minimapRendererRef.current = null;
    };
  }, [Boolean(snapshot)]);

  useEffect(() => {
    if (snapshot) {
      rendererRef.current?.update(snapshot, player?.id);
      minimapRendererRef.current?.update(snapshot, player?.id);
    }
  }, [snapshot, player?.id]);

  const submitNickname = () => {
    const clean = nickname.trim();
    if (!clean) { setMessage("닉네임을 입력해 주세요."); return; }
    saveSession({ nickname: clean });
    nicknameRef.current = clean;
    joinedRef.current = true;
    setHasJoined(true);
    join();
  };

  const sendInput = useCallback((direction: Vector2) => {
    const socket = socketRef.current;
    if (!socket?.connected || snapshotRef.current?.status !== "running") return;
    sequenceRef.current += 1;
    const payload: InputPayload = {
      roomCode,
      sessionId: storedRef.current.sessionId,
      sequence: sequenceRef.current,
      sentAt: Date.now(),
      direction,
    };
    socket.emit("player_input", payload, (result: InputResult) => {
      if (!result.ok && result.reason === "rate-limited") setMessage("입력 속도를 서버가 제한했습니다.");
    });
  }, [roomCode]);

  const updateJoystick = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.36;
    const rawX = event.clientX - (rect.left + rect.width / 2);
    const rawY = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(rawX, rawY);
    const scale = distance > radius ? radius / distance : 1;
    const next = { x: (rawX * scale) / radius, y: (rawY * scale) / radius };
    vectorRef.current = next;
    setStick(next);
  };

  const startJoystick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (snapshot?.status !== "running" || connection !== "connected") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateJoystick(event);
    sendInput(vectorRef.current);
    if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
    inputTimerRef.current = window.setInterval(() => sendInput(vectorRef.current), 100);
  };

  const stopJoystick = () => {
    if (inputTimerRef.current) window.clearInterval(inputTimerRef.current);
    inputTimerRef.current = null;
    vectorRef.current = { x: 0, y: 0 };
    setStick({ x: 0, y: 0 });
    sendInput({ x: 0, y: 0 });
  };

  const team = player && snapshot ? snapshot.config.teams[player.team] : null;
  const otherTeam = player?.team === "A" ? "B" : "A";
  const reconnecting = hasJoined && connection !== "connected";

  return (
    <div className="controller-page" style={{ "--player-team": team?.color ?? "#ffffff", "--player-team-soft": team?.softColor ?? "#272733" } as React.CSSProperties}>
      <header className="controller-header">
        <BrandMark />
        <span className={`connection-chip connection-${connection}`}><i />{connection === "connected" ? "CONNECTED" : connection === "restoring" ? "RESTORING" : "RECONNECTING"}</span>
      </header>

      {!hasJoined && <main className="mobile-join-gate">
        <p className="eyebrow">ROOM {roomCode}</p>
        <h1>Color Turf Arena</h1>
        <p>닉네임을 입력하면 인원이 적은 팀에 자동 배정됩니다.</p>
        <label><span>NICKNAME</span><input autoFocus maxLength={24} value={nickname} onChange={(event) => setNickname(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitNickname(); }} placeholder="예: Jungle-01" /></label>
        <button type="button" className="button button-primary button-block" onClick={submitNickname}>JOIN ARENA</button>
        <div className="controller-message" role="status"><i /><span>{message}</span></div>
      </main>}

      {hasJoined && <main className="controller-main play-controller-main">
        <section className="mobile-arena-wrap mobile-camera-stage">
          <canvas ref={canvasRef} className="mobile-arena-canvas" aria-label="내 캐릭터를 따라가는 제한 시야 게임 화면" />
          <div className="mobile-arena-hud">
            <div className="hud-team"><i>{player?.team ?? "?"}</i><span><small>MY TEAM</small><b>{team?.name ?? "RESTORING"}</b><em>{player?.nickname ?? nickname}</em></span></div>
            <div className="hud-clock"><small>{snapshot?.status.toUpperCase() ?? "CONNECT"}</small><b>{formatTimer(snapshot?.remainingMs ?? 0)}</b></div>
            <div className="hud-ratio"><span><small>MY</small><b>{player && snapshot ? snapshot.scores.percentage[player.team].toFixed(1) : "0.0"}%</b></span><i>VS</i><span><small>RIVAL</small><b>{snapshot ? snapshot.scores.percentage[otherTeam].toFixed(1) : "0.0"}%</b></span></div>
          </div>
          <div className="player-minimap"><div><span>MINIMAP</span><b>{player && snapshot ? `${Math.round(player.position.x)}, ${Math.round(player.position.y)}` : "LOCATING"}</b></div><canvas ref={minimapCanvasRef} aria-label="전체 월드에서 내 위치를 보여주는 미니맵" /></div>
          {snapshot?.activeEvents.some((event) => event.type === "paint-boost") && <div className="boost-chip">PAINT BOOST ×2</div>}
          {snapshot?.announcement && <div className="arena-announcement">{snapshot.announcement}</div>}
        </section>

        <div className={`controller-message state-${snapshot?.status ?? "loading"}`} role="status"><i /><span>{snapshot?.status === "lobby" ? "운영자가 게임을 시작할 때까지 기다려 주세요." : snapshot?.status === "paused" ? "게임이 일시정지되었습니다." : snapshot?.status === "ended" ? "경기 종료 — 관전 화면에서 결과를 확인하세요." : message}</span></div>

        <section className="joystick-section" aria-label="플레이어 이동 조이스틱">
          <div className="virtual-joystick" onPointerDown={startJoystick} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateJoystick(event); }} onPointerUp={stopJoystick} onPointerCancel={stopJoystick}>
            <span className="joystick-ring" />
            <span className="joystick-knob" style={{ transform: `translate(calc(-50% + ${stick.x * 58}px), calc(-50% + ${stick.y * 58}px))` }} />
          </div>
          <div className="joystick-copy"><b>MOVE & PAINT</b><span>확대된 시야가 내 캐릭터를 따라갑니다. 미니맵의 흰 박스가 현재 보이는 구역입니다.</span><div className="joystick-live-info"><span><small>TEAM</small><b>{player?.team ?? "—"}</b></span><span><small>WORLD</small><b>{snapshot ? `${snapshot.config.gridWidth}×${snapshot.config.gridHeight}` : "—"}</b></span><span><small>ROOM</small><b>{roomCode}</b></span></div></div>
        </section>

        <div className="mobile-server-strip"><span>PING {rtt}ms</span><span>{snapshot?.server.version ?? "—"}</span><span>{snapshot?.server.cluster.toUpperCase() ?? "—"}</span><span>{snapshot?.server.releaseChannel.toUpperCase() ?? "—"}</span></div>
      </main>}

      {reconnecting && <div className="reconnect-overlay"><div className="reconnect-spinner" /><h2>서버에 다시 연결하는 중입니다.</h2><p>최근 게임 상태를 복구하고 있습니다.</p></div>}
    </div>
  );
};
