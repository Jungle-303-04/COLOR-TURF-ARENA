import { describe, expect, it } from "vitest";
import type { InputPayload } from "@paint-arena/shared";
import { GameRoom } from "./game.js";

const input = (roomCode: string, sessionId: string, sequence: number, sentAt: number, x: number, y: number): InputPayload => ({
  roomCode,
  sessionId,
  sequence,
  sentAt,
  direction: { x, y },
});

describe("GameRoom server authority", () => {
  it("uses a square default turf with the same 46,656-cell load", () => {
    const room = new GameRoom("WORLD");
    const snapshot = room.snapshot();
    expect(snapshot.config.gridWidth).toBe(216);
    expect(snapshot.config.gridHeight).toBe(216);
    expect(snapshot.grid).toHaveLength(46_656);
  });

  it("balances teams and moves only from validated direction intent", () => {
    let now = 1_000_000;
    const room = new GameRoom("TEST1", undefined, { now: () => now, random: () => 0.1 });
    const first = room.join("session-one", "socket-one", "Alpha");
    const second = room.join("session-two", "socket-two", "Bravo");
    expect(first.player.team).toBe("A");
    expect(second.player.team).toBe("B");
    expect(room.handleInput("session-one", input("TEST1", "session-one", 1, now, 1, 0))).toEqual({ ok: false, reason: "not-running" });

    room.start();
    const before = room.snapshot().players.find((player) => player.id === "session-one")!.position.x;
    expect(room.handleInput("session-one", input("TEST1", "session-one", 1, now, 1, 0))).toEqual({ ok: true });
    now += 100;
    expect(room.tick()).toBe(true);
    const after = room.snapshot().players.find((player) => player.id === "session-one")!.position.x;
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThanOrEqual(1.81);
    expect(room.snapshot().scores.cells.A).toBeGreaterThan(0);
  });

  it("moves at the same world speed on horizontal and vertical axes", () => {
    let now = 1_500_000;
    const horizontal = new GameRoom("SPEEDX", undefined, { now: () => now, random: () => 0.5 });
    const vertical = new GameRoom("SPEEDY", undefined, { now: () => now, random: () => 0.5 });
    const horizontalPlayer = horizontal.join("horizontal", "socket-x", "Horizontal").player;
    const verticalPlayer = vertical.join("vertical", "socket-y", "Vertical").player;
    horizontal.start();
    vertical.start();
    expect(horizontal.handleInput("horizontal", input("SPEEDX", "horizontal", 1, now, 1, 0)).ok).toBe(true);
    expect(vertical.handleInput("vertical", input("SPEEDY", "vertical", 1, now, 0, 1)).ok).toBe(true);

    now += 100;
    horizontal.tick();
    vertical.tick();

    const movedX = horizontal.snapshot().players[0]!.position.x - horizontalPlayer.position.x;
    const movedY = vertical.snapshot().players[0]!.position.y - verticalPlayer.position.y;
    expect(movedX).toBeCloseTo(movedY, 6);
    expect(movedX).toBeCloseTo(1.8, 6);
  });

  it("produces ordered deltas instead of repeating the full grid", () => {
    let now = 2_000_000;
    const room = new GameRoom("DELTA", undefined, { now: () => now });
    room.join("session-delta", "socket", "Delta");
    room.start();
    room.handleInput("session-delta", input("DELTA", "session-delta", 1, now, 0.7, 0.7));
    now += 100;
    room.tick();
    const delta = room.consumeDelta();
    expect(delta.changedCells.length).toBeGreaterThan(0);
    expect(delta).not.toHaveProperty("grid");
    expect(room.consumeDelta().changedCells).toEqual([]);
  });

  it("serializes and restores team, position, grid and match deadline", () => {
    let now = 3_000_000;
    const room = new GameRoom("RECOV", undefined, { now: () => now });
    room.join("session-restore", "socket", "Recovery");
    room.start();
    room.handleInput("session-restore", input("RECOV", "session-restore", 1, now, 0, 1));
    now += 200;
    room.tick();
    const before = room.snapshot();
    const restored = GameRoom.restore(room.serialize(), { now: () => now });
    const after = restored.snapshot();
    expect(after.matchId).toBe(before.matchId);
    expect(after.grid).toEqual(before.grid);
    expect(after.players[0]?.team).toBe(before.players[0]?.team);
    expect(after.players[0]?.position).toEqual(before.players[0]?.position);
    expect(after.players[0]?.connected).toBe(false);
    expect(restored.join("session-restore", "new-socket", "Recovery").reconnected).toBe(true);
  });

  it("applies Paint Boost and expires it on the authoritative clock", () => {
    let now = 4_000_000;
    const room = new GameRoom("BOOST", undefined, { now: () => now });
    room.join("session-boost", "socket", "Boost");
    room.start();
    room.activatePaintBoost(3000);
    room.handleInput("session-boost", input("BOOST", "session-boost", 1, now, 1, 0));
    now += 100;
    room.tick();
    expect(room.snapshot().activeEvents[0]?.multiplier).toBe(2);
    expect(room.snapshot().scores.paintedCells).toBeGreaterThan(20);
    now += 3100;
    room.tick();
    expect(room.snapshot().activeEvents).toEqual([]);
  });

  it("rejects invalid, duplicate, stale and rate-limited input", () => {
    let now = 5_000_000;
    const room = new GameRoom("LIMIT", undefined, { now: () => now });
    room.join("session-limit", "socket");
    room.start();
    expect(room.handleInput("session-limit", input("LIMIT", "session-limit", 1, now, 1, 1))).toEqual({ ok: false, reason: "invalid-direction" });
    expect(room.handleInput("session-limit", input("LIMIT", "session-limit", 1, now, 1, 0))).toEqual({ ok: true });
    expect(room.handleInput("session-limit", input("LIMIT", "session-limit", 1, now, 1, 0))).toEqual({ ok: false, reason: "duplicate" });
    expect(room.handleInput("session-limit", input("LIMIT", "session-limit", 2, now - 4000, 1, 0))).toEqual({ ok: false, reason: "stale" });
    for (let sequence = 2; sequence <= 20; sequence += 1) expect(room.handleInput("session-limit", input("LIMIT", "session-limit", sequence, now, 0, 1)).ok).toBe(true);
    expect(room.handleInput("session-limit", input("LIMIT", "session-limit", 21, now, 0, 1))).toEqual({ ok: false, reason: "rate-limited" });
  });

  it("ends on the authoritative deadline and resolves a winner or draw", () => {
    let now = 6_000;
    const room = new GameRoom("ENDIT", undefined, { now: () => now });
    room.start();
    now += 90_001;
    expect(room.tick()).toBe(true);
    expect(room.snapshot().status).toBe("ended");
    expect(room.snapshot().winner).not.toBeNull();
  });
});
