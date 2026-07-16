import { describe, expect, it, vi } from "vitest";
import { isRoomRecoveryPending, retryDelayMs, retryWithBackoff } from "./retry";

describe("retryWithBackoff", () => {
  it("returns immediately when the first result does not need a retry", async () => {
    const operation = vi.fn(async () => ({ ok: true }));
    const wait = vi.fn(async () => undefined);

    const outcome = await retryWithBackoff(operation, {
      shouldRetry: (result) => !result.ok,
      maxAttempts: 4,
      initialDelayMs: 100,
      wait,
    });

    expect(outcome).toEqual({ status: "complete", value: { ok: true }, attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("backs off until a transient room lookup succeeds", async () => {
    const operation = vi.fn<() => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValueOnce({ ok: false, error: "Room not found" })
      .mockResolvedValueOnce({ ok: false, error: "Room not found" })
      .mockResolvedValueOnce({ ok: true });
    const delays: number[] = [];

    const outcome = await retryWithBackoff(operation, {
      shouldRetry: (result) => !result.ok && isRoomRecoveryPending(result.error),
      maxAttempts: 5,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      multiplier: 2,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    expect(outcome).toEqual({ status: "complete", value: { ok: true }, attempts: 3 });
    expect(delays).toEqual([250, 500]);
  });

  it("retries an acknowledgement timeout before succeeding", async () => {
    const operation = vi.fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error("operation has timed out"))
      .mockResolvedValueOnce({ ok: true });

    const outcome = await retryWithBackoff(operation, {
      shouldRetry: (result) => !result.ok,
      maxAttempts: 3,
      initialDelayMs: 250,
      wait: async () => undefined,
    });

    expect(outcome).toEqual({ status: "complete", value: { ok: true }, attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("stops at the configured attempt bound", async () => {
    const operation = vi.fn(async () => ({ ok: false, error: "Room not found" }));
    const delays: number[] = [];

    const outcome = await retryWithBackoff(operation, {
      shouldRetry: (result) => !result.ok,
      maxAttempts: 4,
      initialDelayMs: 250,
      maxDelayMs: 500,
      multiplier: 2,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    expect(outcome).toEqual({
      status: "exhausted",
      value: { ok: false, error: "Room not found" },
      attempts: 4,
    });
    expect(operation).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([250, 500, 500]);
  });

  it("cancels before another operation after an abort during backoff", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => ({ ok: false }));

    const outcome = await retryWithBackoff(operation, {
      shouldRetry: (result) => !result.ok,
      maxAttempts: 4,
      initialDelayMs: 100,
      signal: controller.signal,
      wait: async () => { controller.abort(); },
    });

    expect(outcome).toEqual({ status: "aborted", attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("room recovery retry helpers", () => {
  it("only treats the authority-gap response as a recoverable lookup", () => {
    expect(isRoomRecoveryPending("Room not found")).toBe(true);
    expect(isRoomRecoveryPending()).toBe(true);
    expect(isRoomRecoveryPending("Unauthorized")).toBe(false);
    expect(isRoomRecoveryPending("Invalid join payload")).toBe(false);
  });

  it("caps exponential retry delays", () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, 250, 2_000, 2)))
      .toEqual([250, 500, 1_000, 2_000, 2_000]);
  });
});
