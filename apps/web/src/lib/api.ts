import type {
  ClusterName,
  DemoChaosActionResponse,
  OpsSnapshot,
  PublicConfig,
  ReleaseChannel,
  RoomSnapshot,
  RoomSummary,
  SystemStatus,
} from "@paint-arena/shared";

const ADMIN_TOKEN_KEY = "color-turf-admin-token";

export const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
export const setAdminToken = (token: string) => localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
export const clearAdminToken = () => localStorage.removeItem(ADMIN_TOKEN_KEY);

const requestJson = async <T>(path: string, init?: RequestInit, admin = false): Promise<T> => {
  const token = admin ? getAdminToken() : "";
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
};

const releaseChannelPath = (path: string, releaseChannel: ReleaseChannel) => `${path}?releaseChannel=${releaseChannel}`;

const opsPath = (releaseChannel?: ReleaseChannel, roomCode?: string) => {
  const search = new URLSearchParams();
  if (releaseChannel) search.set("releaseChannel", releaseChannel);
  if (roomCode) search.set("roomCode", roomCode);
  const query = search.toString();
  return `/api/ops${query ? `?${query}` : ""}`;
};

export const api = {
  config: () => requestJson<PublicConfig>("/api/config"),
  verifyAdmin: () => requestJson<{ ok: boolean }>("/api/admin/session", undefined, true),
  listRooms: () => requestJson<{ rooms: RoomSummary[] }>("/api/rooms"),
  getRoom: (roomCode: string) => requestJson<{ room: RoomSnapshot }>(`/api/rooms/${roomCode}`),
  roomConnection: (roomCode: string) => requestJson<{
    roomId: string;
    releaseChannel: "stable" | "canary";
    socketPath: string;
    sessionId: string;
  }>(`/api/rooms/${roomCode}/join`, { method: "POST" }),
  systemStatus: () => requestJson<SystemStatus>("/api/system/status"),
  createRoom: (settings: {
    durationSeconds: number;
    gridWidth: number;
    gridHeight: number;
    paintRadius: number;
    releaseChannel: "stable" | "canary";
    teams: { A: { color: string }; B: { color: string } };
  }) => requestJson<{ room: RoomSnapshot; joinUrl: string; screenUrl: string; socketPath: string }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(settings),
  }, true),
  updateRoom: (roomCode: string, settings: Record<string, unknown>) => requestJson<{ room: RoomSnapshot }>(`/api/rooms/${roomCode}`, {
    method: "PATCH",
    body: JSON.stringify(settings),
  }, true),
  roomAction: (roomCode: string, action: "start" | "pause" | "resume" | "end" | "reset" | "reassign") => {
    const endpoint = action === "end" ? "stop" : action;
    return requestJson<{ room: RoomSnapshot }>(`/api/admin/rooms/${roomCode}/${endpoint}`, { method: "POST" }, true);
  },
  paintBoost: (roomCode: string, durationMs = 10_000) => requestJson<{ room: RoomSnapshot }>(`/api/admin/rooms/${roomCode}/events/paint-boost`, {
    method: "POST",
    body: JSON.stringify({ durationMs }),
  }, true),
  announcement: (roomCode: string, message: string) => requestJson<{ room: RoomSnapshot }>(`/api/admin/rooms/${roomCode}/announcement`, {
    method: "POST",
    body: JSON.stringify({ message }),
  }, true),
  bots: (roomCode: string, action: "add" | "remove", count: number) => requestJson<{ action: string; count: number; sessionIds: string[] }>(`/api/admin/rooms/${roomCode}/bots`, {
    method: "POST",
    body: JSON.stringify({ action, count }),
  }, true),
  ops: (releaseChannel?: ReleaseChannel, roomCode?: string) => requestJson<OpsSnapshot>(
    opsPath(releaseChannel, roomCode),
  ),
  triggerMemoryOom: () => requestJson<OpsSnapshot>("/api/admin/faults/memory-oom", {
    method: "POST",
    body: JSON.stringify({}),
  }, true),
  setDemoTickLag: (delayMs: number, releaseChannel: ReleaseChannel, roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/lag", releaseChannel), {
    method: "POST",
    body: JSON.stringify({ ...(roomCode ? { roomCode } : {}), delayMs }),
  }, true),
  setDemoFullBroadcast: (enabled: boolean, releaseChannel: ReleaseChannel, roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/full-broadcast", releaseChannel), {
    method: "POST",
    body: JSON.stringify({ ...(roomCode ? { roomCode } : {}), enabled }),
  }, true),
  requestDemoServerShutdown: (releaseChannel: ReleaseChannel, reason?: string, roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/server-shutdown", releaseChannel), {
    method: "POST",
    body: JSON.stringify({ ...(roomCode ? { roomCode } : {}), ...(reason ? { reason } : {}) }),
  }, true),
  simulateDemoPrimaryFailure: (releaseChannel: ReleaseChannel, reason?: string, roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/primary-failure", releaseChannel), {
    method: "POST",
    body: JSON.stringify({ ...(roomCode ? { roomCode } : {}), ...(reason ? { reason } : {}) }),
  }, true),
  simulateDemoFailover: (releaseChannel: ReleaseChannel, targetCluster: Exclude<ClusterName, "primary"> = "dr", roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/failover", releaseChannel), {
    method: "POST",
    body: JSON.stringify({ ...(roomCode ? { roomCode } : {}), targetCluster }),
  }, true),
  resetDemoChaos: (releaseChannel: ReleaseChannel, roomCode?: string) => requestJson<DemoChaosActionResponse>(releaseChannelPath("/api/admin/chaos/reset", releaseChannel), {
    method: "POST",
    body: JSON.stringify(roomCode ? { roomCode } : {}),
  }, true),
};
