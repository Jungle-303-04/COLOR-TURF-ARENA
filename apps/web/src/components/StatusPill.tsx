import type { RoomStatus } from "@paint-arena/shared";

const labels: Record<"en" | "ko", Record<RoomStatus, string>> = {
  en: {
    lobby: "LOBBY",
    running: "LIVE",
    paused: "PAUSED",
    ended: "ENDED",
  },
  ko: {
    lobby: "대기",
    running: "진행 중",
    paused: "일시정지",
    ended: "종료",
  },
};

export const StatusPill = ({ status, locale = "en" }: { status: RoomStatus; locale?: "en" | "ko" }) => (
  <span className={`status-pill status-${status}`}><i />{labels[locale][status]}</span>
);
