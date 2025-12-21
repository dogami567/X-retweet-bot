async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof data === "string" ? data : data?.error || data?.message || res.statusText;
    throw new Error(message);
  }
  return data;
}

function byId(id) {
  return document.getElementById(id);
}

function safeJson(obj) {
  return JSON.stringify(obj ?? {}, null, 2);
}

function setJsonBox(obj) {
  byId("apiResponse").textContent = safeJson(obj);
}

function setStatusBadge(status) {
  const el = byId("monitorStatus");
  el.textContent = `监控：${status.running ? "运行中" : "已停止"}`;
  el.className = `badge ${status.running ? "text-bg-success" : "text-bg-secondary"}`;
}

function renderFilterTable(items) {
  const tbody = byId("filterTableBody");
  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-secondary">暂无数据</td></tr>`;
    return;
  }
  tbody.innerHTML = items
    .map((t) => {
      const kind = t.kind || "unknown";
      const badgeClass =
        kind === "original"
          ? "text-bg-success"
          : kind === "retweet"
            ? "text-bg-info"
            : kind === "reply"
              ? "text-bg-warning"
              : kind === "quote"
                ? "text-bg-primary"
                : "text-bg-secondary";
      const text = (t.text || "").replace(/\s+/g, " ").trim();
      const short = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      return `<tr>
        <td><span class="badge ${badgeClass}">${kind}</span></td>
        <td title="${escapeHtml(text)}">${escapeHtml(short)}</td>
        <td class="font-monospace">${escapeHtml(t.id || "")}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadConfig() {
  const { config } = await api("/api/config");
  byId("apiKey").value = config?.twitterApi?.apiKey || "";
  byId("targets").value = (config?.monitor?.targets || []).join("\n");
  byId("pollIntervalSec").value = String(config?.monitor?.pollIntervalSec ?? 60);
  byId("fetchLimit").value = String(config?.monitor?.fetchLimit ?? 20);
  byId("skipMentions").checked = Boolean(config?.monitor?.skipMentions);
  byId("skipQuotes").checked = config?.monitor?.includeQuoteTweets === false;
  byId("forwardEnabled").checked = Boolean(config?.forward?.enabled);
  byId("forwardDryRun").checked = config?.forward?.dryRun === undefined ? true : Boolean(config?.forward?.dryRun);
  byId("forwardMode").value = config?.forward?.mode || "retweet";
  byId("forwardSendIntervalSec").value = String(config?.forward?.sendIntervalSec ?? 5);
  byId("forwardTranslateZh").checked = Boolean(config?.forward?.translateToZh);
  byId("xApiKey").value = config?.forward?.x?.apiKey || "";
  byId("xApiSecret").value = config?.forward?.x?.apiSecret || "";
  byId("xAccessToken").value = config?.forward?.x?.accessToken || "";
  byId("xAccessSecret").value = config?.forward?.x?.accessSecret || "";
  byId("forwardProxy").value = config?.forward?.proxy || "";
}

async function saveConfig() {
  const targets = parseTargets(byId("targets").value);
  const pollIntervalSec = Number(byId("pollIntervalSec").value || 60);
  const fetchLimitRaw = Number(byId("fetchLimit").value || 20);
  const fetchLimit = Number.isFinite(fetchLimitRaw) ? Math.max(1, Math.round(fetchLimitRaw)) : 20;
  const skipMentions = byId("skipMentions").checked;
  const includeQuoteTweets = !byId("skipQuotes").checked;
  const forwardSendIntervalSec = Number(byId("forwardSendIntervalSec").value || 0);

  const payload = {
    twitterApi: { apiKey: byId("apiKey").value.trim() },
    monitor: { targets, pollIntervalSec, fetchLimit, skipMentions, includeQuoteTweets },
    forward: {
      enabled: byId("forwardEnabled").checked,
      dryRun: byId("forwardDryRun").checked,
      mode: byId("forwardMode").value,
      sendIntervalSec: Number.isFinite(forwardSendIntervalSec) ? Math.max(0, forwardSendIntervalSec) : 0,
      translateToZh: byId("forwardTranslateZh").checked,
      proxy: byId("forwardProxy").value.trim(),
      x: {
        apiKey: byId("xApiKey").value.trim(),
        apiSecret: byId("xApiSecret").value.trim(),
        accessToken: byId("xAccessToken").value.trim(),
        accessSecret: byId("xAccessSecret").value.trim(),
      },
    },
  };

  const res = await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
  setJsonBox(res);
}

async function fetchLatest() {
  const username = parseTargets(byId("targets").value)[0] || "";
  const path = username ? `/api/test-fetch?username=${encodeURIComponent(username)}` : "/api/test-fetch";
  const res = await api(path);
  setJsonBox(res);
  renderFilterTable(res?.classifiedTweets || []);
}

async function testPost() {
  const text = byId("postText").value.trim();
  if (!text) throw new Error("请输入要发布的文本");
  const res = await api("/api/test-post", { method: "POST", body: JSON.stringify({ text }) });
  setJsonBox(res);
}

async function testRetweet() {
  const tweetId = byId("retweetId").value.trim();
  if (!tweetId) throw new Error("请输入 tweet_id");
  const res = await api("/api/test-retweet", { method: "POST", body: JSON.stringify({ tweetId }) });
  setJsonBox(res);
}

async function testRepost() {
  const tweetId = byId("repostId").value.trim();
  if (!tweetId) throw new Error("请输入 tweet_id");
  const res = await api("/api/test-repost", { method: "POST", body: JSON.stringify({ tweetId }) });
  setJsonBox(res);
}

async function testXAuth() {
  const res = await api("/api/test-x-auth");
  setJsonBox(res);
}

async function startMonitor() {
  const res = await api("/api/monitor/start", { method: "POST" });
  setJsonBox(res);
}

async function stopMonitor() {
  const res = await api("/api/monitor/stop", { method: "POST" });
  setJsonBox(res);
}

async function runOnce() {
  const res = await api("/api/monitor/run-once", { method: "POST" });
  setJsonBox(res);
}

async function clearQueue() {
  const defaultTarget = parseTargets(byId("targets").value)[0] || "";
  const input = window.prompt("输入要清空的目标账号（可选，留空表示清空全部队列）：", defaultTarget);
  if (input === null) return;
  const target = input.trim().replace(/^@/, "");

  if (!target) {
    const ok = window.confirm("确定要清空全部待处理队列吗？这会丢弃未转发任务。");
    if (!ok) return;
  }

  const res = await api("/api/queue/clear", {
    method: "POST",
    body: JSON.stringify(target ? { target } : {}),
  });
  setJsonBox(res);
  await refreshLogs();
}

async function refreshLogs() {
  const data = await api("/api/logs");
  const lines = (data?.logs || []).map((l) => `[${l.time}] ${l.message}`);
  byId("logBox").textContent = lines.join("\n");
  setStatusBadge(data?.monitor || { running: false });
  byId("statsBar").textContent = `调用次数：${data?.stats?.apiCalls ?? 0} | X 调用：${data?.stats?.xCalls ?? 0} | 翻译：${data?.stats?.translateCalls ?? 0} | 队列：${data?.stats?.queueSize ?? 0}`;
}

function bind(id, event, handler) {
  byId(id).addEventListener(event, async (e) => {
    e.preventDefault();
    try {
      await handler(e);
    } catch (err) {
      setJsonBox({ error: String(err?.message || err) });
    }
  });
}

function parseTargets(text) {
  return String(text || "")
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

bind("configForm", "submit", saveConfig);
bind("btnFetchLatest", "click", fetchLatest);
bind("btnTestPost", "click", testPost);
bind("btnTestRetweet", "click", testRetweet);
bind("btnTestRepost", "click", testRepost);
bind("btnTestXAuth", "click", testXAuth);
bind("btnStartMonitor", "click", startMonitor);
bind("btnStopMonitor", "click", stopMonitor);
bind("btnRunOnce", "click", runOnce);
bind("btnClearQueue", "click", clearQueue);
bind("btnClearLogs", "click", async () => {
  await api("/api/logs/clear", { method: "POST" });
  await refreshLogs();
});

await loadConfig();
await refreshLogs();
setInterval(() => refreshLogs().catch(() => {}), 2000);
