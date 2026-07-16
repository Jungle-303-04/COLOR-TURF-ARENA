import type { JoinPayload } from "@paint-arena/shared";

export const buildJoinPayload = (roomCode: string, sessionId: string, nickname: string): JoinPayload => {
  const cleanNickname = nickname.trim();

  return {
    roomCode,
    sessionId,
    ...(cleanNickname ? { nickname: cleanNickname } : {}),
  };
};
