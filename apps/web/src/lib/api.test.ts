import type { DemoChaosActionResponse } from "@paint-arena/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, setAdminToken } from "./api";

const responseBody = {
  ok: true,
  action: "reset",
  status: {
    observedAt: "2026-07-16T00:00:00.000Z",
    source: "game-api-runtime",
    scope: {
      kind: "room-owner-process",
      roomCode: "ROOM01",
      podName: "game-api-test",
    },
    runtime: {
      tickDelayMs: 0,
      fullBroadcastEnabled: false,
      effectiveBroadcastMode: "delta",
      configuredTickDelayMs: 0,
      configuredBroadcastMode: "delta",
      overrideActive: false,
      source: "environment",
      updatedAt: null,
    },
    simulations: {
      primaryFailure: { active: false, label: "SIMULATION", source: "timeline-only", requestedAt: null, reason: null },
      failover: { active: false, label: "SIMULATION", source: "timeline-only", requestedAt: null, targetCluster: null },
    },
    serverShutdown: {
      allowed: false,
      handlerAvailable: false,
      requestedAt: null,
      source: "environment-gated",
    },
  },
} satisfies DemoChaosActionResponse;

describe("Demo / Chaos API client", () => {
  const values = new Map<string, string>();
  const fetchMock = vi.fn();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    } satisfies Storage);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    setAdminToken("demo-admin");
  });

  it.each([
    ["lag", () => api.setDemoTickLag(250, "canary", "ROOM01"), "/api/admin/chaos/lag?releaseChannel=canary", { roomCode: "ROOM01", delayMs: 250 }],
    ["full broadcast", () => api.setDemoFullBroadcast(true, "stable", "ROOM01"), "/api/admin/chaos/full-broadcast?releaseChannel=stable", { roomCode: "ROOM01", enabled: true }],
    ["server shutdown", () => api.requestDemoServerShutdown("canary", "발표용 종료", "ROOM01"), "/api/admin/chaos/server-shutdown?releaseChannel=canary", { roomCode: "ROOM01", reason: "발표용 종료" }],
    ["primary failure", () => api.simulateDemoPrimaryFailure("stable", "타임라인 시연", "ROOM01"), "/api/admin/chaos/primary-failure?releaseChannel=stable", { roomCode: "ROOM01", reason: "타임라인 시연" }],
    ["failover", () => api.simulateDemoFailover("canary", "dr", "ROOM01"), "/api/admin/chaos/failover?releaseChannel=canary", { roomCode: "ROOM01", targetCluster: "dr" }],
    ["reset", () => api.resetDemoChaos("stable", "ROOM01"), "/api/admin/chaos/reset?releaseChannel=stable", { roomCode: "ROOM01" }],
  ])("sends %s to the selected release channel with ADMIN_TOKEN", async (_label, invoke, expectedPath, expectedBody) => {
    await invoke();

    expect(fetchMock).toHaveBeenCalledWith(expectedPath, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer demo-admin",
        "content-type": "application/json",
      }),
      body: JSON.stringify(expectedBody),
    }));
  });

  it("requests metrics from the selected room owner", async () => {
    await api.ops("canary", "ROOM01");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ops?releaseChannel=canary&roomCode=ROOM01",
      expect.objectContaining({ headers: {} }),
    );
  });
});
