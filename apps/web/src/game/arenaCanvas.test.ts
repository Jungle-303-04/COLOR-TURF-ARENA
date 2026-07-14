import { describe, expect, it } from "vitest";
import { getCameraViewport, getCanvasFit } from "./arenaCanvas";

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
