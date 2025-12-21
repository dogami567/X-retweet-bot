import "dotenv/config";
import { spawn } from "node:child_process";

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

async function httpJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        port = Number(m[1]);
        break;
      }
    }
    if (port) return port;
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

async function main() {
  const apiKey = envFirst("TWITTERAPI_IO_KEY", "TWITTERAPI_IO_API_KEY");
  if (!apiKey) {
    console.error("缺少 TWITTERAPI_IO_KEY（或 TWITTERAPI_IO_API_KEY），请先在 .env 中填入你的 key");
    process.exit(1);
  }

  const username = pickUsername();
  const timeoutMs = Number(envString("SMOKE_TIMEOUT_MS", "45000")) || 45000;
  const requestedPort = Number(envString("SMOKE_PORT", "0"));

  const child = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(requestedPort),
    },
  });

  child.stderr?.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  let port;
  try {
    port = await waitForListening(child, timeoutMs);
    console.log(`[SMOKE] Server started on port ${port}`);

    const fetchRes = await httpJson(`http://localhost:${port}/api/test-fetch?username=${encodeURIComponent(username)}`);
    console.log(`[SMOKE] /api/test-fetch status=${fetchRes.status}`);
    if (!fetchRes.ok) {
      console.error(fetchRes.json);
      process.exitCode = 1;
      return;
    }

    const upstream = fetchRes.json?.httpStatus;
    const ok = fetchRes.json?.ok === true;
    console.log(`[SMOKE] upstream httpStatus=${upstream} ok=${ok}`);
    console.log(`[SMOKE] classifiedTweets=${(fetchRes.json?.classifiedTweets || []).length}`);

    const logsRes = await httpJson(`http://localhost:${port}/api/logs`);
    console.log(`[SMOKE] /api/logs status=${logsRes.status} logs=${(logsRes.json?.logs || []).length}`);

    if (!ok) {
      console.error(fetchRes.json);
      process.exitCode = 1;
      return;
    }

    if (typeof upstream === "number" && upstream >= 400) {
      console.error(fetchRes.json);
      process.exitCode = 1;
      return;
    }
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    child.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(`[SMOKE] 失败：${e?.message || e}`);
  process.exit(1);
});
