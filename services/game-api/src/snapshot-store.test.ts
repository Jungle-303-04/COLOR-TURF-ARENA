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
});
