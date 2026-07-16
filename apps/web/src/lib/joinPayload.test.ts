import { describe, expect, it } from "vitest";
import { joinPayloadSchema } from "@paint-arena/shared";
import { buildJoinPayload } from "./joinPayload";

describe("buildJoinPayload", () => {
  it("omits a blank nickname so the server assigns its Guest-N default", () => {
    const payload = buildJoinPayload("ROOM1", "session-guest", "   ");

    expect(payload).toEqual({
      roomCode: "ROOM1",
      sessionId: "session-guest",
    });
    expect(joinPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("keeps an explicit nickname after trimming surrounding whitespace", () => {
    expect(buildJoinPayload("ROOM1", "session-player", "  Jungle-01  ")).toEqual({
      roomCode: "ROOM1",
      sessionId: "session-player",
      nickname: "Jungle-01",
    });
  });
});
