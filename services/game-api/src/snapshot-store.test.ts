import type { EventLogEntry } from "@paint-arena/shared";
import { describe, expect, it } from "vitest";
import { GameRoom } from "./game.js";
import { MemorySnapshotStorage } from "./snapshot-store.js";

describe("snapshot storage and room lease", () => {
  it("saves, restores and enforces lease ownership/expiry", async () => {
    const storage = new MemorySnapshotStorage();
    await storage.connect();
    const room = new GameRoom("LEASE");
    room.join("session-lease", "socket", "Lease Player");
    await storage.save(room.serialize());
    expect((await storage.load("LEASE"))?.players[0]?.nickname).toBe("Lease Player");
    expect(await storage.acquireLease("LEASE", "primary", 1000)).toBe(true);
    expect(await storage.acquireLease("LEASE", "dr", 1000)).toBe(false);
    expect(await storage.renewLease("LEASE", "primary", 1000)).toBe(true);
    await storage.releaseLease("LEASE", "primary");
    expect(await storage.acquireLease("LEASE", "dr", 1000)).toBe(true);
    await storage.close();
  });

  it("keeps only the newly activated room in single-use mode", async () => {
    const storage = new MemorySnapshotStorage();
    await storage.connect();
    await storage.save(new GameRoom("FIRST").serialize());
    await storage.save(new GameRoom("SECOND").serialize());
    const event: EventLogEntry = {
      id: "event-before-single-use-reset",
      at: "2026-07-16T00:00:00.000Z",
      type: "PRIMARY_UNHEALTHY",
      message: "Primary stopped responding",
      roomCode: "FIRST",
      source: "platform",
    };
    await storage.appendEvent(event);
    await storage.activateSingleRoom("SECOND");
    expect(await storage.activeRoomCode()).toBe("SECOND");
    expect((await storage.loadAll()).map((room) => room.roomCode)).toEqual(["SECOND"]);
    expect(await storage.loadRecentEvents()).toEqual([event]);
    await storage.clearAll();
    expect(await storage.loadAll()).toEqual([]);
    expect(await storage.loadRecentEvents()).toEqual([]);
  });

  it("keeps shared events newest-first and caps the retained history", async () => {
    const storage = new MemorySnapshotStorage();
    await storage.connect();
    for (let index = 0; index < 205; index += 1) {
      await storage.appendEvent({
        id: `event-${index}`,
        at: new Date(Date.UTC(2026, 6, 16, 0, 0, index)).toISOString(),
        type: "FAILOVER_STARTED",
        message: `Failover step ${index}`,
        roomCode: null,
        source: "platform",
      });
    }
    const events = await storage.loadRecentEvents();
    expect(events).toHaveLength(200);
    expect(events[0]?.id).toBe("event-204");
    expect(events.at(-1)?.id).toBe("event-5");
  });
});
