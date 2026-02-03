const { test, expect } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 3015);
const BASE_URL = `http://localhost:${PORT}`;

test.describe("X-Bulk 面板", () => {
  /** @type {any} */
  let originalBulkConfig = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/bulk/config`);
    originalBulkConfig = (await res.json())?.config ?? null;
  });

  test.afterAll(async ({ request }) => {
    if (!originalBulkConfig) return;
    await request.post(`${BASE_URL}/api/bulk/config`, {
      data: originalBulkConfig,
      headers: { "Content-Type": "application/json" },
    });
  });

  test("bulk.html 能打开且关键控件存在", async ({ page }) => {
    await page.goto("/bulk.html", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("账号管理")).toBeVisible();
    await expect(page.getByText("关注评论用户")).toBeVisible();

    // URL 队列
    await expect(page.locator("#followUrlsInput")).toBeVisible();
    await expect(page.locator("#btnFollowUrlsAdd")).toBeVisible();
    await expect(page.locator("#btnFollowUrlsSet")).toBeVisible();
    await expect(page.locator("#btnFollowUrlsClear")).toBeVisible();
    await expect(page.locator("#followUrlsList")).toBeVisible();

    // 关键词采集（最新/热门）
    await expect(page.locator("#harvestKeywordsText")).toBeVisible();
    await expect(page.locator("#harvestMode")).toBeVisible();
    await expect(page.locator("#harvestLimitPerKeyword")).toBeVisible();
    await expect(page.locator("#btnHarvestOnce")).toBeVisible();
    await expect(page.locator("#btnHarvestAndStart")).toBeVisible();
    await expect(page.locator("#btnHarvestStatus")).toBeVisible();

    // 访问节流
    await expect(page.locator("#followVisitCooldownEvery")).toBeVisible();
    await expect(page.locator("#followVisitCooldownSec")).toBeVisible();
  });

  test("队列：覆盖队列后列表出现链接", async ({ page }) => {
    await page.goto("/bulk.html", { waitUntil: "domcontentloaded" });

    const sample = "https://x.com/i/status/1234567890123456789";
    await page.locator("#followUrlsInput").fill(sample);
    await page.locator("#btnFollowUrlsSet").click();

    // 刷新队列并校验列表出现
    await page.locator("#btnFollowUrlsRefresh").click();
    await expect(page.locator("#followUrlsList")).toContainText(sample);
  });

  test("采集接口：空关键词会返回可读错误（不应卡死）", async ({ page }) => {
    await page.goto("/bulk.html", { waitUntil: "domcontentloaded" });

    await page.locator("#harvestKeywordsText").fill("");
    await page.locator("#btnHarvestOnce").click();

    // apiResponse 输出框应包含错误信息
    await expect(page.locator("#apiResponse")).toContainText("error", { ignoreCase: true });
  });

  test("关注启动：无可执行账号时返回提示", async ({ request }) => {
    // 直接用 API 把所有账号的“关注评论”关闭，确保 start 会在后端早期返回 400（不会启动 Puppeteer）
    test.skip(!originalBulkConfig, "缺少原始 bulk config");

    const disabled = JSON.parse(JSON.stringify(originalBulkConfig));
    disabled.accounts = Array.isArray(disabled.accounts) ? disabled.accounts : [];
    disabled.accounts = disabled.accounts.map((a) => ({ ...a, followCommentersEnabled: false }));

    const save = await request.post(`${BASE_URL}/api/bulk/config`, {
      data: disabled,
      headers: { "Content-Type": "application/json" },
    });
    expect(save.ok()).toBeTruthy();

    const start = await request.post(`${BASE_URL}/api/bulk/follow-commenters/start`, {
      data: { maxPerAccount: 30, followWaitSec: 18, followConcurrency: 1, followJitterSec: 0 },
      headers: { "Content-Type": "application/json" },
    });
    expect(start.status()).toBe(400);
    const body = await start.json();
    expect(String(body?.error || "")).toContain("没有可执行账号");
  });
});
