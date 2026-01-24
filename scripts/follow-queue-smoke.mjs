import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function waitForListening(child, timeoutMs) {
  const startedAt = Date.now();
  let port = null;
  let buffer = "";

  child.stdout?.on("data", (d) => {
    buffer += d.toString();
  });

  while (Date.now() - startedAt < timeoutMs) {
    const m = buffer.match(/http:\/\/localhost:(\d+)/);
    if (m) {
      port = Number(m[1]);
      break;
    }
    await sleep(100);
  }
  if (!port) throw new Error("等待服务启动超时");
  return port;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (condition) return;
  throw new Error(message);
}

async function waitUntil(timeoutMs, fn) {
  const startedAt = Date.now();
  let lastErr = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const ok = await fn();
      if (ok) return;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  if (lastErr) throw lastErr;
  throw new Error("等待超时");
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

  child.stderr?.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  let port;
  try {
    port = await waitForListening(child, 30_000);
    const base = `http://localhost:${port}`;

    await httpJson(`${base}/api/bulk/logs/clear`, { method: "POST", body: "{}" });

    const cfg0 = await httpJson(`${base}/api/bulk/config`);
    assert(cfg0.ok && cfg0.json?.config, "读取 bulk config 失败");

    // 保证本脚本不会意外触发浏览器：强制 followUrls 为空
    const cfgNoUrls = { ...cfg0.json.config, followUrls: [] };
    const save0 = await httpJson(`${base}/api/bulk/config`, { method: "POST", body: JSON.stringify(cfgNoUrls) });
    assert(save0.ok, "保存 followUrls=[] 失败");

    const start = await httpJson(`${base}/api/bulk/follow-commenters/start`, { method: "POST", body: "{}" });
    assert(start.ok && start.json?.ok === true, "启动关注队列失败");

    await sleep(800);
    const st1 = await httpJson(`${base}/api/bulk/follow-commenters/status`);
    assert(st1.ok && st1.json?.ok === true, "读取关注状态失败");

    const q1 = st1.json?.queue || {};
    assert(typeof q1.urlsTotal === "number", "status.queue.urlsTotal 缺失");
    assert(q1.sleepRemainingSec !== undefined, "status.queue.sleepRemainingSec 缺失");
    assert(q1.cooldownRemainingSec !== undefined, "status.queue.cooldownRemainingSec 缺失");

    await httpJson(`${base}/api/bulk/follow-commenters/stop`, { method: "POST", body: "{}" });
    await waitUntil(5000, async () => {
      const st = await httpJson(`${base}/api/bulk/follow-commenters/status`);
      return Boolean(st.json?.job?.running) === false;
    });

    const bad = await httpJson(`${base}/api/bulk/follow-urls/add`, { method: "POST", body: JSON.stringify({ text: "https://x.com/xx" }) });
    assert(bad.status === 400, "非法 URL 应返回 400");
    assert(String(bad.json?.error || "").includes("/status/"), "非法 URL 错误信息不包含 /status/");

    console.log(`[FOLLOW-QUEUE-SMOKE] ok port=${port} queue_urls_total=${q1.urlsTotal}`);
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

main().catch((e) => {
  console.error(`[FOLLOW-QUEUE-SMOKE] 失败：${e?.message || e}`);
  process.exit(1);
});

