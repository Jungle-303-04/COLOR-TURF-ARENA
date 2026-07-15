import { describe, expect, it } from "vitest";
import { createClientSessionId } from "./clientId";

describe("createClientSessionId", () => {
  it("uses randomUUID on secure origins", () => {
    expect(createClientSessionId({ randomUUID: () => "secure-origin-id" })).toBe("secure-origin-id");
  });

  it("creates a UUID when LAN HTTP does not expose randomUUID", () => {
    const id = createClientSessionId({ getRandomValues: (bytes) => { bytes.fill(0x2a); return bytes; } });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("still creates an id when browser crypto is unavailable", () => {
    expect(createClientSessionId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
