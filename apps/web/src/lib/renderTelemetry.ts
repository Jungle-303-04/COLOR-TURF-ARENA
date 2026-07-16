import type { Socket } from "socket.io-client";

export interface ClientRenderTelemetrySample {
  fps: number;
  frameTimeP95Ms: number;
  droppedFramePercent: number;
  sampleDurationMs: number;
  frameCount: number;
}

interface RenderTelemetryOptions {
  sampleWindowMs?: number;
  targetFrameMs?: number;
  onSample?: (sample: ClientRenderTelemetrySample) => void;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

const percentile = (values: number[], ratio: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
};

export const summarizeRenderIntervals = (
  rawIntervalsMs: number[],
  sampleDurationMs: number,
  targetFrameMs = 1000 / 60,
): ClientRenderTelemetrySample => {
  const intervalsMs = rawIntervalsMs.filter((value) => Number.isFinite(value) && value > 0);
  const duration = clamp(sampleDurationMs, 1, 10_000);
  const frameCount = intervalsMs.length;
  const expectedFrames = intervalsMs.reduce((sum, interval) => sum + Math.max(1, Math.round(interval / targetFrameMs)), 0);
  const droppedFrames = Math.max(0, expectedFrames - frameCount);

  return {
    fps: Number(clamp((frameCount * 1000) / duration, 0, 240).toFixed(2)),
    frameTimeP95Ms: Number(clamp(percentile(intervalsMs, 0.95), 0, 10_000).toFixed(2)),
    droppedFramePercent: Number(clamp(expectedFrames === 0 ? 0 : (droppedFrames / expectedFrames) * 100, 0, 100).toFixed(2)),
    sampleDurationMs: Number(duration.toFixed(2)),
    frameCount,
  };
};

export const startRenderTelemetry = (
  getSocket: () => Socket | null,
  options: RenderTelemetryOptions = {},
): (() => void) => {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return () => undefined;

  const sampleWindowMs = clamp(options.sampleWindowMs ?? 1000, 500, 5000);
  const targetFrameMs = options.targetFrameMs ?? 1000 / 60;
  let stopped = false;
  let frameRequest = 0;
  let windowStartedAt = performance.now();
  let previousFrameAt: number | null = null;
  let intervalsMs: number[] = [];

  const resetWindow = (now: number) => {
    windowStartedAt = now;
    previousFrameAt = null;
    intervalsMs = [];
  };

  const sampleFrame = (now: number) => {
    if (stopped) return;
    if (document.visibilityState !== "visible") {
      resetWindow(now);
      frameRequest = window.requestAnimationFrame(sampleFrame);
      return;
    }

    if (previousFrameAt !== null) intervalsMs.push(now - previousFrameAt);
    previousFrameAt = now;
    const elapsed = now - windowStartedAt;
    if (elapsed >= sampleWindowMs) {
      const sample = summarizeRenderIntervals(intervalsMs, elapsed, targetFrameMs);
      if (sample.frameCount > 0) {
        options.onSample?.(sample);
        const socket = getSocket();
        if (socket?.connected) socket.emit("client_render_stats", sample);
      }
      resetWindow(now);
    }
    frameRequest = window.requestAnimationFrame(sampleFrame);
  };

  frameRequest = window.requestAnimationFrame(sampleFrame);
  return () => {
    stopped = true;
    window.cancelAnimationFrame(frameRequest);
  };
};
