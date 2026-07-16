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
    const overviewTab = admin.getByRole("tab", { name: /전체 게임 진행/ });
    const controlsTab = admin.getByRole("tab", { name: /봇·부하 제어/ });
    const metricsTab = admin.getByRole("tab", { name: /운영 지표/ });
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    await expect(admin.getByRole("tabpanel", { name: /전체 게임 진행/ })).toBeVisible();

    await admin.getByRole("button", { name: "새 경기장 만들기" }).click();
    const roomCodeElement = admin.locator(".join-room-code");
    await expect(roomCodeElement).toBeVisible();
    const roomCode = (await roomCodeElement.innerText()).trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{5}$/);
    await expect(admin.getByLabel("관리자 실시간 미니 관전 화면")).toBeVisible();
    await expect(admin.getByText("실시간 참가자 위치")).toBeVisible();

    const player = await playerContext.newPage();
    await player.goto(`${baseUrl}/play/${roomCode}`);
    await player.getByLabel("NICKNAME (OPTIONAL)").fill("브라우저-E2E");
    await player.getByRole("button", { name: "JOIN ARENA" }).click();
    await expect(player.locator(".hud-team em")).toHaveText("브라우저-E2E");
    await expect(player.locator(".connection-chip")).toContainText("CONNECTED");
    const mobileCanvasBox = await player.locator(".mobile-arena-canvas").boundingBox();
    expect(mobileCanvasBox).not.toBeNull();
    expect(Math.abs((mobileCanvasBox?.width ?? 0) - (mobileCanvasBox?.height ?? 0))).toBeLessThanOrEqual(1);
    const assignedTeam = (await player.locator(".hud-team > i").innerText()).trim() as "A" | "B";
    expect(["A", "B"]).toContain(assignedTeam);

    const spectator = await spectatorContext.newPage();
    await spectator.goto(`${baseUrl}/watch/${roomCode}`);
    await expect(spectator.locator(".score-ribbon")).toBeVisible();
    await expect(spectator.locator(".screen-room-id strong")).toHaveText(roomCode);

    await admin.getByRole("button", { name: "게임 시작", exact: true }).click();
    await expect(player.locator(".hud-clock small")).toHaveText("RUNNING");
    await expect(spectator.locator(".match-clock")).toContainText("LIVE");
    await expect(spectator.getByRole("complementary", { name: "실시간 참가자 닉네임" }).getByText("브라우저-E2E", { exact: true })).toBeVisible();

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

    await overviewTab.focus();
    await overviewTab.press("ArrowRight");
    await expect(controlsTab).toHaveAttribute("aria-selected", "true");
    await expect(controlsTab).toBeFocused();
    await expect(admin.getByRole("tabpanel", { name: /봇·부하 제어/ })).toBeVisible();
    await expect(admin.getByRole("heading", { name: "대량 봇 부하 테스트" })).toBeVisible();
    await expect(admin.getByRole("button", { name: "봇 추가", exact: true })).toBeVisible();
    const demoChaosPanel = admin.locator("details.demo-chaos-panel");
    await expect(demoChaosPanel).toBeVisible();
    await demoChaosPanel.locator("summary").click();
    await expect(demoChaosPanel.getByText("실제 런타임", { exact: true }).first()).toBeVisible();
    await expect(demoChaosPanel.getByText("시뮬레이션 · 타임라인 전용", { exact: true }).first()).toBeVisible();
    await expect(demoChaosPanel.getByText("ROOM OWNER", { exact: true })).toBeVisible();
    await expect(demoChaosPanel.getByText(`${roomCode} · playwright-e2e`, { exact: true })).toBeVisible();
    await expect(demoChaosPanel.getByRole("button", { name: "실제 지연 적용" })).toBeEnabled();
    await expect(demoChaosPanel.getByRole("button", { name: "실제 서버 종료 요청" })).toBeDisabled();

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

    await metricsTab.click();
    await expect(metricsTab).toHaveAttribute("aria-selected", "true");
    await expect(admin.getByRole("tabpanel", { name: /운영 지표/ })).toBeVisible();
    const fpsKpi = admin.locator(".ops-kpi-card").filter({ hasText: "게임 화면 FPS P10" });
    await expect(fpsKpi).not.toContainText("표본 대기", { timeout: 10_000 });
    await expect(fpsKpi).toContainText("fps");
    await expect(admin.locator(".metric-chart-card").filter({ hasText: "프레임 누락률 P95" })).toBeVisible();
    const tickHelpButton = admin.getByRole("button", { name: "게임 틱 P95 설명" }).first();
    await tickHelpButton.focus();
    const tickTooltip = tickHelpButton.locator("xpath=following-sibling::*[@role='tooltip']");
    await expect(tickTooltip).toBeVisible();
    await expect(tickTooltip).toContainText("단위");
    await expect(tickTooltip).toContainText("밀리초(ms)");
    await expect(tickTooltip).toContainText("출처");
    await expect(tickTooltip).toContainText("/api/ops");
    await expect(tickTooltip).toContainText("갱신");
    await expect(tickTooltip).toContainText("실제 관측값");

    if (process.env.E2E_CAPTURE_EVIDENCE === "true") {
      await admin.screenshot({ path: "docs/evidence/screenshots/admin-operations-metrics-help.png", fullPage: true, animations: "disabled" });
      await controlsTab.click();
      await demoChaosPanel.locator("summary").click();
      await admin.screenshot({ path: "docs/evidence/screenshots/admin-bot-load-controls.png", fullPage: true, animations: "disabled" });
      await overviewTab.click();
      await admin.screenshot({ path: "docs/evidence/screenshots/admin-live-game-overview.png", fullPage: true, animations: "disabled" });
      await Promise.all([
        player.screenshot({ path: "docs/evidence/screenshots/join-mobile-square-fps.png", fullPage: true, animations: "disabled" }),
        spectator.screenshot({ path: "docs/evidence/screenshots/watch-player-nicknames.png", fullPage: true, animations: "disabled" }),
      ]);
    }
  } finally {
    await closeContexts(contexts);
  }
});
