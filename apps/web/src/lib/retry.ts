export interface RetryWithBackoffOptions<T> {
  shouldRetry: (value: T) => boolean;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  signal?: AbortSignal;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export type RetryOutcome<T> =
  | { status: "complete"; value: T; attempts: number }
  | { status: "exhausted"; value?: T; error?: unknown; attempts: number }
  | { status: "aborted"; attempts: number };

export const ROOM_RECOVERY_ACK_TIMEOUT_MS = 1_500;

export const ROOM_RECOVERY_RETRY_POLICY = {
  maxAttempts: 8,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  multiplier: 2,
} as const;

export const isRoomRecoveryPending = (error?: string): boolean => {
  if (!error) return true;
  return error.trim().toLowerCase() === "room not found";
};

export const retryDelayMs = (
  failedAttempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  multiplier: number,
): number => Math.min(maxDelayMs, initialDelayMs * multiplier ** Math.max(0, failedAttempt - 1));

const waitForDelay = (delayMs: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }

  const finish = () => {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = globalThis.setTimeout(finish, delayMs);
  signal?.addEventListener("abort", finish, { once: true });
});

export const retryWithBackoff = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions<T>,
): Promise<RetryOutcome<T>> => {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 0);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? initialDelayMs);
  const multiplier = Math.max(1, options.multiplier ?? 1);
  const wait = options.wait ?? waitForDelay;
  let lastValue: T | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) return { status: "aborted", attempts: attempt - 1 };

    try {
      const value = await operation(attempt);
      if (options.signal?.aborted) return { status: "aborted", attempts: attempt };
      if (!options.shouldRetry(value)) return { status: "complete", value, attempts: attempt };
      lastValue = value;
      lastError = undefined;
    } catch (error) {
      if (options.signal?.aborted) return { status: "aborted", attempts: attempt };
      lastValue = undefined;
      lastError = error;
    }

    if (attempt === maxAttempts) {
      return lastError === undefined
        ? { status: "exhausted", value: lastValue, attempts: attempt }
        : { status: "exhausted", error: lastError, attempts: attempt };
    }

    await wait(retryDelayMs(attempt, initialDelayMs, maxDelayMs, multiplier), options.signal);
  }

  return { status: "aborted", attempts: 0 };
};
