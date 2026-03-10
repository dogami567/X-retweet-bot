const fs = require("node:fs/promises");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 3015);
const BASE_URL = `http://localhost:${PORT}`;
const ACCOUNT_ID = "acc_hot_update";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE0S8wAAAAASUVORK5CYII=",
  "base64",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function buildDryRunAccount() {
  return {
    id: ACCOUNT_ID,
    name: ACCOUNT_ID,
    enabled: true,
    dryRun: true,
    followCommentersEnabled: false,
    proxy: "",
    schedule: { intervalMin: 120, jitterMin: 0, imagesMin: 1, imagesMax: 1 },
    x: { apiKey: "", apiSecret: "", accessToken: "", accessSecret: "", profileDir: "" },
  };
}

function buildConfig(baseConfig, imageDir, overrides = {}) {
  const next = clone(baseConfig);
  next.imageDir = imageDir;
  next.scanIntervalSec = 300;
  next.accounts = [buildDryRunAccount()];
  if (overrides.captions !== undefined) next.captions = overrides.captions;
  if (overrides.accounts !== undefined) next.accounts = overrides.accounts;
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "captions" || key === "accounts") continue;
    next[key] = value;
  }
  return next;
}

async function getJson(request, apiPath) {
  const res = await request.get(`${BASE_URL}${apiPath}`);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { ok: res.ok(), status: res.status(), json };
}

async function postJson(request, apiPath, data = {}) {
  const res = await request.post(`${BASE_URL}${apiPath}`, {
    data,
    headers: { "Content-Type": "application/json" },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { ok: res.ok(), status: res.status(), json };
}

function findAccount(statusPayload, accountId = ACCOUNT_ID) {
  const accounts = Array.isArray(statusPayload?.accounts) ? statusPayload.accounts : [];
  return accounts.find((item) => String(item?.id || "").trim() === accountId) || null;
}

test.describe("Bulk 内容池热更新", () => {
  /** @type {any} */
  let originalBulkConfig = null;
  /** @type {string[]} */
  let tempDirs = [];

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/bulk/config`);
    originalBulkConfig = (await res.json())?.config ?? null;
  });

  test.afterEach(async ({ request }) => {
    await postJson(request, "/api/bulk/stop", {});
    await postJson(request, "/api/bulk/logs/clear", {});

    if (originalBulkConfig) {
      await postJson(request, "/api/bulk/config", clone(originalBulkConfig));
    }

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  test("保存内容池时运行中调度不中断，且新文案立即可用", async ({ request }, testInfo) => {
    test.skip(!originalBulkConfig, "缺少原始 bulk config");

    const imageDir = path.join(process.cwd(), "test-results", `bulk-hot-update-${testInfo.workerIndex}-${Date.now()}-captions`);
    tempDirs.push(imageDir);
    await fs.mkdir(imageDir, { recursive: true });

    const initialConfig = buildConfig(originalBulkConfig, imageDir, { captions: ["old caption"] });
    const save0 = await postJson(request, "/api/bulk/config", initialConfig);
    expect(save0.ok, "写入初始热更新配置失败").toBeTruthy();

    const started = await postJson(request, "/api/bulk/start", {});
    expect(started.ok, "启动 bulk scheduler 失败").toBeTruthy();

    const status0 = await getJson(request, "/api/bulk/status");
    expect(status0.ok).toBeTruthy();
    expect(Boolean(status0.json?.running)).toBeTruthy();
    const account0 = findAccount(status0.json);
    const nextPostAt0 = String(account0?.state?.nextPostAt || "");
    expect(nextPostAt0, "启动后未生成 nextPostAt").not.toBe("");

    await postJson(request, "/api/bulk/logs/clear", {});

    const updatedConfig = buildConfig(initialConfig, imageDir, { captions: ["new caption"] });
    const save1 = await postJson(request, "/api/bulk/config", updatedConfig);
    expect(save1.ok, "运行中保存新文案失败").toBeTruthy();

    const status1 = await getJson(request, "/api/bulk/status");
    expect(status1.ok).toBeTruthy();
    expect(Boolean(status1.json?.running)).toBeTruthy();
    const account1 = findAccount(status1.json);
    expect(String(account1?.state?.nextPostAt || "")).toBe(nextPostAt0);

    const logs = await getJson(request, "/api/bulk/logs");
    expect(logs.ok).toBeTruthy();
    const messages = Array.isArray(logs.json?.logs) ? logs.json.logs.map((item) => String(item?.message || "")) : [];
    expect(messages.some((msg) => msg.includes("批量发帖已停止"))).toBeFalsy();
    expect(messages.some((msg) => msg.includes("批量发帖已启动"))).toBeFalsy();

    const runOnce = await postJson(request, "/api/bulk/run-once", { accountId: ACCOUNT_ID });
    expect(runOnce.ok, `run-once 失败: ${JSON.stringify(runOnce.json)}`).toBeTruthy();
    expect(Boolean(runOnce.json?.result?.dryRun)).toBeTruthy();
    expect(String(runOnce.json?.result?.caption || "")).toBe("new caption");
  });

  test("半成品图片不会被选中，内容缺失时返回 skip", async ({ request }, testInfo) => {
    test.skip(!originalBulkConfig, "缺少原始 bulk config");

    const imageDir = path.join(process.cwd(), "test-results", `bulk-hot-update-${testInfo.workerIndex}-${Date.now()}-images`);
    tempDirs.push(imageDir);
    await fs.mkdir(imageDir, { recursive: true });

    const cfg = buildConfig(originalBulkConfig, imageDir, { captions: [] });
    const save0 = await postJson(request, "/api/bulk/config", cfg);
    expect(save0.ok, "写入图片热更新配置失败").toBeTruthy();

    const started = await postJson(request, "/api/bulk/start", {});
    expect(started.ok, "启动 bulk scheduler 失败").toBeTruthy();

    const freshImage = path.join(imageDir, "fresh.png");
    await fs.writeFile(freshImage, PNG_1X1);

    const refresh0 = await postJson(request, "/api/bulk/images/refresh", {});
    expect(refresh0.ok).toBeTruthy();
    expect(Number(refresh0.json?.count ?? -1)).toBe(0);

    const skippedRun = await postJson(request, "/api/bulk/run-once", { accountId: ACCOUNT_ID });
    expect(skippedRun.ok, `run-once 跳过校验失败: ${JSON.stringify(skippedRun.json)}`).toBeTruthy();
    expect(Boolean(skippedRun.json?.result?.skipped)).toBeTruthy();
    expect(["empty", "empty_media_unavailable"]).toContain(String(skippedRun.json?.result?.reason || ""));

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const refresh1 = await postJson(request, "/api/bulk/images/refresh", {});
    expect(refresh1.ok).toBeTruthy();
    expect(Number(refresh1.json?.count ?? -1)).toBe(1);

    const status1 = await getJson(request, "/api/bulk/status");
    expect(status1.ok).toBeTruthy();
    expect(Boolean(status1.json?.running)).toBeTruthy();

    const readyRun = await postJson(request, "/api/bulk/run-once", { accountId: ACCOUNT_ID });
    expect(readyRun.ok, `稳定图片 run-once 失败: ${JSON.stringify(readyRun.json)}`).toBeTruthy();
    expect(Boolean(readyRun.json?.result?.dryRun)).toBeTruthy();
    expect(Array.isArray(readyRun.json?.result?.images) ? readyRun.json.result.images : []).toContain("fresh.png");
  });
});
