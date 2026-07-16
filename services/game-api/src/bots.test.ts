import type { PlayerPublic, TeamId } from "@paint-arena/shared";
import { describe, expect, it } from "vitest";
import { chooseBotDirection, type BotWorldView } from "./bots.js";

const player = (id: string, team: TeamId, x: number, y: number): PlayerPublic => ({
  id,
  nickname: id,
  team,
  connected: true,
  joinedAt: new Date(0).toISOString(),
  position: { x, y },
  isBot: true,
});

const world = (width = 15, height = 15): BotWorldView => ({
  sequence: 1,
  width,
  height,
  grid: Array.from({ length: width * height }, () => "A" as TeamId | null),
  players: [player("bot-a", "A", 7, 7)],
});

describe("bot steering", () => {
  it("prefers nearby neutral and opponent territory over already-owned cells", () => {
    const state = world();
    for (let x = 9; x < state.width; x += 1) state.grid[7 * state.width + x] = null;
    state.grid[7 * state.width + 12] = "B";

    const direction = chooseBotDirection(state, "bot-a", "A", () => 0);

    expect(direction.x).toBeGreaterThan(0.7);
    expect(Math.abs(direction.y)).toBeLessThan(0.5);
  });

  it("avoids steering out of bounds when paintable cells exist inward", () => {
    const state = world();
    state.players = [player("bot-a", "A", 1, 7)];
    for (let x = 3; x < 9; x += 1) state.grid[7 * state.width + x] = null;

    const direction = chooseBotDirection(state, "bot-a", "A", () => 0);

    expect(direction.x).toBeGreaterThan(0);
  });

  it("uses the team from the latest world snapshot after an admin reassign", () => {
    const state = world();
    state.players = [player("bot-a", "B", 7, 7)];
    for (let x = 9; x < state.width; x += 1) state.grid[7 * state.width + x] = "A";
    for (let x = 0; x < 6; x += 1) state.grid[7 * state.width + x] = "B";

    const direction = chooseBotDirection(state, "bot-a", "A", () => 0);

    expect(direction.x).toBeGreaterThan(0.7);
    expect(Math.abs(direction.y)).toBeLessThan(0.5);
  });

  it("returns a normalized fallback when the world is not available", () => {
    const direction = chooseBotDirection(undefined, null, null);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 5);
  });
});
