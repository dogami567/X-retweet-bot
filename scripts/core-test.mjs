import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envString(name, fallback = "") {
  return (process.env[name] ?? fallback).toString().trim();
}

function envFirst(...names) {
  for (const name of names) {
    const v = envString(name);
    if (v) return v;
  }
  return "";
}

function pickUsername() {
  const direct = envString("SMOKE_USERNAME");
  if (direct) return direct.replace(/^@/, "");

  const targets = envString("MONITOR_TARGETS");
  if (targets) {
    const first = targets
      .split(/[\n,]/g)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) return first.replace(/^@/, "");
  }

  return "elonmusk";
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

async function main() {
  const apiKey = envFirst("TWITTERAPI_IO_KEY", "TWITTERAPI_IO_API_KEY");
  if (!apiKey) {
    console.error("缺少 TWITTERAPI_IO_KEY（或 TWITTERAPI_IO_API_KEY），请先在 .env 中填入你的 key");
    process.exit(1);
  }

  const username = pickUsername();
  const timeoutMs = Number(envString("SMOKE_TIMEOUT_MS", "45000")) || 45000;

  const repoRoot = path.resolve(process.cwd());
  const dbPath = path.join(repoRoot, "data", "monitor_db.json");
  const dbBackup = await readFileIfExists(dbPath);
  const configPath = path.join(repoRoot, "data", "config.json");
  const configBackup = await readFileIfExists(configPath);

  // 保证核心链路可重复：把测试账号的 lastSeen 归零，避免因为本地 DB 已更新导致“未发现新推文”
  const freshDb = {
    version: 1,
    targets: {
      [username]: { lastSeenId: "0", forwardedIds: [], failedIds: [] },
    },
    queue: [],
  };
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(freshDb, null, 2), "utf8");

  const freshConfig = { twitterApi: {}, monitor: {}, forward: {} };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(freshConfig, null, 2), "utf8");

  const child = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: "0",
      MONITOR_TARGETS: username,
      FORWARD_ENABLED: "true",
      FORWARD_DRY_RUN: "true",
      FORWARD_SEND_INTERVAL_SEC: "0",
      MONITOR_SKIP_MENTIONS: "false",
    },
  });

  child.stderr?.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  let port;
  try {
    port = await waitForListening(child, timeoutMs);
    console.log(`[CORE] Server started on port ${port}`);

    await httpJson(`http://localhost:${port}/api/logs/clear`, { method: "POST" });

    const run1 = await httpJson(`http://localhost:${port}/api/monitor/run-once`, { method: "POST" });
    console.log(`[CORE] run-once#1 status=${run1.status} ok=${run1.json?.ok}`);
    if (!run1.ok) {
      console.error(run1.json);
      process.exitCode = 1;
      return;
    }

    const logs1 = await httpJson(`http://localhost:${port}/api/logs`);
    const lines1 = (logs1.json?.logs || []).map((l) => `[${l.time}] ${l.message}`);
    const dryRunLines1 = lines1.filter((l) => l.includes("[DRY-RUN]"));
    const queueSize1 = logs1.json?.stats?.queueSize;

    console.log(`[CORE] dry-run logs=${dryRunLines1.length} queueSize=${queueSize1}`);
    if (dryRunLines1.length === 0) {
      console.error("[CORE] 未发现 DRY-RUN 转发日志，核心链路可能未跑通");
      process.exitCode = 1;
      return;
    }
    if (queueSize1 !== 0) {
      console.error("[CORE] 队列未清空，说明未完成处理");
      process.exitCode = 1;
      return;
    }

    const run2 = await httpJson(`http://localhost:${port}/api/monitor/run-once`, { method: "POST" });
    console.log(`[CORE] run-once#2 status=${run2.status} ok=${run2.json?.ok}`);
    if (!run2.ok) {
      console.error(run2.json);
      process.exitCode = 1;
      return;
    }

    const logs2 = await httpJson(`http://localhost:${port}/api/logs`);
    const queueSize2 = logs2.json?.stats?.queueSize;
    console.log(`[CORE] queueSize after run#2 = ${queueSize2}`);
    if (queueSize2 !== 0) {
      console.error("[CORE] 第二次 run-once 后队列仍非 0，去重/lastSeen 逻辑可能有问题");
      process.exitCode = 1;
      return;
    }
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    child.kill("SIGKILL");

    if (dbBackup) {
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.writeFile(dbPath, dbBackup);
    }

    if (configBackup) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configBackup);
    }
  }
}

main().catch((e) => {
  console.error(`[CORE] 失败：${e?.message || e}`);
  process.exit(1);
});
