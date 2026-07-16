import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

interface StoredSession {
  sessionId: string;
  nickname: string;
  playerId?: string;
  team?: "A" | "B";
  lastReceivedSequence: number;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} was not provided by the E2E global setup`);
  return value;
};

const numericText = async (locator: Locator): Promise<number> => {
  const value = Number((await locator.textContent())?.replace(/[^\d.-]/g, "") ?? Number.NaN);
  if (!Number.isFinite(value)) throw new Error("Expected a numeric score");
  return value;
};

const readSession = async (page: Page, roomCode: string): Promise<StoredSession | null> => page.evaluate((code) => {
  const raw = localStorage.getItem(`color-turf-session:${code}`);
  return raw ? JSON.parse(raw) as StoredSession : null;
}, roomCode);

const closeContexts = async (contexts: BrowserContext[]) => {
  await Promise.all(contexts.map(async (context) => {
    try {
      await context.close();
    } catch {
      // The browser may already be closing after a failed assertion.
    }
  }));
};

test("admin, player and spectator complete the live browser flow", async ({ browser }) => {
  const baseUrl = requiredEnvironment("E2E_BASE_URL");
  const adminToken = requiredEnvironment("E2E_ADMIN_TOKEN");
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const playerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const spectatorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const contexts = [adminContext, playerContext, spectatorContext];

  try {
    const admin = await adminContext.newPage();
    await admin.goto(`${baseUrl}/admin`);
    await admin.getByLabel("관리자 토큰").fill(adminToken);
    await admin.getByRole("button", { name: "관리자 화면 열기" }).click();
    await expect(admin.getByRole("tab", { name: /게임 진행 상황/ })).toHaveAttribute("aria-selected", "true");

    await admin.getByRole("button", { name: "새 경기장 만들기" }).click();
    const roomCodeElement = admin.locator(".join-room-code");
    await expect(roomCodeElement).toBeVisible();
    const roomCode = (await roomCodeElement.innerText()).trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{5}$/);

    const player = await playerContext.newPage();
    await player.goto(`${baseUrl}/play/${roomCode}`);
    await player.getByLabel("NICKNAME (OPTIONAL)").fill("브라우저-E2E");
    await player.getByRole("button", { name: "JOIN ARENA" }).click();
    await expect(player.locator(".hud-team em")).toHaveText("브라우저-E2E");
    await expect(player.locator(".connection-chip")).toContainText("CONNECTED");
    const assignedTeam = (await player.locator(".hud-team > i").innerText()).trim() as "A" | "B";
    expect(["A", "B"]).toContain(assignedTeam);

    const spectator = await spectatorContext.newPage();
    await spectator.goto(`${baseUrl}/watch/${roomCode}`);
    await expect(spectator.locator(".score-ribbon")).toBeVisible();
    await expect(spectator.locator(".screen-room-id strong")).toHaveText(roomCode);

    await admin.getByRole("tab", { name: /게임·봇 제어/ }).click();
    await admin.getByRole("button", { name: "게임 시작", exact: true }).click();
    await expect(player.locator(".hud-clock small")).toHaveText("RUNNING");
    await expect(spectator.locator(".match-clock")).toContainText("LIVE");

    const watchedTeamScore = spectator.locator(assignedTeam === "A" ? ".team-score-a strong" : ".team-score-b strong");
    const scoreBeforeMove = await numericText(watchedTeamScore);
    const joystick = player.locator(".virtual-joystick");
    await joystick.scrollIntoViewIfNeeded();
    const box = await joystick.boundingBox();
    if (!box) throw new Error("Virtual joystick does not have a rendered bounding box");
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    await player.mouse.move(centerX, centerY);
    await player.mouse.down();
    await player.mouse.move(centerX + box.width * 0.28, centerY - box.height * 0.12, { steps: 8 });
    await player.waitForTimeout(900);
    await player.mouse.up();

    await expect.poll(() => numericText(watchedTeamScore), {
      message: "the spectator score should reflect paint produced by the pointer joystick",
      timeout: 10_000,
    }).toBeGreaterThan(scoreBeforeMove);

    await admin.getByRole("button", { name: /페인트 강화 ×2 · 10초/ }).click();
    await expect(player.locator(".boost-chip")).toContainText("PAINT BOOST ×2");
    await expect(spectator.locator(".watch-event-toast")).toContainText("PAINT BOOST ×2");

    const sessionBeforeOffline = await readSession(player, roomCode);
    expect(sessionBeforeOffline?.nickname).toBe("브라우저-E2E");
    expect(sessionBeforeOffline?.team).toBe(assignedTeam);
    await playerContext.setOffline(true);
    await expect(player.locator(".reconnect-overlay")).toBeVisible();
    await playerContext.setOffline(false);
    await expect(player.locator(".reconnect-overlay")).toBeHidden({ timeout: 15_000 });
    await expect(player.locator(".connection-chip")).toContainText("CONNECTED");
    await expect(player.locator(".hud-team em")).toHaveText("브라우저-E2E");
    await expect(player.locator(".hud-team > i")).toHaveText(assignedTeam);

    const sessionAfterReconnect = await readSession(player, roomCode);
    expect(sessionAfterReconnect?.sessionId).toBe(sessionBeforeOffline?.sessionId);
    expect(sessionAfterReconnect?.nickname).toBe(sessionBeforeOffline?.nickname);
    expect(sessionAfterReconnect?.team).toBe(sessionBeforeOffline?.team);
    expect(sessionAfterReconnect?.lastReceivedSequence ?? 0)
      .toBeGreaterThanOrEqual(sessionBeforeOffline?.lastReceivedSequence ?? 0);
  } finally {
    await closeContexts(contexts);
  }
});
