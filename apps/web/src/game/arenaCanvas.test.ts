import { describe, expect, it } from "vitest";
import type { PlayerPublic } from "@paint-arena/shared";
import {
  getCameraViewport,
  getCanvasFit,
  getWorldPlayerLabelPlacement,
  interpolatePosition,
  selectWorldLabelPlayers,
} from "./arenaCanvas";

const player = (id: string, nickname: string, connected: boolean, isBot: boolean): PlayerPublic => ({
  id,
  nickname,
  connected,
  isBot,
  team: id.length % 2 === 0 ? "A" : "B",
  joinedAt: "2026-07-16T00:00:00.000Z",
  position: { x: 10, y: 10 },
});

describe("authoritative position interpolation", () => {
  it("smoothly interpolates between 30Hz server positions", () => {
    expect(interpolatePosition({ x: 10, y: 20 }, { x: 20, y: 40 }, 0.5)).toEqual({ x: 15, y: 30 });
    expect(interpolatePosition({ x: 10, y: 20 }, { x: 20, y: 40 }, -1)).toEqual({ x: 10, y: 20 });
    expect(interpolatePosition({ x: 10, y: 20 }, { x: 20, y: 40 }, 2)).toEqual({ x: 20, y: 40 });
  });
});

describe("square-cell canvas fit", () => {
  it("letterboxes a square viewport inside a tall phone canvas", () => {
    expect(getCanvasFit(360, 500, 72, 72)).toEqual({
      cellSize: 5,
      renderWidth: 360,
      renderHeight: 360,
      offsetX: 0,
      offsetY: 70,
    });
  });
});

describe("player camera viewport", () => {
  it("shows one ninth of the square world with a square centered camera", () => {
    const viewport = getCameraViewport(216, 216, 108, 108);

    expect(viewport).toEqual({ left: 72, top: 72, width: 72, height: 72 });
    expect(viewport.width * viewport.height).toBe((216 * 216) / 9);
  });

  it("stays inside the world at both edges", () => {
    expect(getCameraViewport(216, 216, 0, 0)).toEqual({ left: 0, top: 0, width: 72, height: 72 });
    expect(getCameraViewport(216, 216, 216, 216)).toEqual({ left: 144, top: 144, width: 72, height: 72 });
  });

  it("uses the whole world when it is smaller than the camera", () => {
    expect(getCameraViewport(40, 30, 20, 15)).toEqual({ left: 0, top: 0, width: 40, height: 30 });
  });
});

describe("world player labels", () => {
  it("prioritizes human nicknames and enforces the clutter limit", () => {
    const selected = selectWorldLabelPlayers([
      player("bot-online", "BOT-ONLINE", true, true),
      player("human-away", "사람-오프라인", false, false),
      player("bot-away", "BOT-AWAY", false, true),
      player("human-online-b", "사람-B", true, false),
      player("human-online-a", "사람-A", true, false),
    ], 3);

    expect(selected.map((candidate) => candidate.nickname)).toEqual(["사람-A", "사람-B", "사람-오프라인"]);
  });

  it("uses the lower side near the top edge and avoids occupied label boxes", () => {
    const input = {
      centerX: 50,
      centerY: 10,
      radius: 8,
      labelWidth: 40,
      offsetX: 0,
      offsetY: 0,
      renderWidth: 100,
      renderHeight: 100,
    };
    const placement = getWorldPlayerLabelPlacement(input);

    expect(placement).toEqual({ left: 25, top: 23, width: 50, height: 16 });
    expect(getWorldPlayerLabelPlacement(input, [{
      left: placement?.left ?? 0,
      top: placement?.top ?? 0,
      right: (placement?.left ?? 0) + (placement?.width ?? 0),
      bottom: (placement?.top ?? 0) + (placement?.height ?? 0),
    }])).toBeNull();
  });
});
