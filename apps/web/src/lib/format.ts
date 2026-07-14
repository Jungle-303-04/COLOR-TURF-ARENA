export const formatTimer = (remainingMs: number): string => {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatTime = (value: string): string => new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}).format(new Date(value));

export const formatNumber = (value: number, digits = 0): string => new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: digits,
}).format(value);

