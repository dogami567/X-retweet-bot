async function api(path, options = {}) {
  const res = await fetch(path, {
    cache: "no-store",
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

function showLogsTab() {
  const trigger = document.querySelector('a[data-bs-toggle="tab"][href="#tabLogs"]');
  if (!trigger) return;

  try {
    if (window.bootstrap && bootstrap.Tab) bootstrap.Tab.getOrCreateInstance(trigger).show();
    else trigger.click();
  } catch {
    try {
      trigger.click();
    } catch {}
  }
}

function safeJson(obj) {
  return JSON.stringify(obj ?? {}, null, 2);
}

function setJsonBox(obj) {
  byId("apiResponse").textContent = safeJson(obj);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isImageName(name) {
  const n = String(name || "").toLowerCase();
  return n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".gif") || n.endsWith(".webp");
}

function isLikelyImageFile(file) {
  const f = file || {};
  if (f.type && String(f.type).toLowerCase().startsWith("image/")) return true;
  return isImageName(f.name);
}

let config = { version: 1, imageDir: "", scanIntervalSec: 3600, followWaitSec: 18, followConcurrency: 1, followJitterSec: 4, captions: [], accounts: [] };
let selectedAccountId = "";
let selectedCaptionIndex = -1;
let uploadPreviewObjectUrls = [];
let autoUploadTimer = null;
let uploadInProgress = false;
let lastGalleryCount = null;
let lastGalleryDir = "";

function getSelectedAccount() {
  return (config.accounts || []).find((a) => a.id === selectedAccountId) || null;
}

function setRunningBadge(running) {
  const dot = byId("statusDot");
  const text = byId("bulkRunningText");
  const btnStart = byId("btnBulkStart");
  const btnStop = byId("btnBulkStop");

  if (running) {
    dot.className = "status-indicator running";
    text.textContent = "运行中";
    text.className = "small fw-bold text-success";
    btnStart.disabled = true;
    btnStop.disabled = false;
  } else {
    dot.className = "status-indicator stopped";
    text.textContent = "已停止";
    text.className = "small fw-medium text-secondary";
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
}

function renderAccountsList() {
  const list = byId("accountList");
  const items = config.accounts || [];
  if (items.length === 0) {
    list.innerHTML = `<div class="p-3 text-center text-muted small">暂无账号</div>`;
    selectedAccountId = "";
    renderAccountForm();
    return;
  }

  if (!selectedAccountId || !items.some((a) => a.id === selectedAccountId)) {
    selectedAccountId = items[0].id;
  }

  list.innerHTML = items
    .map((a) => {
      const active = a.id === selectedAccountId ? "active" : "";
      const name = a.name || a.id;
      const statusIcon = a.enabled ? `<i class="bi bi-circle-fill text-success" style="font-size: 8px;"></i>` : `<i class="bi bi-circle-fill text-secondary" style="font-size: 8px;"></i>`;
      const dryBadge = a.dryRun ? `<span class="badge bg-warning text-dark ms-1" style="font-size: 9px;">DRY</span>` : "";
      const followBadge = a.followCommentersEnabled
        ? `<span class="badge bg-info text-dark ms-1" style="font-size: 9px;" title="该账号会参与“关注评论用户”任务">FOL</span>`
        : "";
      
      return `<button type="button" class="list-group-item list-group-item-action ${active}" data-id="${escapeHtml(a.id)}">
        <div class="d-flex w-100 justify-content-between align-items-center">
            <div class="text-truncate flex-grow-1 fw-medium" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
            <div class="d-flex align-items-center gap-1 ms-2">
                ${dryBadge}
                ${followBadge}
                ${statusIcon}
            </div>
        </div>
        <div class="small text-muted mono text-truncate opacity-75" style="font-size: 10px;">${escapeHtml(a.id)}</div>
      </button>`;
    })
    .join("");

  list.querySelectorAll("[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedAccountId = btn.getAttribute("data-id") || "";
      renderAccountsList();
    });
  });

  renderAccountForm();
}

function renderAccountForm() {
  const a = getSelectedAccount();
  const disabled = !a;

  // Header / Actions
  byId("btnTestXAuth").disabled = disabled;
  byId("btnRunOnce").disabled = disabled;
  byId("btnDeleteAccount").disabled = disabled;

  // Fields
  byId("accId").value = a?.id || "";
  byId("accName").value = a?.name || "";
  byId("accEnabled").checked = Boolean(a?.enabled);
  byId("accDryRun").checked = a?.dryRun === undefined ? true : Boolean(a?.dryRun);
  byId("accFollowCommentersEnabled").checked = Boolean(a?.followCommentersEnabled);
  byId("accProxy").value = a?.proxy || "";

  byId("accIntervalMin").value = String(a?.schedule?.intervalMin ?? 120);
  const jitterMinFallback =
    a?.schedule?.jitterMin ?? (a?.schedule?.jitterSec !== undefined ? Math.round(Number(a.schedule.jitterSec || 0) / 60) : 10);
  byId("accJitterMin").value = String(jitterMinFallback ?? 10);
  byId("accImagesMin").value = String(a?.schedule?.imagesMin ?? 1);
  byId("accImagesMax").value = String(a?.schedule?.imagesMax ?? 4);

  byId("xApiKey").value = a?.x?.apiKey || "";
  byId("xApiSecret").value = a?.x?.apiSecret || "";
  byId("xAccessToken").value = a?.x?.accessToken || "";
  byId("xAccessSecret").value = a?.x?.accessSecret || "";
  byId("xProfileDir").value = a?.x?.profileDir || "";

  // Disable inputs if no account selected
  const inputs = byId("accountForm").querySelectorAll("input,textarea,select,button");
  inputs.forEach((el) => {
      el.disabled = disabled;
  });
}

function applyAccountFormToConfig() {
  const a = getSelectedAccount();
  if (!a) return;

  a.name = byId("accName").value.trim();
  a.enabled = byId("accEnabled").checked;
  a.dryRun = byId("accDryRun").checked;
  a.followCommentersEnabled = byId("accFollowCommentersEnabled").checked;
  a.proxy = byId("accProxy").value.trim();

  a.schedule = a.schedule || {};
  a.schedule.intervalMin = Number(byId("accIntervalMin").value || 120);
  a.schedule.jitterMin = Number(byId("accJitterMin").value || 0);
  a.schedule.imagesMin = Number(byId("accImagesMin").value || 0);
  a.schedule.imagesMax = Number(byId("accImagesMax").value || 0);

  a.x = a.x || {};
  a.x.apiKey = byId("xApiKey").value.trim();
  a.x.apiSecret = byId("xApiSecret").value.trim();
  a.x.accessToken = byId("xAccessToken").value.trim();
  a.x.accessSecret = byId("xAccessSecret").value.trim();
  a.x.profileDir = byId("xProfileDir").value.trim();
}

function applyBaseFormToConfig() {
  config.imageDir = byId("imageDir").value.trim();
  config.scanIntervalSec = Number(byId("scanIntervalSec").value || 3600);
  config.followWaitSec = Number(byId("followWaitSec")?.value || 18);
  config.followConcurrency = Number(byId("followConcurrency")?.value || 1);
  config.followJitterSec = Number(byId("followJitterSec")?.value || 4);
}

function renderBaseForm() {
  byId("imageDir").value = config.imageDir || "";
  byId("scanIntervalSec").value = String(config.scanIntervalSec ?? 3600);
  const followWaitEl = byId("followWaitSec");
  if (followWaitEl) followWaitEl.value = String(config.followWaitSec ?? 18);
  const followConcEl = byId("followConcurrency");
  if (followConcEl) followConcEl.value = String(config.followConcurrency ?? 1);
  const followJitterEl = byId("followJitterSec");
  if (followJitterEl) followJitterEl.value = String(config.followJitterSec ?? 4);
}

function renderCaptionList() {
  const list = byId("captionList");
  const items = Array.isArray(config.captions) ? config.captions : [];
  byId("captionCount").textContent = `${items.length}`;

  if (items.length === 0) {
    list.innerHTML = `<div class="p-2 text-center text-muted small">暂无文案</div>`;
    selectedCaptionIndex = -1;
    byId("captionEditor").value = "";
    return;
  }

  if (selectedCaptionIndex < 0 || selectedCaptionIndex >= items.length) selectedCaptionIndex = 0;

  list.innerHTML = items
    .map((c, idx) => {
      const active = idx === selectedCaptionIndex ? "active" : "";
      const text = String(c || "").trim();
      const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      return `<button type="button" class="list-group-item list-group-item-action ${active} small py-1 px-2" data-idx="${idx}">
        <div class="text-truncate" title="${escapeHtml(text)}">${escapeHtml(short || "(空)")}</div>
      </button>`;
    })
    .join("");

  list.querySelectorAll("[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedCaptionIndex = Number(btn.getAttribute("data-idx") || "0");
      byId("captionEditor").value = String(config.captions?.[selectedCaptionIndex] || "");
      renderCaptionList();
    });
  });

  byId("captionEditor").value = String(items[selectedCaptionIndex] || "");
}

function captionAdd() {
  const raw = byId("captionEditor").value;
  const lines = String(raw || "")
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("请输入文案内容");
  config.captions = Array.isArray(config.captions) ? config.captions : [];
  config.captions.push(...lines);
  selectedCaptionIndex = Math.max(0, config.captions.length - lines.length);
  renderCaptionList();
  byId("captionEditor").value = "";
}

function captionUpdate() {
  const text = byId("captionEditor").value.trim();
  if (!text) throw new Error("请输入文案内容");
  config.captions = Array.isArray(config.captions) ? config.captions : [];
  if (selectedCaptionIndex < 0 || selectedCaptionIndex >= config.captions.length) {
    config.captions.push(text);
    selectedCaptionIndex = config.captions.length - 1;
  } else {
    config.captions[selectedCaptionIndex] = text;
  }
  renderCaptionList();
}

function captionDelete() {
  config.captions = Array.isArray(config.captions) ? config.captions : [];
  if (selectedCaptionIndex < 0 || selectedCaptionIndex >= config.captions.length) return;
  config.captions.splice(selectedCaptionIndex, 1);
  if (selectedCaptionIndex >= config.captions.length) selectedCaptionIndex = config.captions.length - 1;
  renderCaptionList();
}

function captionClear() {
  const ok = window.confirm("确定要清空全部文案吗？");
  if (!ok) return;
  config.captions = [];
  selectedCaptionIndex = -1;
  renderCaptionList();
}

async function importTxt() {
  const input = byId("captionTxt");
  const f = (input.files || [])[0];
  if (!f) throw new Error("请选择 txt 文件");
  const text = await f.text();
  const lines = text
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("txt 内没有可用文案（空行会被忽略）");

  const cover = window.confirm("是否覆盖现有文案库？\n确定=覆盖，取消=追加");
  const current = Array.isArray(config.captions) ? config.captions : [];
  const next = cover ? lines : current.concat(lines);
  // 简单去重（保留顺序）
  const seen = new Set();
  config.captions = next.filter((s) => {
    const key = String(s || "").trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  input.value = "";
  selectedCaptionIndex = config.captions.length ? 0 : -1;
  renderCaptionList();
}

function generateAccountId() {
  const rand = Math.random().toString(16).slice(2, 10);
  return `acc_${Date.now()}_${rand}`;
}

async function loadConfig() {
  const res = await api("/api/bulk/config");
  config = res?.config || config;
  if (!Array.isArray(config.accounts)) config.accounts = [];
  if (!Array.isArray(config.captions)) config.captions = [];
  if (!Number.isFinite(Number(config.followWaitSec))) config.followWaitSec = 18;
  if (!Number.isFinite(Number(config.followConcurrency))) config.followConcurrency = 1;
  if (!Number.isFinite(Number(config.followJitterSec))) config.followJitterSec = 4;

  renderBaseForm();
  renderCaptionList();
  renderAccountsList();
}

async function saveConfig() {
  applyAccountFormToConfig();
  applyBaseFormToConfig();

  const res = await api("/api/bulk/config", { method: "POST", body: JSON.stringify(config) });
  setJsonBox(res);
  config = res?.config || config;
  if (!Array.isArray(config.accounts)) config.accounts = [];
  if (!Array.isArray(config.captions)) config.captions = [];
  if (!Number.isFinite(Number(config.followWaitSec))) config.followWaitSec = 18;
  if (!Number.isFinite(Number(config.followConcurrency))) config.followConcurrency = 1;
  if (!Number.isFinite(Number(config.followJitterSec))) config.followJitterSec = 4;
  renderBaseForm();
  renderCaptionList();
  renderAccountsList();
  await refreshStatus({ silent: true });
}

async function startBulk() {
  const res = await api("/api/bulk/start", { method: "POST" });
  setJsonBox(res);
  await refreshStatus({ silent: true });
}

async function stopBulk() {
  const res = await api("/api/bulk/stop", { method: "POST" });
  setJsonBox(res);
  await refreshStatus({ silent: true });
}

async function runOnce() {
  applyAccountFormToConfig();
  const a = getSelectedAccount();
  if (!a) throw new Error("请先选择一个账号");
  const res = await api("/api/bulk/run-once", { method: "POST", body: JSON.stringify({ accountId: a.id }) });
  setJsonBox(res);
  await refreshStatus({ silent: true });
  await refreshLogs({ silent: true });
}

async function testXAuth() {
  applyAccountFormToConfig();
  const a = getSelectedAccount();
  if (!a) throw new Error("请先选择一个账号");
  const res = await api("/api/bulk/test-x-auth", { method: "POST", body: JSON.stringify({ accountId: a.id }) });
  setJsonBox(res);
}

function setFollowJobHint(job) {
  const el = byId("followJobHint");
  if (!el) return;

  const j = job && typeof job === "object" ? job : {};
  const running = Boolean(j.running);
  const stopRequested = Boolean(j.stopRequested);
  const url = String(j.tweetUrl || "").trim();
  const maxPerAccount = Number(j.maxPerAccount ?? 0);
  const followWaitSec = Number(j.followWaitSec ?? 0);
  const followConcurrency = Number(j.followConcurrency ?? 0);
  const followJitterSec = Number(j.followJitterSec ?? 0);
  const startedAt = j.startedAt ? new Date(j.startedAt).toLocaleString() : "";
  const finishedAt = j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "";

  if (running) {
    const total = Number(j.accountsTotal ?? 0);
    const done = Number(j.accountsDone ?? 0);
    const status = stopRequested ? "运行中（已请求停止）" : "运行中";
    const concText = followConcurrency > 0 ? ` | 并行：${followConcurrency}` : "";
    const jitterText = followJitterSec > 0 ? ` | 抖动：${followJitterSec}s` : "";
    const limitText = maxPerAccount > 0 ? ` | 本次每号上限：${maxPerAccount}` : "";
    const waitText = followWaitSec > 0 ? ` | 等待按钮：${followWaitSec}s` : "";
    el.textContent = `状态：${status} | 进度：${done}/${total}${concText}${jitterText}${limitText}${waitText} | 开始：${startedAt || "-"}`;
    return;
  }

  if (finishedAt) {
    const concText = followConcurrency > 0 ? ` | 并行：${followConcurrency}` : "";
    const jitterText = followJitterSec > 0 ? ` | 抖动：${followJitterSec}s` : "";
    const limitText = maxPerAccount > 0 ? ` | 本次每号上限：${maxPerAccount}` : "";
    const waitText = followWaitSec > 0 ? ` | 等待按钮：${followWaitSec}s` : "";
    el.textContent = `状态：已结束 | 结束：${finishedAt}${concText}${jitterText}${limitText}${waitText} | 链接：${url || "-"}`;
    return;
  }

  el.textContent = `状态：未开始`;
}

async function followCommentersStart() {
  // 确保账号勾选/代理等最新配置已落盘，否则服务端拿到的还是旧配置
  await saveConfig();

  const tweetUrl = byId("followTweetUrl")?.value?.trim() || "";
  if (!tweetUrl) throw new Error("请先填写 X 帖子链接");

  const maxPerAccount = Number(byId("followMaxPerAccount")?.value || 30);
  const followWaitSec = Number(byId("followWaitSec")?.value || 18);
  const followConcurrency = Number(byId("followConcurrency")?.value || 1);
  const followJitterSec = Number(byId("followJitterSec")?.value || 4);
  const res = await api("/api/bulk/follow-commenters/start", {
    method: "POST",
    body: JSON.stringify({ tweetUrl, maxPerAccount, followWaitSec, followConcurrency, followJitterSec }),
  });
  setJsonBox(res);
  setFollowJobHint(res?.job || res?.followJob || null);
  showLogsTab();
  await refreshLogs({ silent: true }).catch(() => {});
  await refreshStatus({ silent: true }).catch(() => {});
}

async function followCommentersStop() {
  const res = await api("/api/bulk/follow-commenters/stop", { method: "POST" });
  setJsonBox(res);
  await followCommentersStatus({ silent: true }).catch(() => {});
  await refreshLogs({ silent: true }).catch(() => {});
}

async function followCommentersStatus(options = {}) {
  const silent = options.silent === true;
  const res = await api("/api/bulk/follow-commenters/status");
  if (!silent) setJsonBox(res);
  setFollowJobHint(res?.job || null);
  return res;
}

async function refreshDebug(options = {}) {
  const silent = options.silent === true;
  const data = await api("/api/bulk/debug");
  if (!silent) setJsonBox(data);

  const dataDirEl = byId("debugDataDir");
  if (dataDirEl) dataDirEl.textContent = data?.dataDir || "-";

  const cfgEl = byId("debugBulkConfigPath");
  if (cfgEl) cfgEl.textContent = data?.bulkConfigPath || "-";
}

function setGalleryInfo({ dir, scannedAt, count }) {
  const info = byId("galleryInfo");
  const isDefaultDir = !config?.imageDir || config.imageDir === "data/bulk-images";
  // const dirText = dir ? `扫描目录${isDefaultDir ? "（默认）" : ""}：${dir}` : "扫描目录：（未获取）";
  // const timeText = scannedAt ? ` | 扫描时间：${new Date(scannedAt).toLocaleString()}` : "";
  // const countText = ` | 图片：${Number(count) || 0}`;
  // info.textContent = `${dirText}${timeText}${countText}`;
  info.textContent = dir ? `${dir} (${Number(count) || 0} 张)` : "正在加载...";
  
  byId("resolvedImageDir").textContent = dir || "-";
}

async function refreshImages(options = {}) {
  const silent = options.silent === true;
  const res = await api("/api/bulk/images");
  if (!silent) setJsonBox(res);

  const el = byId("gallery");
  const images = res?.images || [];
  setGalleryInfo({ dir: res?.dir || "", scannedAt: res?.scannedAt || "", count: images.length });

  if (images.length === 0) {
    el.innerHTML = `<div class="p-4 text-center text-muted small col-12">暂无图片<br>请上传或将图片放入目录</div>`;
    return;
  }

  el.innerHTML = images
    .slice(0, 500)
    .map((img) => {
      const name = img.name || "";
      const url = img.url || "";
      return `<div class="gallery-item" title="${escapeHtml(name)}">
          <img src="${escapeHtml(url)}" loading="lazy" />
          <div class="meta">${escapeHtml(name)}</div>
      </div>`;
    })
    .join("");
}

function collectUploadFiles() {
  const files = [];
  const addAll = (inputId) => {
    const input = byId(inputId);
    for (const f of Array.from(input.files || [])) {
      if (!isLikelyImageFile(f)) continue;
      if (f.size === 0) continue;
      files.push(f);
    }
  };
  addAll("uploadFiles");
  addAll("uploadFolder");

  // 去重（同名+size+lastModified）
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function updateUploadSelectionInfo() {
  const el = byId("uploadSelectionInfo");
  const files = collectUploadFiles();
  if (files.length) {
    el.style.display = 'block';
    el.textContent = `已选 ${files.length} 张（即将自动上传，可点“清空选择”取消）`;
  } else {
    el.style.display = 'none';
  }
  renderUploadPreview(files);
  scheduleAutoUpload(files.length);
}

function clearUploadSelection() {
  cancelAutoUpload();
  byId("uploadFiles").value = "";
  byId("uploadFolder").value = "";
  updateUploadSelectionInfo();
}

function cancelAutoUpload() {
  if (autoUploadTimer) clearTimeout(autoUploadTimer);
  autoUploadTimer = null;
}

function scheduleAutoUpload(filesCount) {
  cancelAutoUpload();
  if (!filesCount) return;
  if (uploadInProgress) return;

  // 给用户一个“反悔窗口”，可点“清空选择”取消
  autoUploadTimer = setTimeout(() => {
    startAutoUpload().catch((e) => {
      setJsonBox({ error: String(e?.message || e) });
    });
  }, 1200);
}

function setUploadUiEnabled(enabled) {
  byId("uploadFiles").disabled = !enabled;
  byId("uploadFolder").disabled = !enabled;
  byId("btnUploadClear").disabled = !enabled;
}

async function startAutoUpload() {
  cancelAutoUpload();
  const files = collectUploadFiles();
  if (files.length === 0) return;
  if (uploadInProgress) return;

  uploadInProgress = true;
  byId("uploadSelectionInfo").textContent = `上传中…（${files.length} 张）`;
  setUploadUiEnabled(false);
  try {
    await uploadFiles(files);
    clearUploadSelection();
    await refreshImages({ silent: true });
  } finally {
    uploadInProgress = false;
    setUploadUiEnabled(true);
  }
}

function clearUploadPreviewUrls() {
  for (const u of uploadPreviewObjectUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {}
  }
  uploadPreviewObjectUrls = [];
}

function renderUploadPreview(filesArg) {
  const files = Array.isArray(filesArg) ? filesArg : collectUploadFiles();
  const box = byId("uploadPreview");

  if (files.length === 0) {
    box.innerHTML = "";
    clearUploadPreviewUrls();
    return;
  }

  const limit = 20;
  const picked = files.slice(0, limit);

  clearUploadPreviewUrls();
  box.innerHTML = picked
    .map((f) => {
      const url = URL.createObjectURL(f);
      uploadPreviewObjectUrls.push(url);
      const name = String(f?.name || "");
      return `<div class="gallery-item">
          <img src="${escapeHtml(url)}" />
          <div class="meta">Waiting...</div>
      </div>`;
    })
    .join("");
}

async function uploadFiles(files) {
  const total = files.length;
  const concurrency = Math.min(4, total);
  const queue = files.slice();

  let done = 0;
  let failed = 0;
  const errors = [];
  const results = [];

  const updateProgress = () => {
    setJsonBox({ uploading: true, done, total, failed, lastError: errors[errors.length - 1] || null });
  };
  updateProgress();

  async function uploadOne(f) {
    const buf = await f.arrayBuffer();
    const res = await fetch(`/api/bulk/upload?filename=${encodeURIComponent(f.name)}`, {
      method: "PUT",
      headers: {
        "Content-Type": f.type || "application/octet-stream",
        "X-Filename": f.name,
      },
      body: buf,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.error || json?.message || res.statusText;
      throw new Error(msg);
    }
    return json;
  }

  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await uploadOne(f);
        results.push(r);
      } catch (e) {
        failed += 1;
        errors.push({ file: f?.name || "", error: String(e?.message || e) });
      } finally {
        done += 1;
        updateProgress();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  setJsonBox({ ok: failed === 0, uploaded: total - failed, failed, errors: errors.slice(0, 50) });
  return { ok: failed === 0, uploaded: total - failed, failed, errors, results };
}

async function uploadSelectedImages() {
  const files = collectUploadFiles();
  if (files.length === 0) throw new Error("请选择图片文件或选择一个文件夹");
  await uploadFiles(files);
  clearUploadSelection();
  await refreshImages({ silent: true });
}

async function refreshLogs(options = {}) {
  const silent = options.silent === true;
  const data = await api("/api/bulk/logs");
  if (!silent) setJsonBox(data);
  setRunningBadge(Boolean(data?.running));
  const lines = (data?.logs || []).map((l) => `[${l.time}] ${l.message}`);

  const box = byId("bulkLogBox");
  if (!box) return;
  const prevScrollTop = box.scrollTop;
  const stickToBottom = prevScrollTop + box.clientHeight >= box.scrollHeight - 24;

  box.textContent = lines.join("\n");
  if (stickToBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevScrollTop;
}

function renderStatusTable(accounts) {
  const tbody = byId("statusTableBody");
  if (!accounts || accounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-secondary text-center">暂无账号数据</td></tr>`;
    return;
  }

  tbody.innerHTML = accounts
    .map((a) => {
      const name = a.name || a.id || "";
      
      let stateBadge = `<span class="badge bg-secondary">Stopped</span>`;
      if (a.state?.running) stateBadge = `<span class="badge bg-success">Running</span>`;
      else if (!a.enabled) stateBadge = `<span class="badge bg-light text-muted border">Disabled</span>`;
      
      const next = a.state?.nextPostAt ? new Date(a.state.nextPostAt).toLocaleTimeString() : "-";
      // const last = a.state?.lastPostAt ? new Date(a.state.lastPostAt).toLocaleTimeString() : "-";
      const posts = String(a.state?.posts ?? 0);
      const err = a.state?.lastError ? `<span class="text-danger" title="${escapeHtml(a.state.lastError)}"><i class="bi bi-exclamation-circle"></i> Error</span>` : `<span class="text-success"><i class="bi bi-check2"></i> OK</span>`;
      
      return `<tr>
        <td class="ps-3 fw-medium">${escapeHtml(name)}</td>
        <td>${stateBadge}</td>
        <td class="mono">${escapeHtml(next)}</td>
        <td class="mono">${escapeHtml(posts)}</td>
        <td>${err}</td>
      </tr>`;
    })
    .join("");
}

function renderErrorTable(accounts) {
  const tbody = byId("errorTableBody");
  const badge = byId("errorCountBadge");

  const list = Array.isArray(accounts) ? accounts : [];
  const errors = list
    .filter((a) => String(a?.state?.lastError || "").trim())
    .map((a) => ({
      id: a.id || "",
      name: a.name || a.id || "",
      at: a.state?.lastErrorAt || "",
      err: String(a.state?.lastError || "").trim(),
    }));

  if (badge) {
    const n = errors.length;
    badge.textContent = String(n);
    badge.style.display = n > 0 ? "inline-block" : "none";
  }

  if (!tbody) return;

  if (errors.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-secondary text-center p-3">暂无报错</td></tr>`;
    return;
  }

  errors.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

  tbody.innerHTML = errors
    .map((e) => {
      const timeText = e.at ? new Date(e.at).toLocaleString() : "-";
      const short = e.err.length > 160 ? `${e.err.slice(0, 160)}…` : e.err;
      return `<tr data-id="${escapeHtml(e.id)}" style="cursor:pointer;">
        <td class="ps-3 fw-medium">${escapeHtml(e.name)}</td>
        <td class="mono text-muted" style="font-size: 11px;">${escapeHtml(timeText)}</td>
        <td class="text-danger" title="${escapeHtml(e.err)}">${escapeHtml(short)}</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const id = tr.getAttribute("data-id") || "";
      if (!id) return;
      selectedAccountId = id;
      renderAccountsList();
    });
  });
}

async function refreshStatus(options = {}) {
  const silent = options.silent === true;
  const data = await api("/api/bulk/status");
  if (!silent) setJsonBox(data);

  setRunningBadge(Boolean(data?.running));
  renderStatusTable(data?.accounts || []);
  renderErrorTable(data?.accounts || []);
  setFollowJobHint(data?.followJob || null);

  const count = Number(data?.images?.count ?? 0);
  const scannedAt = data?.images?.scannedAt ? new Date(data.images.scannedAt).toLocaleString() : "";
  const dir = data?.imageDir || "";
  setGalleryInfo({ dir, scannedAt, count });

  // 目录里新增/删除图片时：服务端会更新 count，这里自动刷新图库缩略图
  const shouldRefreshGallery = (lastGalleryDir && dir && lastGalleryDir !== dir) || (lastGalleryCount !== null && count !== lastGalleryCount);
  lastGalleryDir = dir;
  lastGalleryCount = count;
  if (shouldRefreshGallery) {
    await refreshImages({ silent: true }).catch(() => {});
  }
}

async function clearBulkLogs() {
  const res = await api("/api/bulk/logs/clear", { method: "POST" });
  setJsonBox(res);
  await refreshLogs({ silent: true });
}

function bind(id, event, handler) {
  const el = byId(id);
  if (!el) return;
  el.addEventListener(event, async (e) => {
    e.preventDefault();
    try {
      await handler(e);
    } catch (err) {
      setJsonBox({ error: String(err?.message || err) });
    }
  });
}

function bindAccountAutoApply() {
  const ids = [
    "accName",
    "accEnabled",
    "accDryRun",
    "accFollowCommentersEnabled",
    "accProxy",
    "accIntervalMin",
    "accJitterMin",
    "accImagesMin",
    "accImagesMax",
    "xApiKey",
    "xApiSecret",
    "xAccessToken",
    "xAccessSecret",
    "xProfileDir",
  ];
  for (const id of ids) {
    const el = byId(id);
    if (el) {
        el.addEventListener("input", () => applyAccountFormToConfig());
      el.addEventListener("change", () => applyAccountFormToConfig());
    }
  }
}

bind("btnSaveConfig", "click", saveConfig);
bind("btnBulkStart", "click", startBulk);
bind("btnBulkStop", "click", stopBulk);
bind("btnTestXAuth", "click", testXAuth);
bind("btnRunOnce", "click", runOnce);

bind("btnFollowCommentersStart", "click", followCommentersStart);
bind("btnFollowCommentersStop", "click", followCommentersStop);
bind("btnFollowCommentersStatus", "click", () => followCommentersStatus({ silent: false }));

bind("btnRefreshImages", "click", () => refreshImages({ silent: false }));
bind("btnRefreshStatus", "click", () => refreshStatus({ silent: false }));

bind("btnUploadClear", "click", () => {
  clearUploadSelection();
  setJsonBox({ ok: true });
});

bind("uploadFiles", "change", updateUploadSelectionInfo);
bind("uploadFolder", "change", updateUploadSelectionInfo);
bind("btnImportTxt", "click", () => byId("captionTxt").click()); // Trigger hidden input
bind("captionTxt", "change", async () => {
    await importTxt();
    setJsonBox({ ok: true, captions: config.captions.length });
});

bind("btnClearBulkLogs", "click", clearBulkLogs);

bind("btnCaptionAdd", "click", () => {
  captionAdd();
  setJsonBox({ ok: true, captions: config.captions.length });
});
bind("btnCaptionUpdate", "click", () => {
  captionUpdate();
  setJsonBox({ ok: true, captions: config.captions.length });
});
bind("btnCaptionDelete", "click", () => {
  captionDelete();
  setJsonBox({ ok: true, captions: config.captions.length });
});
bind("btnCaptionClear", "click", () => {
  captionClear();
  setJsonBox({ ok: true, captions: config.captions.length });
});


bind("btnAddAccount", "click", async () => {
  applyAccountFormToConfig();
  config.accounts = config.accounts || [];
  const id = generateAccountId();
  config.accounts.push({
    id,
    name: "",
    enabled: true,
    dryRun: true,
    followCommentersEnabled: false,
    proxy: "",
    schedule: { intervalMin: 120, jitterMin: 10, imagesMin: 1, imagesMax: 4 },
    x: { apiKey: "", apiSecret: "", accessToken: "", accessSecret: "", profileDir: "" },
  });
  selectedAccountId = id;
  renderAccountsList();
});

bind("btnDeleteAccount", "click", async () => {
  const a = getSelectedAccount();
  if (!a) return;
  const ok = window.confirm(`确定要删除账号：${a.name || a.id} ？`);
  if (!ok) return;
  config.accounts = (config.accounts || []).filter((x) => x.id !== a.id);
  selectedAccountId = "";
  renderAccountsList();
});

bind("btnOpenLogin", "click", async () => {
  let a = getSelectedAccount();
  if (!a) throw new Error("请先选择或创建一个账号");

  const btn = byId("btnOpenLogin");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 等待登录...`;

  try {
    // 先保存配置，确保账号/代理等信息已落盘。
    // 否则“新增账号后直接点登录”，服务端还没这条账号记录，会报“账号未找到”。
    await saveConfig();
    a = getSelectedAccount();
    if (!a) throw new Error("账号保存后未找到，请刷新页面重试");

    setJsonBox({
      msg: "正在启动浏览器...\n1. 请在弹出的窗口完成登录（可选 Continue with Google）。\n2. 登录成功后保持在首页，窗口会自动关闭。\n\n提示：不建议在脚本里保存账号密码。",
    });
    const res = await api("/api/bulk/open-login", {
      method: "POST",
      body: JSON.stringify({ accountId: a.id }),
    });

    if (res.ok) {
      await loadConfig(); // reload to ensure consistency
      setJsonBox(res);
    }
  } catch (e) {
    setJsonBox({ error: String(e.message || e) });
    alert("打开登录失败: " + String(e.message || e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

bindAccountAutoApply();

await loadConfig();
await refreshDebug({ silent: true }).catch(() => {});
await refreshStatus({ silent: true }).catch(() => {});
await refreshImages({ silent: true }).catch(() => {});
await refreshLogs({ silent: true }).catch(() => {});

setInterval(() => refreshLogs({ silent: true }).catch(() => {}), 2000);
setInterval(() => refreshStatus({ silent: true }).catch(() => {}), 5000);
