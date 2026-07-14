import type { RoomStatus } from "@paint-arena/shared";

const labels: Record<RoomStatus, string> = {
  lobby: "LOBBY",
  running: "LIVE",
  paused: "PAUSED",
  ended: "ENDED",
};

export const StatusPill = ({ status }: { status: RoomStatus }) => (
  <span className={`status-pill status-${status}`}><i />{labels[status]}</span>
);

