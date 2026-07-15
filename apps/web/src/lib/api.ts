import type { OpsSnapshot, PublicConfig, RoomSnapshot, RoomSummary, SystemStatus } from "@paint-arena/shared";

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

export const api = {
  config: () => requestJson<PublicConfig>("/api/config"),
  verifyAdmin: () => requestJson<{ ok: boolean }>("/api/admin/session", undefined, true),
  listRooms: () => requestJson<{ rooms: RoomSummary[] }>("/api/rooms"),
  getRoom: (roomCode: string) => requestJson<{ room: RoomSnapshot }>(`/api/rooms/${roomCode}`),
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
  ops: () => requestJson<OpsSnapshot>("/api/ops"),
  triggerMemoryOom: () => requestJson<OpsSnapshot>("/api/admin/faults/memory-oom", {
    method: "POST",
    body: JSON.stringify({}),
  }, true),
};
