import { describe, expect, it } from "vitest";
import { getCameraViewport } from "./arenaCanvas";

describe("player camera viewport", () => {
  it("shows one ninth of the default world while following a centered player", () => {
    const viewport = getCameraViewport(288, 162, 144, 81);

    expect(viewport).toEqual({ left: 96, top: 54, width: 96, height: 54 });
    expect(viewport.width * viewport.height).toBe((288 * 162) / 9);
  });

  it("stays inside the world at both edges", () => {
    expect(getCameraViewport(288, 162, 0, 0)).toEqual({ left: 0, top: 0, width: 96, height: 54 });
    expect(getCameraViewport(288, 162, 288, 162)).toEqual({ left: 192, top: 108, width: 96, height: 54 });
  });

  it("uses the whole world when it is smaller than the camera", () => {
    expect(getCameraViewport(40, 30, 20, 15)).toEqual({ left: 0, top: 0, width: 40, height: 30 });
  });
});
