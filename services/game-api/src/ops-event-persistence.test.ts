import type { EventLogEntry } from "@paint-arena/shared";
import { describe, expect, it } from "vitest";
import { createGameServer } from "./server.js";
import { MemorySnapshotStorage } from "./snapshot-store.js";

class SharedEventMemoryStorage extends MemorySnapshotStorage {
  constructor(private readonly sharedEvents: EventLogEntry[]) {
    super();
  }

  override async appendEvent(entry: EventLogEntry): Promise<void> {
    this.sharedEvents.unshift(structuredClone(entry));
    if (this.sharedEvents.length > 200) this.sharedEvents.length = 200;
  }

  override async loadRecentEvents(limit = 200): Promise<EventLogEntry[]> {
    return structuredClone(this.sharedEvents.slice(0, limit));
  }
}

class FailingEventMemoryStorage extends MemorySnapshotStorage {
  override async appendEvent(): Promise<void> {
    throw new Error("shared event store unavailable");
  }
}

describe("shared operations event history", () => {
  it("keeps platform events visible on an already-running DR server after Stable stops", async () => {
    const sharedEvents: EventLogEntry[] = [];
    const stable = createGameServer({
      clusterName: "primary",
      podName: "stable",
      opsEventToken: "test-ops",
      snapshotStorage: new SharedEventMemoryStorage(sharedEvents),
    });
    const dr = createGameServer({
      clusterName: "dr",
      podName: "dr",
      opsEventToken: "test-ops",
      snapshotStorage: new SharedEventMemoryStorage(sharedEvents),
    });
    const runningStable = await stable.start(0, "127.0.0.1");
    const runningDr = await dr.start(0, "127.0.0.1");
    let stableStopped = false;

    try {
      for (const event of [
        { type: "PRIMARY_UNHEALTHY", message: "Primary health check failed", cluster: "primary" },
        { type: "FAILOVER_STARTED", message: "Routing traffic to DR", cluster: "dr" },
      ]) {
        const response = await fetch(`${runningStable.url}/api/ops/events`, {
          method: "POST",
          headers: { authorization: "Bearer test-ops", "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        expect(response.status).toBe(202);
      }

      await stable.stop();
      stableStopped = true;

      const ops = await (await fetch(`${runningDr.url}/api/ops`)).json() as {
        recentEvents: EventLogEntry[];
      };
      expect(ops.recentEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
        "PRIMARY_UNHEALTHY",
        "FAILOVER_STARTED",
      ]));

      const timeline = await (await fetch(`${runningDr.url}/api/ops/events`)).json() as {
        events: EventLogEntry[];
      };
      expect(timeline.events.filter((event) => event.type === "PRIMARY_UNHEALTHY")).toHaveLength(1);
      expect(timeline.events.filter((event) => event.type === "FAILOVER_STARTED")).toHaveLength(1);
    } finally {
      if (!stableStopped) await stable.stop();
      await dr.stop();
    }
  });

  it("returns 503 without recursively creating another event when shared persistence fails", async () => {
    const server = createGameServer({
      opsEventToken: "test-ops",
      snapshotStorage: new FailingEventMemoryStorage(),
    });
    const running = await server.start(0, "127.0.0.1");
    try {
      const response = await fetch(`${running.url}/api/ops/events`, {
        method: "POST",
        headers: { authorization: "Bearer test-ops", "content-type": "application/json" },
        body: JSON.stringify({
          type: "PRIMARY_UNHEALTHY",
          message: "Primary health check failed",
          cluster: "primary",
        }),
      });
      expect(response.status).toBe(503);

      const timeline = await (await fetch(`${running.url}/api/ops/events`)).json() as {
        events: EventLogEntry[];
      };
      expect(timeline.events.map((event) => event.type)).toEqual(["PRIMARY_UNHEALTHY"]);
    } finally {
      await server.stop();
    }
  });
});
