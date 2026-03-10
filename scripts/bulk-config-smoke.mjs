import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(url, init) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function assert(condition, message) {
  if (condition) return;
  throw new Error(message);
}

async function waitForListening(child, timeoutMs) {
  const startedAt = Date.now();
  let buffer = "";

  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
  });

  while (Date.now() - startedAt < timeoutMs) {
    const match = buffer.match(/http:\/\/localhost:(\d+)/);
    if (match) return Number(match[1]);
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const bulkCfgPath = path.join(repoRoot, "data", "bulk_config.json");
  const bulkCfgBackup = await readFileIfExists(bulkCfgPath);

  const child = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: "0",
    },
  });

  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  try {
    const port = await waitForListening(child, 30_000);
    const base = `http://localhost:${port}`;

    const emptySave = await httpJson(`${base}/api/bulk/config`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert(emptySave.ok, `保存空 bulk config 失败: status=${emptySave.status}`);
    const emptyCfg = emptySave.json?.config || {};
    assert(Array.isArray(emptyCfg.followUrls) && emptyCfg.followUrls.length === 0, "空配置默认 followUrls 应为空数组");
    assert(Number(emptyCfg.followWaitSec) === 18, `空配置默认 followWaitSec 异常: ${emptyCfg.followWaitSec}`);
    assert(Number(emptyCfg.followIdleSleepSec) === 30, `空配置默认 followIdleSleepSec 异常: ${emptyCfg.followIdleSleepSec}`);
    assert(emptyCfg.followRequireVerified === false, "空配置默认 followRequireVerified 应为 false");
    assert(emptyCfg.followRequireChineseBio === false, "空配置默认 followRequireChineseBio 应为 false");

    const legacyPayload = {
      imageDir: "data/bulk-images",
      tweetUrl: "https://x.com/ExampleUser/status/1234567890123456789",
      followUrls: [],
      followActionDelaySec: 9999,
      followCooldownEvery: -3,
      followCooldownSec: 7201,
      followIdleSleepSec: 1,
      followRequireVerified: true,
      followRequireChineseBio: true,
      captions: "hello\nworld",
      accounts: [],
    };

    const save = await httpJson(`${base}/api/bulk/config`, {
      method: "POST",
      body: JSON.stringify(legacyPayload),
    });
    assert(save.ok, `保存 legacy bulk config 失败: status=${save.status}`);

    const cfg = save.json?.config || {};
    const followUrls = Array.isArray(cfg.followUrls) ? cfg.followUrls : [];
    assert(followUrls.length === 1, `legacy tweetUrl 未迁移到 followUrls，actual=${followUrls.length}`);
    assert(followUrls[0] === "https://x.com/ExampleUser/status/1234567890123456789", `followUrls 归一化结果异常: ${followUrls[0] || "(empty)"}`);
    assert(!Object.prototype.hasOwnProperty.call(cfg, "tweetUrl"), "返回配置仍包含 legacy tweetUrl");
    assert(Number(cfg.followActionDelaySec) === 600, `followActionDelaySec 未按上限裁剪: ${cfg.followActionDelaySec}`);
    assert(Number(cfg.followCooldownEvery) === 0, `followCooldownEvery 未按下限裁剪: ${cfg.followCooldownEvery}`);
    assert(Number(cfg.followCooldownSec) === 3600, `followCooldownSec 未按上限裁剪: ${cfg.followCooldownSec}`);
    assert(Number(cfg.followIdleSleepSec) === 5, `followIdleSleepSec 未按下限裁剪: ${cfg.followIdleSleepSec}`);
    assert(cfg.followRequireVerified === true, "followRequireVerified 未返回 true");
    assert(cfg.followRequireChineseBio === true, "followRequireChineseBio 未返回 true");
    assert(Array.isArray(cfg.captions) && cfg.captions.length === 2, "captions 字符串未正确拆分");

    const reread = await httpJson(`${base}/api/bulk/config`);
    assert(reread.ok, `重新读取 bulk config 失败: status=${reread.status}`);
    const rereadCfg = reread.json?.config || {};
    assert(JSON.stringify(rereadCfg.followUrls || []) === JSON.stringify(followUrls), "重复读取后 followUrls 漂移");
    assert(!Object.prototype.hasOwnProperty.call(rereadCfg, "tweetUrl"), "重复读取后仍包含 legacy tweetUrl");

    const longUrls = [];
    for (let i = 0; i < 2005; i += 1) {
      const statusId = String(1234567890123456000n + BigInt(i));
      longUrls.push(`https://x.com/example/status/${statusId}`);
      if (i < 10) longUrls.push(`https://x.com/example/status/${statusId}`);
    }
    longUrls.push("https://x.com/not-status");

    const longSave = await httpJson(`${base}/api/bulk/config`, {
      method: "POST",
      body: JSON.stringify({ ...legacyPayload, tweetUrl: "", followUrls: longUrls }),
    });
    assert(longSave.ok, `保存超长 bulk config 失败: status=${longSave.status}`);
    const longCfg = longSave.json?.config || {};
    const normalizedUrls = Array.isArray(longCfg.followUrls) ? longCfg.followUrls : [];
    assert(normalizedUrls.length === 2000, `followUrls 未按 2000 上限裁剪: ${normalizedUrls.length}`);
    assert(normalizedUrls[0] === "https://x.com/example/status/1234567890123456000", `followUrls 首项归一化异常: ${normalizedUrls[0] || "(empty)"}`);
    assert(!normalizedUrls.includes("https://x.com/not-status"), "非法 URL 不应保留在 followUrls 中");

    console.log(`[BULK-CONFIG-SMOKE] ok port=${port} followUrl=${followUrls[0]} capped=${normalizedUrls.length}`);
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    child.kill("SIGKILL");

    if (bulkCfgBackup) {
      await fs.mkdir(path.dirname(bulkCfgPath), { recursive: true });
      await fs.writeFile(bulkCfgPath, bulkCfgBackup);
    }
  }
}

main().catch((error) => {
  console.error(`[BULK-CONFIG-SMOKE] 失败: ${error?.message || error}`);
  process.exit(1);
});
