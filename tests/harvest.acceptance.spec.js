const { test, expect } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 3015);
const BASE_URL = `http://localhost:${PORT}`;

async function waitForHarvestDone(request, timeoutMs = 180_000) {
  const startedAt = Date.now();
  let last = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await request.get(`${BASE_URL}/api/bulk/search-harvest/status`);
    last = await res.json();
    const running = Boolean(last?.job?.running);
    if (!running) return last;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`采集超时未结束（>${Math.round(timeoutMs / 1000)}s），last=${JSON.stringify(last)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test.describe("验收：关键词采集真实跑通", () => {
  test.setTimeout(240_000);
  /** @type {any} */
  let restoreConfig = null;

  test("关键词采集 -> 队列新增 -> UI 可见", async ({ page, request }) => {
    // 前置：至少有 1 个账号启用“关注评论”且有 Profile（采集依赖）
    // 如果当前配置缺失，则临时写入一个指向 data/browser-profiles/acc_test 的账号（跑完会自动恢复原配置）。
    const cfgRes = await request.get(`${BASE_URL}/api/bulk/config`);
    const cfg = (await cfgRes.json())?.config || {};
    const originalCfg = JSON.parse(JSON.stringify(cfg || {}));

    const accounts0 = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
    const ok0 = accounts0.find((a) => Boolean(String(a?.x?.profileDir || "").trim()));

    // 采集是“真实验收”，这里不强行篡改用户的代理设置：
    // - 若用户处于需要代理的网络环境，必须依赖用户自己配置的 proxy 才能加载 x.com
    // - 若用户不需要代理，则配置里也应为空
    const patched = JSON.parse(JSON.stringify(cfg || {}));
    if (!Array.isArray(patched.accounts)) patched.accounts = [];

    if (!ok0) {
      patched.accounts.push({
        id: "acc_test",
        name: "acc_test",
        enabled: true,
        dryRun: true,
        proxy: "",
        followCommentersEnabled: true,
        schedule: { intervalMin: 120, jitterMin: 10, imagesMin: 1, imagesMax: 1 },
        x: { apiKey: "", apiSecret: "", accessToken: "", accessSecret: "", profileDir: "data\\\\browser-profiles\\\\acc_test" },
      });
    }

    patched.accounts = patched.accounts.map((a) => {
      const hasProfile = Boolean(String(a?.x?.profileDir || "").trim());
      if (!hasProfile) return a;
      // 采集需要“关注评论”开关为 true（复用同一套账号/登录态）
      return { ...a, followCommentersEnabled: true };
    });

    const save = await request.post(`${BASE_URL}/api/bulk/config`, { data: patched, headers: { "Content-Type": "application/json" } });
    expect(save.ok(), "写入临时 bulk config 失败").toBeTruthy();
    restoreConfig = originalCfg;

    // 清空队列，确保验收结果可见（不会影响采集的“每天去重”逻辑）
    await request.post(`${BASE_URL}/api/bulk/follow-urls/clear`, { data: {}, headers: { "Content-Type": "application/json" } });

    await page.goto("/bulk.html", { waitUntil: "domcontentloaded" });

    // 使用你截图里的关键词，模式选“最新”，每词抓少一点避免太慢
    await page.locator("#harvestKeywordsText").fill("互关");
    await page.locator("#harvestMode").selectOption("live");
    await page.locator("#harvestLimitPerKeyword").fill("5");
    // 不自动开始关注，只做采集验收
    const autoStart = page.locator("#harvestAutoStart");
    if (await autoStart.isChecked()) await autoStart.uncheck();

    await page.locator("#btnHarvestOnce").click();

    const done = await waitForHarvestDone(request, 180_000);
    const lastErr = String(done?.harvest?.lastError || done?.job?.lastError || "").trim();
    expect(lastErr, `采集失败：${lastErr || "(unknown)"}`).toBe("");

    const afterRes = await request.get(`${BASE_URL}/api/bulk/follow-urls?limit=2000`);
    const after = await afterRes.json();
    const afterTotal = Number(after?.total ?? 0);
    expect(afterTotal, "采集完成但队列仍为空（可能未登录导致无法访问搜索结果）").toBeGreaterThan(0);

    // UI 刷新队列并截图留证
    await page.locator("#btnFollowUrlsRefresh").click();
    await expect(page.locator("#followUrlsList")).toBeVisible();

    await page.screenshot({ path: "test-results/acceptance-harvest-result.png", fullPage: true });
  });

  test.afterEach(async ({ request }, testInfo) => {
    if (!restoreConfig) return;
    await request.post(`${BASE_URL}/api/bulk/config`, { data: restoreConfig, headers: { "Content-Type": "application/json" } });
    restoreConfig = null;
  });
});
