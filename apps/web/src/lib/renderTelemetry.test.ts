import { describe, expect, it } from "vitest";
import { summarizeRenderIntervals } from "./renderTelemetry";

describe("render telemetry", () => {
  it("reports a stable 60Hz render window without estimated drops", () => {
    const sample = summarizeRenderIntervals(Array.from({ length: 60 }, () => 1000 / 60), 1000);

    expect(sample.fps).toBe(60);
    expect(sample.frameTimeP95Ms).toBeCloseTo(16.67, 1);
    expect(sample.droppedFramePercent).toBe(0);
    expect(sample.frameCount).toBe(60);
  });

  it("turns long requestAnimationFrame gaps into a visible drop percentage", () => {
    const intervals = [...Array.from({ length: 57 }, () => 1000 / 60), 50];
    const duration = intervals.reduce((sum, value) => sum + value, 0);
    const sample = summarizeRenderIntervals(intervals, duration);

    expect(sample.fps).toBeLessThan(60);
    expect(sample.frameTimeP95Ms).toBeGreaterThanOrEqual(16.67);
    expect(sample.droppedFramePercent).toBeGreaterThan(3);
  });

  it("ignores invalid intervals instead of reporting impossible values", () => {
    const sample = summarizeRenderIntervals([16, Number.NaN, -4, Number.POSITIVE_INFINITY], 1000);

    expect(sample.frameCount).toBe(1);
    expect(sample.fps).toBe(1);
    expect(sample.droppedFramePercent).toBe(0);
  });
});
