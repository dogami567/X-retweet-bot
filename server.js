const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

// Puppeteer Stealth Mode
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

function findLocalBrowser() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.CHROME_PATH,
  ];
  for (const c of candidates) {
    if (c && fssync.existsSync(c)) return c;
  }
  return null;
}

try {
  // 从项目根目录加载 .env（如果不存在则忽略）
  // eslint-disable-next-line global-require
  require("dotenv").config({ path: path.join(APP_DIR, ".env") });
} catch {}

const cors = require("cors");
const express = require("express");
const axios = require("axios/dist/node/axios.cjs");
const { TwitterApi } = require("twitter-api-v2");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = path.join(APP_DIR, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(DATA_DIR, "config.example.json");
const DB_PATH = path.join(DATA_DIR, "monitor_db.json");
const BULK_CONFIG_PATH = path.join(DATA_DIR, "bulk_config.json");
const BULK_IMAGES_DEFAULT_DIR = path.join(DATA_DIR, "bulk-images");
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
const PUBLIC_DIR = (() => {
  const external = path.join(APP_DIR, "public");
  if (fssync.existsSync(external)) return external;
  return path.join(__dirname, "public");
})();

const LOG_LIMIT = 200;
const BULK_LOG_LIMIT = 200;
const QUEUE_MAX_ATTEMPTS = 5;
const X_REQUEST_TIMEOUT_MS = 60_000;
const BULK_FOLLOW_COMMENTERS_DAILY_LIMIT = 300;

function nowIso() {
  return new Date().toISOString();
}

function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function ensureBulkFollowDailyState(state) {
  const st = state && typeof state === "object" ? state : {};
  const today = localDateKey();
  if (safeString(st.followDailyDate).trim() !== today) {
    st.followDailyDate = today;
    st.followDailyCount = 0;
  }
  if (!Number.isFinite(Number(st.followDailyCount))) st.followDailyCount = 0;
  return st;
}

function getBulkFollowRemaining(state) {
  const st = ensureBulkFollowDailyState(state);
  const used = Math.max(0, Math.round(Number(st.followDailyCount) || 0));
  return Math.max(0, BULK_FOLLOW_COMMENTERS_DAILY_LIMIT - used);
}

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function sanitizeDirName(name) {
  const s = safeString(name).trim();
  if (!s) return "";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function defaultBulkBrowserProfileDirValue(accountId) {
  const id = sanitizeDirName(accountId) || "acc";
  return path.join("data", "browser-profiles", id);
}

function resolveAppDirPath(value) {
  const raw = safeString(value).trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(APP_DIR, raw);
}

function parseBoolEnv(value) {
  const v = safeString(value).trim().toLowerCase();
  if (!v) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return undefined;
}

function parseIntEnv(value) {
  const v = safeString(value).trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openInBrowser(url) {
  const u = safeString(url).trim();
  if (!u) return;
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn("open", [u], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [u], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

function parseListEnv(value) {
  return safeString(value)
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeScreenName(name) {
  return safeString(name).trim().replace(/^@/, "");
}

function pickFirstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return "";
}

function compareNumericStrings(a, b) {
  const aa = safeString(a).trim();
  const bb = safeString(b).trim();
  if (!/^\d+$/.test(aa) || !/^\d+$/.test(bb)) return aa.localeCompare(bb);
  if (aa.length !== bb.length) return aa.length - bb.length;
  if (aa === bb) return 0;
  return aa < bb ? -1 : 1;
}

function maxId(ids) {
  let out = "0";
  for (const id of ids) {
    if (compareNumericStrings(id, out) > 0) out = id;
  }
  return out;
}

function extractTweetId(tweet) {
  const id = pickFirstString(
    tweet?.id_str,
    tweet?.id,
    tweet?.tweet_id,
    tweet?.tweetId,
    tweet?.rest_id,
  );
  return safeString(id).trim();
}

function extractTweetText(tweet) {
  return pickFirstString(tweet?.full_text, tweet?.text, tweet?.content, tweet?.rawContent);
}

function compactTweetForQueue(tweet) {
  const t = tweet && typeof tweet === "object" ? tweet : null;
  if (!t) return null;

  const out = {};
  const keys = [
    "id",
    "id_str",
    "tweet_id",
    "tweetId",
    "rest_id",
    "full_text",
    "text",
    "content",
    "rawContent",
    "extendedEntities",
    "extended_entities",
    "entities",
    "media",
  ];
  for (const k of keys) {
    if (t[k] !== undefined) out[k] = t[k];
  }
  return Object.keys(out).length ? out : null;
}

function extractTweetArrayFromApiResponse(apiData) {
  const candidates = [
    apiData?.tweets,
    apiData?.data?.tweets,
    apiData?.data,
    apiData?.result?.tweets,
    apiData?.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractPinnedTweetIdFromApiResponse(apiData) {
  const candidates = [
    apiData?.pin_tweet?.id,
    apiData?.pin_tweet?.id_str,
    apiData?.data?.pin_tweet?.id,
    apiData?.data?.pin_tweet?.id_str,
  ];
  return pickFirstString(...candidates);
}

function extractMediaEntities(tweet) {
  const candidates = [
    tweet?.extendedEntities?.media,
    tweet?.extendedEntities?.mediaEntities,
    tweet?.extended_entities?.media,
    tweet?.entities?.media,
    tweet?.media,
  ];

  const out = [];
  for (const c of candidates) {
    if (Array.isArray(c)) out.push(...c);
  }
  return out;
}

function extractPhotoMedia(tweet) {
  const media = extractMediaEntities(tweet);
  const photos = media
    .map((m) => {
      const type = safeString(m?.type || m?.media_type).trim().toLowerCase();
      const url = pickFirstString(m?.media_url_https, m?.media_url);
      const shortUrl = pickFirstString(m?.url);
      return { type, url: safeString(url).trim(), shortUrl: safeString(shortUrl).trim() };
    })
    .filter((m) => m.type === "photo" && m.url);

  const seen = new Set();
  const deduped = [];
  for (const p of photos) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    deduped.push(p);
  }
  return deduped;
}

function stripUrlsFromText(text, urls) {
  let out = safeString(text);
  const list = Array.isArray(urls) ? urls.map((u) => safeString(u).trim()).filter(Boolean) : [];
  for (const u of list) {
    const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}\\s*`, "g"), "");
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function classifyTweet(tweet) {
  const reasons = [];
  const text = extractTweetText(tweet);

  const type = safeString(tweet?.type).toLowerCase();
  if (type.includes("retweet")) {
    reasons.push("type=retweet");
    return { kind: "retweet", reasons };
  }

  // TwitterAPI.io: retweeted_tweet / quoted_tweet / isReply
  if (tweet?.retweeted_tweet || tweet?.retweetedTweet) {
    reasons.push("retweeted_tweet");
    return { kind: "retweet", reasons };
  }
  if (
    tweet?.isReply === true ||
    tweet?.inReplyToId ||
    tweet?.inReplyToUserId ||
    tweet?.inReplyToUsername ||
    tweet?.in_reply_to_status_id ||
    tweet?.in_reply_to_status_id_str
  ) {
    reasons.push("isReply/inReplyTo*");
    return { kind: "reply", reasons };
  }
  if (tweet?.quoted_tweet || tweet?.quotedTweet) {
    reasons.push("quoted_tweet");
    return { kind: "quote", reasons };
  }

  const referenced = tweet?.referenced_tweets || tweet?.referencedTweets;
  if (Array.isArray(referenced)) {
    const types = referenced
      .map((r) => safeString(r?.type).toLowerCase())
      .filter(Boolean);
    if (types.includes("retweeted")) {
      reasons.push("referenced_tweets=retweeted");
      return { kind: "retweet", reasons };
    }
    if (types.includes("replied_to")) {
      reasons.push("referenced_tweets=replied_to");
      return { kind: "reply", reasons };
    }
    if (types.includes("quoted")) {
      reasons.push("referenced_tweets=quoted");
      return { kind: "quote", reasons };
    }
  }

  const retweetObj =
    tweet?.retweeted_status ||
    tweet?.retweetedStatus ||
    tweet?.retweeted_tweet ||
    tweet?.retweetedTweet;
  if (retweetObj) {
    reasons.push("retweeted_status");
    return { kind: "retweet", reasons };
  }
  if (tweet?.is_retweet === true || tweet?.isRetweet === true || tweet?.retweeted === true) {
    reasons.push("is_retweet");
    return { kind: "retweet", reasons };
  }
  if (typeof text === "string" && text.startsWith("RT @")) {
    reasons.push("text_prefix=RT @");
    return { kind: "retweet", reasons };
  }

  if (
    tweet?.in_reply_to_status_id ||
    tweet?.in_reply_to_status_id_str ||
    tweet?.in_reply_to_user_id ||
    tweet?.in_reply_to_user_id_str ||
    tweet?.in_reply_to_screen_name ||
    tweet?.in_reply_to_tweet_id ||
    tweet?.inReplyToTweetId
  ) {
    reasons.push("in_reply_to_*");
    return { kind: "reply", reasons };
  }

  const quoteObj = tweet?.quoted_status || tweet?.quotedStatus || tweet?.quote_tweet_id;
  if (quoteObj || tweet?.is_quote_status === true || tweet?.isQuoteStatus === true) {
    reasons.push("quote");
    return { kind: "quote", reasons };
  }

  return { kind: "original", reasons };
}

function redactSecrets(obj) {
  const clone = JSON.parse(JSON.stringify(obj ?? {}));
  if (clone?.twitterApi?.apiKey) clone.twitterApi.apiKey = "***";
  if (clone?.forward?.proxy) clone.forward.proxy = "***";
  if (clone?.forward?.translateToZh !== undefined) clone.forward.translateToZh = Boolean(clone.forward.translateToZh);
  if (clone?.forward?.x?.apiKey) clone.forward.x.apiKey = "***";
  if (clone?.forward?.x?.apiSecret) clone.forward.x.apiSecret = "***";
  if (clone?.forward?.x?.accessToken) clone.forward.x.accessToken = "***";
  if (clone?.forward?.x?.accessSecret) clone.forward.x.accessSecret = "***";
  return clone;
}

function applyEnvOverrides(baseConfig) {
  const next = JSON.parse(JSON.stringify(baseConfig || {}));
  next.twitterApi = next.twitterApi || {};
  next.monitor = next.monitor || {};
  next.forward = next.forward || {};
  next.forward.x = next.forward.x || {};

  const apiKey = safeString(pickFirstString(process.env.TWITTERAPI_IO_KEY, process.env.TWITTERAPI_IO_API_KEY)).trim();
  if (apiKey && !safeString(next.twitterApi.apiKey).trim()) next.twitterApi.apiKey = apiKey;

  const baseUrl = safeString(process.env.TWITTERAPI_IO_BASE_URL).trim();
  if (baseUrl && !safeString(next.twitterApi.baseUrl).trim()) next.twitterApi.baseUrl = baseUrl;

  const targetsRaw = safeString(process.env.MONITOR_TARGETS).trim();
  if (targetsRaw && (!Array.isArray(next.monitor.targets) || next.monitor.targets.length === 0)) {
    next.monitor.targets = parseListEnv(targetsRaw).map(normalizeScreenName).filter(Boolean);
  }

	  const pollIntervalSec = parseIntEnv(process.env.MONITOR_POLL_INTERVAL_SEC);
	  if (pollIntervalSec !== undefined && (next.monitor.pollIntervalSec === undefined || next.monitor.pollIntervalSec === null)) {
	    next.monitor.pollIntervalSec = Math.max(10, pollIntervalSec);
	  }

	  const fetchLimit = parseIntEnv(process.env.MONITOR_FETCH_LIMIT);
	  if (fetchLimit !== undefined && (next.monitor.fetchLimit === undefined || next.monitor.fetchLimit === null)) {
	    next.monitor.fetchLimit = Math.max(1, fetchLimit);
	  }

	  const includeReplies = parseBoolEnv(process.env.MONITOR_INCLUDE_REPLIES);
	  if (includeReplies !== undefined && next.monitor.includeReplies === undefined) next.monitor.includeReplies = includeReplies;

  const includeQuoteTweets = parseBoolEnv(process.env.MONITOR_INCLUDE_QUOTE_TWEETS);
  if (includeQuoteTweets !== undefined && next.monitor.includeQuoteTweets === undefined) next.monitor.includeQuoteTweets = includeQuoteTweets;

  const skipMentions = parseBoolEnv(process.env.MONITOR_SKIP_MENTIONS);
  if (skipMentions !== undefined && next.monitor.skipMentions === undefined) next.monitor.skipMentions = skipMentions;

  const forwardEnabled = parseBoolEnv(process.env.FORWARD_ENABLED);
  if (forwardEnabled !== undefined && next.forward.enabled === undefined) next.forward.enabled = forwardEnabled;

  const forwardDryRun = parseBoolEnv(process.env.FORWARD_DRY_RUN);
  if (forwardDryRun !== undefined && next.forward.dryRun === undefined) next.forward.dryRun = forwardDryRun;

  const forwardMode = safeString(process.env.FORWARD_MODE).trim();
  if (forwardMode && !safeString(next.forward.mode).trim()) next.forward.mode = forwardMode;

  const sendIntervalSec = parseIntEnv(process.env.FORWARD_SEND_INTERVAL_SEC);
  if (sendIntervalSec !== undefined && (next.forward.sendIntervalSec === undefined || next.forward.sendIntervalSec === null)) {
    next.forward.sendIntervalSec = Math.max(0, sendIntervalSec);
  }

  const translateToZh = parseBoolEnv(process.env.FORWARD_TRANSLATE_TO_ZH);
  if (translateToZh !== undefined && next.forward.translateToZh === undefined) next.forward.translateToZh = translateToZh;

  const forwardProxy = safeString(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY).trim();
  if (forwardProxy && !safeString(next.forward.proxy).trim()) next.forward.proxy = forwardProxy;

  const xApiKey = safeString(process.env.X_API_KEY).trim();
  if (xApiKey && !safeString(next.forward.x.apiKey).trim()) next.forward.x.apiKey = xApiKey;

  const xApiSecret = safeString(process.env.X_API_SECRET).trim();
  if (xApiSecret && !safeString(next.forward.x.apiSecret).trim()) next.forward.x.apiSecret = xApiSecret;

  const xAccessToken = safeString(process.env.X_ACCESS_TOKEN).trim();
  if (xAccessToken && !safeString(next.forward.x.accessToken).trim()) next.forward.x.accessToken = xAccessToken;

  const xAccessSecret = safeString(process.env.X_ACCESS_SECRET).trim();
  if (xAccessSecret && !safeString(next.forward.x.accessSecret).trim()) next.forward.x.accessSecret = xAccessSecret;

  return next;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, json, "utf8");
}

function generateId(prefix) {
  const p = safeString(prefix || "id").trim() || "id";
  const rand = Math.random().toString(16).slice(2, 10);
  return `${p}_${Date.now()}_${rand}`;
}

function defaultBulkConfig() {
  return {
    version: 1,
    imageDir: "data/bulk-images",
    scanIntervalSec: 3600,
    captions: [],
    accounts: [],
  };
}

function normalizeBulkAccount(raw) {
  const a = raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : {};

  a.id = safeString(a.id).trim();
  a.name = safeString(a.name).trim();
  a.enabled = a.enabled === undefined ? true : Boolean(a.enabled);
  a.dryRun = a.dryRun === undefined ? true : Boolean(a.dryRun);
  a.followCommentersEnabled = a.followCommentersEnabled === true;
  a.proxy = safeString(a.proxy).trim();

  a.schedule = a.schedule && typeof a.schedule === "object" ? a.schedule : {};
  const intervalMinRaw = Number(a.schedule.intervalMin ?? 120);
  const jitterMinFallback =
    a.schedule.jitterMin === undefined && a.schedule.jitterSec !== undefined ? Number(a.schedule.jitterSec) / 60 : undefined;
  const jitterMinRaw = Number(a.schedule.jitterMin ?? jitterMinFallback ?? 10);
  const imagesMinRaw = Number(a.schedule.imagesMin ?? 1);
  const imagesMaxRaw = Number(a.schedule.imagesMax ?? 4);

  a.schedule.intervalMin = Number.isFinite(intervalMinRaw) ? Math.max(1, Math.round(intervalMinRaw)) : 120;
  a.schedule.jitterMin = Number.isFinite(jitterMinRaw) ? Math.max(0, Math.round(jitterMinRaw)) : 10;
  delete a.schedule.jitterSec;

  const imagesMin = Number.isFinite(imagesMinRaw) ? Math.max(0, Math.round(imagesMinRaw)) : 1;
  const imagesMax = Number.isFinite(imagesMaxRaw) ? Math.max(0, Math.round(imagesMaxRaw)) : 4;
  a.schedule.imagesMin = Math.min(4, Math.max(0, Math.min(imagesMin, imagesMax)));
  a.schedule.imagesMax = Math.min(4, Math.max(a.schedule.imagesMin, imagesMax));

  a.x = a.x && typeof a.x === "object" ? a.x : {};
  a.x.apiKey = safeString(a.x.apiKey).trim();
  a.x.apiSecret = safeString(a.x.apiSecret).trim();
  a.x.accessToken = safeString(a.x.accessToken).trim();
  a.x.accessSecret = safeString(a.x.accessSecret).trim();
  a.x.profileDir = safeString(a.x.profileDir).trim();
  a.x.cookieString = safeString(a.x.cookieString).trim();
  a.x.queryId = safeString(a.x.queryId).trim();

  return a;
}

function extractCookie(cookieStr, key) {
  if (!cookieStr) return "";
  const match = cookieStr.match(new RegExp(`(?:^|; )\\s*${key}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

async function bulkUploadMediaViaCookie(cookieStr, mediaItems, proxyUrl) {
  const items = Array.isArray(mediaItems) ? mediaItems : [];
  if (items.length === 0) return [];

  const ct0 = extractCookie(cookieStr, "ct0");
  const authToken = extractCookie(cookieStr, "auth_token");
  if (!ct0 || !authToken) throw new Error("Cookie 模式缺少 ct0 或 auth_token");

  const agent = getCachedHttpsProxyAgent(proxyUrl);
  const client = axios.create({
    baseURL: "https://upload.twitter.com",
    timeout: 60_000,
    headers: {
      "x-csrf-token": ct0,
      authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
      cookie: cookieStr,
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      "x-twitter-auth-type": "OAuth2Session",
      "origin": "https://twitter.com",
      "referer": "https://twitter.com/",
    },
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
  });

  const mediaIds = [];
  for (const item of items) {
    if (!item.buffer) continue;
    const size = item.buffer.length;
    const mimeType = item.mimeType || "application/octet-stream";

    // 1. INIT
    const initParams = new URLSearchParams();
    initParams.append("command", "INIT");
    initParams.append("total_bytes", size);
    initParams.append("media_type", mimeType);
    initParams.append("media_category", "tweet_image");

    const initRes = await client.post("/i/media/upload.json", initParams.toString());
    const mediaId = safeString(initRes.data?.media_id_string);
    if (!mediaId) throw new Error("Cookie 上传失败：INIT 未返回 media_id");

    // 2. APPEND
    const appendParams = new URLSearchParams();
    appendParams.append("command", "APPEND");
    appendParams.append("media_id", mediaId);
    appendParams.append("segment_index", "0");
    appendParams.append("media_data", item.buffer.toString("base64"));
    await client.post("/i/media/upload.json", appendParams.toString(), {
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    // 3. FINALIZE
    const finParams = new URLSearchParams();
    finParams.append("command", "FINALIZE");
    finParams.append("media_id", mediaId);
    await client.post("/i/media/upload.json", finParams.toString());

    mediaIds.push(mediaId);
  }
  return mediaIds;
}

async function bulkPostViaCookie(account, text, mediaIds, proxyUrl) {
  // 之前的 API 方案被风控 (Error 226)，现改为使用 Puppeteer 模拟真实浏览器发帖
  // 注意：mediaIds 在这里不再适用，因为 Puppeteer 需要直接上传文件路径
  // 但上层调用者已经传了 mediaIds，这意味着上层已经把图片读出来了。
  // 我们需要重构一下，让上层传文件路径给这个函数，或者我们这里把 buffer 写临时文件。
  
  // 由于重构上层比较麻烦，我们这里直接抛出特殊错误，或者修改上层逻辑。
  // 更好的方式是：修改 bulkPostOnce，让它在 Cookie 模式下不上传 API，而是收集文件路径传给这里。
  throw new Error("Internal: bulkPostViaCookie 需升级配合 Puppeteer"); 
}

// 辅助函数：等待并点击
async function puppeteerClick(page, selector) {
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    await page.click(selector);
}

async function bulkPostViaPuppeteer(account, text, filePaths) {
  const exe = findLocalBrowser();
  if (!exe) throw new Error("浏览器发帖需要本地 Chrome/Edge。");

  const profileDirValue = safeString(account?.x?.profileDir).trim();
  const profileDir = profileDirValue ? resolveAppDirPath(profileDirValue) : "";
  const hasProfile = Boolean(profileDir);

  const cookieStr = safeString(account?.x?.cookieString);
  const cookiePairs = hasProfile
    ? []
    : cookieStr
        .split(";")
        .map((s) => {
          const [name, ...v] = s.trim().split("=");
          return { name, value: v.join("=") };
        })
        .filter((c) => c.name && c.value);

  // 同时写入 x.com 与 twitter.com，避免域名跳转导致 Cookie 不生效
  const cookies = [];
  for (const c of cookiePairs) {
    cookies.push({ ...c, url: "https://x.com", secure: true, sameSite: "None" });
    cookies.push({ ...c, url: "https://twitter.com", secure: true, sameSite: "None" });
  }

  if (!hasProfile && cookies.length === 0) {
    throw new Error("未配置浏览器登录（Profile）或 Cookie");
  }

  console.log(`[Puppeteer] Starting browser for account ${account.name || account.id}...`);

  const proxyUrl = getBulkProxyUrl(account);
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--disable-infobars",
    "--window-size=1280,900", // 稍微大一点，确保 SideNav 显示
  ];
  if (proxyUrl) launchArgs.push(`--proxy-server=${proxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    ...(hasProfile ? { userDataDir: profileDir } : {}),
    ignoreDefaultArgs: ["--enable-automation"],
    args: launchArgs,
  });

  try {
    const page = await browser.newPage();
    if (!hasProfile) await page.setCookie(...cookies);
    
    // 1. Go to Home first (Standard user behavior)
    await page.goto("https://x.com/home", { waitUntil: "networkidle2", timeout: 60000 });

    if (page.url().includes("login") || page.url().includes("/i/flow/login")) {
      throw new Error("未登录：请先点“打开浏览器登录”完成登录");
    }

    // 2. Open Compose Window (Try SideNav button first, like XActions)
    const sideNavBtnSelector = '[data-testid="SideNav_NewTweet_Button"]';
    const composeUrl = "https://x.com/compose/tweet";
    
    try {
        await page.waitForSelector(sideNavBtnSelector, { timeout: 5000 });
        await page.click(sideNavBtnSelector);
        console.log("[Puppeteer] Clicked SideNav Tweet Button");
    } catch {
        console.log("[Puppeteer] SideNav button not found, navigating to compose URL...");
        await page.goto(composeUrl, { waitUntil: "networkidle2" });
    }

    // 3. Wait for Editor
    // XActions selectors: tweetTextarea = '[data-testid="tweetTextarea_0"]'
    const editorSelector = '[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(editorSelector, { timeout: 15000 });
    
    // Ensure focus
    await page.click(editorSelector).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // 4. Upload Media
    if (filePaths && filePaths.length > 0) {
        // XActions selector: input[data-testid="fileInput"]
        const inputSelector = 'input[data-testid="fileInput"]'; 
        // Note: The input might be hidden, waitForSelector might fail if checking visibility.
        // Just waitForSelector in DOM is enough.
        const input = await page.$(inputSelector);
        if (input) {
            await input.uploadFile(...filePaths);
            // Wait for upload previews to appear
            // XActions doesn't have explicit wait logic for this as it's manual, 
            // but we can wait for [data-testid="attachments"] or just strict timeout.
            await new Promise(r => setTimeout(r, 3000 + (filePaths.length * 2000))); 
        } else {
            console.log("[Puppeteer] Warning: File input not found!");
        }
    }

    // 5. Type Text
    await page.keyboard.type(text, { delay: 50 }); // Natural typing

    // 6. Click Send
    // XActions selectors: tweetButton or tweetButtonInline
    const tweetBtnSelector = '[data-testid="tweetButton"]';
    const tweetBtnInlineSelector = '[data-testid="tweetButtonInline"]';
    
    let sendBtn = await page.$(tweetBtnSelector);
    if (!sendBtn) sendBtn = await page.$(tweetBtnInlineSelector);
    
    if (sendBtn) {
        // Scroll into view (XActions core.js logic)
        await sendBtn.evaluate(b => b.scrollIntoView({ block: 'center' }));
        await new Promise(r => setTimeout(r, 500));
        
        // Click
        await sendBtn.click();
        console.log("[Puppeteer] Clicked Send.");
    } else {
        throw new Error("Send button not found");
    }

    // 7. Wait for completion
    // Wait for the modal to disappear or URL to change back to home
    await new Promise(r => setTimeout(r, 5000));
    
    return "puppeteer_id_" + Date.now();

  } finally {
    await browser.close();
  }
}

async function xAuthViaPuppeteer(account) {
  const exe = findLocalBrowser();
  if (!exe) throw new Error("浏览器验证需要本地 Chrome/Edge。");

  const profileDirValue = safeString(account?.x?.profileDir).trim();
  if (!profileDirValue) throw new Error("未绑定浏览器 Profile：请先点“打开浏览器登录”完成登录");
  const profileDir = resolveAppDirPath(profileDirValue);
  if (!profileDir) throw new Error("Profile 目录解析失败");

  await fs.mkdir(profileDir, { recursive: true });

  const proxyUrl = getBulkProxyUrl(account);
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--window-position=0,0",
    "--window-size=1280,800",
  ];
  if (proxyUrl) launchArgs.push(`--proxy-server=${proxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    ignoreDefaultArgs: ["--enable-automation"],
    args: launchArgs,
  });

  try {
    const page = await browser.newPage();
    await page.goto("https://x.com/home", { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});

    if (isLoginLikeUrl(page.url())) {
      throw new Error("未登录：请先点“打开浏览器登录”完成登录");
    }

    const loggedIn = await page
      .evaluate(() => {
        return Boolean(
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
            document.querySelector('[data-testid="SideNav_NewTweet_Button"]'),
        );
      })
      .catch(() => false);

    if (!loggedIn) throw new Error("未检测到登录态：请确认已登录后重试");

    return { ok: true, profileDir: profileDirValue, proxy: redactUrlCredentials(proxyUrl) };
  } finally {
    await browser.close();
  }
}

async function xRetweetViaPuppeteer(account, tweetId) {
  const id = safeString(tweetId).trim();
  if (!id) throw new Error("tweetId 为空");

  const exe = findLocalBrowser();
  if (!exe) throw new Error("浏览器转推需要本地 Chrome/Edge。");

  const profileDirValue = safeString(account?.x?.profileDir).trim();
  if (!profileDirValue) throw new Error("未绑定浏览器 Profile：请先点“打开浏览器登录”完成登录");
  const profileDir = resolveAppDirPath(profileDirValue);
  if (!profileDir) throw new Error("Profile 目录解析失败");

  await fs.mkdir(profileDir, { recursive: true });

  const proxyUrl = getBulkProxyUrl(account);
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--window-position=0,0",
    "--window-size=1280,800",
  ];
  if (proxyUrl) launchArgs.push(`--proxy-server=${proxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    ignoreDefaultArgs: ["--enable-automation"],
    args: launchArgs,
  });

  try {
    const page = await browser.newPage();
    await page.goto(`https://x.com/i/web/status/${encodeURIComponent(id)}`, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});

    if (isLoginLikeUrl(page.url())) {
      throw new Error("未登录：请先点“打开浏览器登录”完成登录");
    }

    await page.waitForSelector("article", { timeout: 15_000 }).catch(() => {});
    await sleep(900);

    const unretweetBtn = await page.$('[data-testid="unretweet"]').catch(() => null);
    if (unretweetBtn) return { ok: true, tweetId: id, status: "already_retweeted" };

    const rtBtn = await page.$('[data-testid="retweet"]').catch(() => null);
    if (!rtBtn) throw new Error("未找到 retweet 按钮");

    await rtBtn.evaluate((b) => b.scrollIntoView({ block: "center" })).catch(() => {});
    await sleep(200);
    await rtBtn.click().catch(() => {});
    await sleep(500);

    const confirmSel = '[data-testid="retweetConfirm"]';
    await page.waitForSelector(confirmSel, { timeout: 8000 }).catch(() => {});
    const confirm = await page.$(confirmSel).catch(() => null);
    if (!confirm) throw new Error("未找到 Repost 确认按钮");
    await confirm.click().catch(() => {});
    await sleep(1200);

    return { ok: true, tweetId: id, status: "retweeted", proxy: redactUrlCredentials(proxyUrl) };
  } finally {
    await browser.close();
  }
}

function normalizeXStatusUrl(rawUrl) {
  const raw = safeString(rawUrl).trim();
  if (!raw) return "";

  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  url = url.replace(/^https?:\/\/(www\.)?twitter\.com\//i, "https://x.com/");
  url = url.replace(/^https?:\/\/(www\.)?x\.com\//i, "https://x.com/");

  // 去掉一些常见的尾部符号（复制/粘贴时经常带上）
  url = url.replace(/[)\],。．…]+$/g, "");
  return url;
}

function extractStatusAuthorFromUrl(statusUrl) {
  const u = safeString(statusUrl).trim();
  const m = u.match(/x\.com\/([^\/?#]+)\/status\/\d+/i);
  if (!m) return "";
  const name = safeString(m[1]).trim();
  return name && /^[A-Za-z0-9_]{1,50}$/.test(name) ? name : "";
}

function isLikelyXStatusUrl(statusUrl) {
  const u = safeString(statusUrl).trim();
  if (!u) return false;
  return /x\.com\/[^\/?#]+\/status\/\d+/i.test(u) || /x\.com\/i\/status\/\d+/i.test(u);
}

function isLoginLikeUrl(url) {
  const u = safeString(url).toLowerCase();
  return u.includes("/login") || u.includes("/i/flow/login");
}

function isBulkFollowStopRequested() {
  return bulkFollowStopRequested === true;
}

function resetBulkFollowJob() {
  bulkFollowJob = {
    running: false,
    tweetUrl: "",
    maxPerAccount: 0,
    startedAt: "",
    finishedAt: "",
    stopRequested: false,
    accountsTotal: 0,
    accountsDone: 0,
  };
  bulkFollowStopRequested = false;
}

function setBulkFollowStopRequested() {
  bulkFollowStopRequested = true;
  bulkFollowJob.stopRequested = true;
}

async function collectCommenterUsernames(page, options = {}) {
  const opt = options && typeof options === "object" ? options : {};
  const maxUsers = Math.max(50, Math.min(5000, Math.round(Number(opt.maxUsers) || 500)));
  const authorToExclude = safeString(opt.excludeAuthor).trim();

  const seen = new Set();
  let noNewRounds = 0;
  const maxNoNewRounds = Math.max(3, Math.min(20, Math.round(Number(opt.maxNoNewRounds) || 8)));
  const maxRounds = Math.max(20, Math.min(800, Math.round(Number(opt.maxRounds) || 240)));

  for (let round = 0; round < maxRounds; round += 1) {
    if (isBulkFollowStopRequested()) break;
    if (seen.size >= maxUsers) break;

    // eslint-disable-next-line no-await-in-loop
    const handles = await page
      .evaluate((excludeAuthor) => {
        const banned = new Set([
          "home",
          "explore",
          "search",
          "i",
          "settings",
          "compose",
          "notifications",
          "messages",
          "login",
          "logout",
        ]);

        const parseHandleFromHref = (href) => {
          if (!href || typeof href !== "string") return "";
          let pathname = "";
          try {
            pathname = new URL(href, location.origin).pathname || "";
          } catch {
            pathname = String(href || "");
          }
          if (!pathname.startsWith("/")) return "";
          if (pathname.startsWith("/i/")) return "";
          if (pathname.includes("/status/")) return "";

          const clean = pathname.replace(/\/+$/g, "");
          const parts = clean.split("/").filter(Boolean);
          if (parts.length !== 1) return "";
          const h = parts[0];
          if (!h) return "";
          if (!/^[A-Za-z0-9_]{1,50}$/.test(h)) return "";
          if (banned.has(h.toLowerCase())) return "";
          if (excludeAuthor && h.toLowerCase() === String(excludeAuthor).toLowerCase()) return "";
          return h;
        };

        const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
        const anchors = Array.from(root.querySelectorAll('article [data-testid="User-Name"] a[href]'));
        const out = [];
        for (const a of anchors) {
          const h = parseHandleFromHref(a.getAttribute("href") || "");
          if (!h) continue;
          out.push(h);
        }
        return Array.from(new Set(out));
      }, authorToExclude)
      .catch(() => []);

    const before = seen.size;
    for (const h of Array.isArray(handles) ? handles : []) {
      const s = safeString(h).trim();
      if (!s) continue;
      if (seen.size >= maxUsers) break;
      seen.add(s);
    }

    if (seen.size === before) noNewRounds += 1;
    else noNewRounds = 0;

    if (noNewRounds >= maxNoNewRounds) break;

    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85))).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await sleep(randomIntInclusive(700, 1400));
  }

  return Array.from(seen);
}

async function scanVisibleCommenterUsernames(page, excludeAuthor) {
  const authorToExclude = safeString(excludeAuthor).trim();
  const handles = await page
    .evaluate((excludeAuthor) => {
      const banned = new Set([
        "home",
        "explore",
        "search",
        "i",
        "settings",
        "compose",
        "notifications",
        "messages",
        "login",
        "logout",
      ]);

      const normalizePathname = (href) => {
        if (!href || typeof href !== "string") return "";
        try {
          return new URL(href, location.origin).pathname || "";
        } catch {
          return String(href || "");
        }
      };

      const parseHandleFromProfileHref = (href) => {
        const pathname = normalizePathname(href);
        if (!pathname.startsWith("/")) return "";
        if (pathname.startsWith("/i/")) return "";
        if (pathname.includes("/status/")) return "";

        const clean = pathname.replace(/\/+$/g, "");
        const parts = clean.split("/").filter(Boolean);
        if (parts.length !== 1) return "";
        const h = parts[0];
        if (!h) return "";
        if (!/^[A-Za-z0-9_]{1,50}$/.test(h)) return "";
        if (banned.has(h.toLowerCase())) return "";
        if (excludeAuthor && h.toLowerCase() === String(excludeAuthor).toLowerCase()) return "";
        return h;
      };

      const parseHandleFromStatusHref = (href) => {
        const pathname = normalizePathname(href);
        const m = pathname.match(/^\/([^\/?#]+)\/status\/\d+/i);
        if (!m) return "";
        const h = String(m[1] || "").trim();
        if (!h) return "";
        if (!/^[A-Za-z0-9_]{1,50}$/.test(h)) return "";
        if (banned.has(h.toLowerCase())) return "";
        if (excludeAuthor && h.toLowerCase() === String(excludeAuthor).toLowerCase()) return "";
        return h;
      };

      const root =
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.querySelector('main[role="main"]') ||
        document.body;
      const out = [];

      const articles = Array.from(root.querySelectorAll("article"));
      for (const article of articles) {
        // 优先从“时间戳(time)的 status 链接”里解析作者（最稳，且不会误抓正文 @ 提及）
        let h = "";
        try {
          const timeEl = article.querySelector("time");
          const statusA = timeEl ? timeEl.closest("a[href]") : null;
          const href = statusA ? statusA.getAttribute("href") || statusA.href || "" : "";
          h = parseHandleFromStatusHref(href);
        } catch {}

        // 兜底：再从“作者区”的主页链接解析（避免误抓正文 @ 提及链接）
        if (!h) {
          const a1 = article.querySelector('[data-testid="User-Name"] a[href]');
          const href = a1 ? a1.getAttribute("href") || a1.href || "" : "";
          h = parseHandleFromProfileHref(href);
        }

        // 兜底：某些 UI 结构可能没有 data-testid="User-Name"，再从 article 内挑选“非正文(tweetText)区域”的主页链接
        // 注意：正文里也可能包含 @ 提及链接，因此这里排除 tweetText 容器，减少误抓概率。
        if (!h) {
          try {
            const links = Array.from(article.querySelectorAll('a[href][role="link"]'));
            for (const a of links) {
              if (a.closest('[data-testid="tweetText"]')) continue;
              const href = a.getAttribute("href") || a.href || "";
              const hh = parseHandleFromProfileHref(href);
              if (hh) {
                h = hh;
                break;
              }
            }
          } catch {}
        }

        if (!h) continue;
        out.push(h);
      }

      return Array.from(new Set(out));
    }, authorToExclude)
    .catch(() => []);

  return Array.isArray(handles) ? handles.map((h) => safeString(h).trim()).filter(Boolean) : [];
}

async function isProtectedProfilePage(page) {
  const text = await page
    .evaluate(() => (document.body ? document.body.innerText || "" : ""))
    .catch(() => "");
  const t = String(text || "");
  return (
    /These Tweets are protected/i.test(t) ||
    /Protected Tweets/i.test(t) ||
    /Only confirmed followers have access/i.test(t) ||
    /这些推文受保护/i.test(t) ||
    /推文受保护/i.test(t) ||
    /受保护的推文/i.test(t) ||
    /只有经确认的关注者/i.test(t)
  );
}

async function followUserFromProfile(page) {
  const followBtnSel = '[data-testid$="-follow"]';
  const unfollowBtnSel = '[data-testid$="-unfollow"]';

  // 等待按钮渲染（弱网/代理环境下首屏渲染可能较慢）
  await page.waitForSelector(`${unfollowBtnSel}, ${followBtnSel}`, { timeout: 8000 }).catch(() => {});

  const unfollowBtn = await page.$(unfollowBtnSel);
  if (unfollowBtn) return { status: "already_following" };

  let followBtn = await page.$(followBtnSel);
  if (!followBtn) {
    // 兼容某些 UI 变体：按钮被包在 placementTracking 里（文本可能是 Follow/Follow back/关注）
    const alt = await page.$('[data-testid="placementTracking"] [role="button"]');
    if (alt) {
      const txt = await alt.evaluate((b) => (b && (b.innerText || b.textContent) ? String(b.innerText || b.textContent) : "")).catch(() => "");
      if (/\bfollow\b/i.test(txt) || /关注/.test(txt)) {
        followBtn = alt;
      }
    }
  }
  if (!followBtn) return { status: "button_not_found" };

  await followBtn.evaluate((b) => b.scrollIntoView({ block: "center" })).catch(() => {});
  await sleep(200);
  await followBtn.click().catch(() => {});

  // 等待 UI 变为 Following（unfollow 出现），否则可能是受保护账号/被限制/未刷新
  await page.waitForSelector(unfollowBtnSel, { timeout: 5000 }).catch(() => {});

  const unfollowAfter = await page.$(unfollowBtnSel);
  if (unfollowAfter) return { status: "followed" };

  // 可能是请求关注（受保护账号）或 UI 未及时刷新：交给上层按 warning 处理
  return { status: "clicked" };
}

async function bulkFollowCommentersForAccount(account, tweetUrl, options = {}) {
  const a = account && typeof account === "object" ? account : null;
  if (!a) throw new Error("账号不存在");

  const exe = findLocalBrowser();
  if (!exe) throw new Error("关注需要本地 Chrome/Edge。");

  const profileDirValue = safeString(a?.x?.profileDir).trim();
  if (!profileDirValue) throw new Error("未绑定浏览器 Profile：请先点“打开浏览器登录”完成登录");
  const profileDir = resolveAppDirPath(profileDirValue);
  if (!profileDir) throw new Error("Profile 目录解析失败");

  await fs.mkdir(profileDir, { recursive: true });

  const proxyUrl = getBulkProxyUrl(a);
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--window-position=0,0",
    "--window-size=1280,800",
  ];
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    ignoreDefaultArgs: ["--enable-automation"],
    args,
  });

  const summary = {
    ok: true,
    collected: 0,
    followed: 0,
    skipped: 0,
    warnings: 0,
    failed: 0,
  };

  try {
    // 说明：Puppeteer headful + userDataDir 场景下，Chrome 可能会因为“恢复会话/新标签页/扩展页”等原因
    // 自动打开多个标签页。为了避免「多开空白页」以及“选错 tab 导致 scanned=0”，这里强制新建一个工作页。
    const initialPages = await browser.pages().catch(() => []);
    const commentPage = await browser.newPage();
    let actionPage = null;

    const closeOtherBlankTabs = async () => {
      const pages = await browser.pages().catch(() => []);
      for (const p of pages) {
        if (p === commentPage) continue;
        if (actionPage && p === actionPage) continue;
        const u = safeString(p.url()).trim().toLowerCase();
        if (!u || u === "about:blank" || u.startsWith("chrome://newtab")) {
          // eslint-disable-next-line no-await-in-loop
          await p.close().catch(() => {});
        }
      }
    };

    // 关闭启动时遗留的标签页（保留我们自己的工作页）
    for (const p of initialPages) {
      await p.close().catch(() => {});
    }
    await closeOtherBlankTabs();

    await commentPage.bringToFront().catch(() => {});
    try {
      await commentPage.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      throw new Error(`打开推文失败：${safeString(e?.message || e)}`);
    }

    await closeOtherBlankTabs();

    if (isLoginLikeUrl(commentPage.url())) {
      throw new Error("未登录：请先点“打开浏览器登录”完成登录");
    }

    await commentPage.waitForSelector("article", { timeout: 15_000 }).catch(() => {});
    await sleep(900);
    // 给评论/回复一点加载时间（否则很容易只看到主推文作者，exclude 后会变成 0）
    await commentPage.waitForFunction(() => document.querySelectorAll("article").length > 1, { timeout: 6000 }).catch(() => {});

    const remainDaily = Math.max(0, Math.round(Number(options.remainDaily || 0)));
    const maxFollow = Math.max(1, Math.round(Number(options.maxFollow || 0) || 1));
    const effectiveFollowLimit = Math.max(1, Math.min(remainDaily || maxFollow, maxFollow));
    const authorFromUrl = extractStatusAuthorFromUrl(tweetUrl);

    // 逐步扫描评论用户 + 逐个进入关注：避免先把大量评论用户全部收集完（大帖会很慢）
    const maxRounds = 260;
    const maxNoNewRounds = 8;
    const maxScanUsers = Math.min(5000, Math.max(150, effectiveFollowLimit * 12));

    const seen = new Set();
    const pending = [];
    let noNewRounds = 0;
    let rounds = 0;
    let emptyDiagLogged = false;

    const enqueueHandles = (items) => {
      let added = 0;
      for (const h of Array.isArray(items) ? items : []) {
        const s = safeString(h).trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        if (seen.size >= maxScanUsers) break;
        seen.add(s);
        pending.push(s);
        added += 1;
      }
      summary.collected = seen.size;
      return added;
    };

    while (true) {
      if (isBulkFollowStopRequested()) break;
      if (summary.followed >= effectiveFollowLimit) break;

      const state = upsertBulkState(a.id);
      ensureBulkFollowDailyState(state);
      if (getBulkFollowRemaining(state) <= 0) break;

      if (pending.length === 0) {
        await commentPage.bringToFront().catch(() => {});
        rounds += 1;
        if (rounds > maxRounds) {
          addBulkLog(
            `[关注] 扫描轮次已达上限，提前结束 account=${safeString(a.name || a.id)} followed=${summary.followed}/${effectiveFollowLimit} scanned=${seen.size}`,
          );
          break;
        }

        const found = await scanVisibleCommenterUsernames(commentPage, authorFromUrl);
        const added = enqueueHandles(found);
        if (added === 0) noNewRounds += 1;
        else noNewRounds = 0;

        if (added > 0) {
          const sample = pending
            .slice(0, 3)
            .map((u) => `@${safeString(u)}`)
            .join(",");
          addBulkLog(
            `[关注][DBG] 扫描新增 added=${added} queued=${pending.length} total=${seen.size}${sample ? ` sample=${sample}` : ""}`,
          );
        }

        // 首轮/弱网时评论加载可能较慢：seen=0 时多给一些轮次，避免刚开始就判定“无评论”
        const noNewLimit = seen.size === 0 ? 80 : maxNoNewRounds;

        if (!emptyDiagLogged && seen.size === 0 && noNewRounds >= 5) {
          emptyDiagLogged = true;
          const diag = await commentPage
            .evaluate(() => {
              const url = location.href || "";
              const articles = document.querySelectorAll("article").length;
              const hasPrimary = Boolean(document.querySelector('[data-testid="primaryColumn"]'));
              const hasMain = Boolean(document.querySelector('main[role="main"]'));
              return { url, articles, hasPrimary, hasMain };
            })
            .catch(() => null);
          if (diag && typeof diag === "object") {
            addBulkLog(
              `[关注][DBG] 扫描仍为空：url=${safeString(diag.url)} articles=${Number(diag.articles || 0)} primary=${Boolean(
                diag.hasPrimary,
              )} main=${Boolean(diag.hasMain)}`,
            );
          }
        }

        // 继续滚动加载更多评论
        await commentPage.mouse.move(640, 400).catch(() => {});
        await commentPage.mouse.wheel({ deltaY: randomIntInclusive(650, 980) }).catch(() => {});
        await commentPage
          .evaluate(() => {
            const delta = Math.floor(window.innerHeight * 0.85);
            try {
              window.scrollBy(0, delta);
            } catch {}

            // 有时滚动容器并不是 window（例如某些布局/嵌套滚动），这里尝试找到可滚动父容器并滚动。
            try {
              const primary = document.querySelector('[data-testid="primaryColumn"]');
              let el = primary || (document.scrollingElement && document.scrollingElement !== document.body ? document.scrollingElement : null);
              for (let i = 0; i < 8 && el; i += 1) {
                const style = window.getComputedStyle(el);
                const canScroll = (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20;
                if (canScroll) {
                  el.scrollBy(0, delta);
                  break;
                }
                el = el.parentElement;
              }
            } catch {}

            // 有些推文需要点“显示更多回复/Show more replies”才会展开，做一次轻量兜底点击（找不到就算了）。
            try {
              const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
              const btns = Array.from(root.querySelectorAll('[role="button"]'));
              const patterns = ["show more replies", "show replies", "显示更多回复", "查看更多回复", "展开更多回复"];
              for (const b of btns) {
                const text = (b.innerText || b.textContent || "").trim();
                if (!text) continue;
                const t = text.toLowerCase();
                if (patterns.some((p) => t.includes(p.toLowerCase()))) {
                  b.click();
                  break;
                }
              }
            } catch {}
          })
          .catch(() => {});
        await sleep(randomIntInclusive(700, 1400));

        // 评论区已没有新用户了：提前结束
        if (pending.length === 0 && (noNewRounds >= noNewLimit || seen.size >= maxScanUsers)) {
          addBulkLog(
            `[关注] 评论用户已耗尽/无新增，提前结束 account=${safeString(a.name || a.id)} followed=${summary.followed}/${effectiveFollowLimit} scanned=${seen.size}`,
          );
          break;
        }

        // 本轮没拿到用户，继续下一轮扫描
        if (pending.length === 0) continue;
      }

      const username = safeString(pending.shift()).trim();
      if (!username) continue;

      const profileUrl = `https://x.com/${username}`;

      if (!actionPage) {
        actionPage = await browser.newPage();
        await closeOtherBlankTabs();
      }

      try {
        addBulkLog(`[关注] 进入主页 account=${safeString(a.name || a.id)} user=@${username}`);
        await actionPage.bringToFront().catch(() => {});
        await actionPage.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (e) {
        summary.failed += 1;
        addBulkLog(`[关注] 进入主页失败 account=${safeString(a.name || a.id)} user=@${username} error=${safeString(e?.message || e)}`);
        await sleep(randomIntInclusive(900, 1600));
        continue;
      }

      // 导航兜底：如果最终 URL 并不是目标用户主页，就不要继续点击（避免误操作）。
      {
        const currentUrl = safeString(actionPage.url()).toLowerCase();
        const u = username.toLowerCase();
        if (!currentUrl.includes(`x.com/${u}`) && !currentUrl.includes(`twitter.com/${u}`)) {
          summary.skipped += 1;
          summary.warnings += 1;
          addBulkLog(`[关注][WARN] 导航后 URL 非目标主页，跳过 account=${safeString(a.name || a.id)} user=@${username} url=${currentUrl}`);
          await sleep(randomIntInclusive(900, 1600));
          continue;
        }
      }

      await sleep(randomIntInclusive(800, 1400));

      if (isLoginLikeUrl(actionPage.url())) {
        throw new Error("未登录：请先点“打开浏览器登录”完成登录");
      }

      const protectedProfile = await isProtectedProfilePage(actionPage).catch(() => false);
      if (protectedProfile) {
        summary.skipped += 1;
        summary.warnings += 1;
        addBulkLog(`[关注][WARN] 受保护账号，跳过 account=${safeString(a.name || a.id)} user=@${username}`);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const r = await followUserFromProfile(actionPage).catch((e) => ({ status: "error", error: safeString(e?.message || e) }));

      if (r.status === "already_following") {
        summary.skipped += 1;
        summary.warnings += 1;
        addBulkLog(`[关注][WARN] 已关注过，跳过 account=${safeString(a.name || a.id)} user=@${username}`);
        continue;
      }

      if (r.status === "button_not_found") {
        summary.skipped += 1;
        summary.warnings += 1;
        addBulkLog(`[关注][WARN] 未找到关注按钮，跳过 account=${safeString(a.name || a.id)} user=@${username}`);
        continue;
      }

      if (r.status === "followed") {
        summary.followed += 1;
        if (summary.followed >= effectiveFollowLimit) {
          addBulkLog(`[关注] 已达本次上限 account=${safeString(a.name || a.id)} limit=${effectiveFollowLimit}`);
        }
        const state = upsertBulkState(a.id);
        ensureBulkFollowDailyState(state);
        state.followDailyCount = Math.max(0, Math.round(Number(state.followDailyCount) || 0)) + 1;
        const remainHint = Math.max(0, effectiveFollowLimit - summary.followed);
        addBulkLog(
          `[关注] 已关注 account=${safeString(a.name || a.id)} user=@${username} remain=${remainHint}/${effectiveFollowLimit} today=${state.followDailyCount}/${BULK_FOLLOW_COMMENTERS_DAILY_LIMIT}`,
        );

        // eslint-disable-next-line no-await-in-loop
        await sleep(randomIntInclusive(1100, 2400));
        continue;
      }

      if (r.status === "clicked") {
        summary.failed += 1;
        summary.warnings += 1;
        addBulkLog(
          `[关注][WARN] 已点击关注但未验证成功（可能被限制/受保护/界面未刷新），跳过 account=${safeString(a.name || a.id)} user=@${username}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(randomIntInclusive(900, 1600));
        continue;
      }

      summary.failed += 1;
      addBulkLog(`[关注] 失败 account=${safeString(a.name || a.id)} user=@${username} error=${safeString(r.error || r.status)}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(randomIntInclusive(900, 1600));
    }

    return summary;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runBulkFollowCommenters(tweetUrl, options = {}) {
  const url = normalizeXStatusUrl(tweetUrl);
  if (!url) throw new Error("缺少 tweetUrl");
  if (!isLikelyXStatusUrl(url)) throw new Error("链接不合法：请提供 X 推文链接（包含 /status/）");

  if (bulkFollowJob?.running) throw new Error("关注任务正在运行中，请先停止或等待结束");

  const maxPerAccountRaw = Math.round(Number(options?.maxPerAccount) || 30);
  const maxPerAccount = Math.max(1, Math.min(BULK_FOLLOW_COMMENTERS_DAILY_LIMIT, maxPerAccountRaw));

  bulkFollowStopRequested = false;
  bulkFollowJob.running = true;
  bulkFollowJob.stopRequested = false;
  bulkFollowJob.tweetUrl = url;
  bulkFollowJob.maxPerAccount = maxPerAccount;
  bulkFollowJob.startedAt = nowIso();
  bulkFollowJob.finishedAt = "";
  bulkFollowJob.accountsDone = 0;

  const accounts = getBulkAccounts().filter((a) => Boolean(a?.followCommentersEnabled));
  bulkFollowJob.accountsTotal = accounts.length;

  addBulkLog(
    `[关注] 开始 tweet=${url} accounts=${accounts.length} limit=本次每号${maxPerAccount}, 每天每号${BULK_FOLLOW_COMMENTERS_DAILY_LIMIT}`,
  );

  for (const a of accounts) {
    if (isBulkFollowStopRequested()) break;

    const id = safeString(a?.id).trim();
    if (!id) continue;
    const state = upsertBulkState(id);
    if (!state) continue;

    ensureBulkFollowDailyState(state);
    state.followRunning = true;
    state.followLastRunAt = nowIso();
    state.followLastTweetUrl = url;
    state.followDone = 0;
    state.followSkipped = 0;
    state.followWarnings = 0;
    state.followFailed = 0;
    state.followLastError = "";
    state.followLastErrorAt = "";

    const remainDaily = getBulkFollowRemaining(state);
    const remain = Math.min(remainDaily, maxPerAccount);
    if (remainDaily <= 0) {
      addBulkLog(`[关注] 今日已达上限，跳过 account=${safeString(a.name || a.id)} today=${state.followDailyCount}/${BULK_FOLLOW_COMMENTERS_DAILY_LIMIT}`);
      state.followRunning = false;
      bulkFollowJob.accountsDone += 1;
      continue;
    }
    if (remain <= 0) {
      addBulkLog(`[关注] 已达本次上限，跳过 account=${safeString(a.name || a.id)} perRun=${maxPerAccount}`);
      state.followRunning = false;
      bulkFollowJob.accountsDone += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await bulkFollowCommentersForAccount(a, url, { remainDaily, maxFollow: remain });
      state.followDone = Number(r?.followed || 0);
      state.followSkipped = Number(r?.skipped || 0);
      state.followWarnings = Number(r?.warnings || 0);
      state.followFailed = Number(r?.failed || 0);
      addBulkLog(
        `[关注] 完成 account=${safeString(a.name || a.id)} followed=${state.followDone} skipped=${state.followSkipped} warn=${state.followWarnings} failed=${state.followFailed} today=${state.followDailyCount}/${BULK_FOLLOW_COMMENTERS_DAILY_LIMIT}`,
      );
    } catch (e) {
      state.followLastError = safeString(e?.message || e);
      state.followLastErrorAt = nowIso();
      addBulkLog(`[关注] 账号执行失败 account=${safeString(a.name || a.id)} error=${state.followLastError}`);
    } finally {
      state.followRunning = false;
      bulkFollowJob.accountsDone += 1;
    }

    // 每个账号之间稍微停一下，避免密集行为
    // eslint-disable-next-line no-await-in-loop
    await sleep(randomIntInclusive(2000, 4500));
  }

  bulkFollowJob.running = false;
  bulkFollowJob.finishedAt = nowIso();

  if (isBulkFollowStopRequested()) addBulkLog("[关注] 已停止");
  else addBulkLog("[关注] 全部账号已完成");
}

function normalizeBulkConfig(raw) {
  const next = raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : defaultBulkConfig();
  if (!next || typeof next !== "object") return defaultBulkConfig();

  next.version = 1;
  next.imageDir = safeString(next.imageDir).trim();
  if (!next.imageDir) next.imageDir = "data/bulk-images";

  const scan = Number(next.scanIntervalSec ?? 3600);
  next.scanIntervalSec = Number.isFinite(scan) ? Math.max(300, Math.round(scan)) : 3600;

  // 代理按账号配置（account.proxy），不再使用全局默认/代理池
  delete next.defaultProxy;
  delete next.proxyPool;

  if (typeof next.captions === "string") next.captions = next.captions.split(/\r?\n/g);
  if (!Array.isArray(next.captions)) next.captions = [];
  next.captions = next.captions.map((s) => safeString(s).trim()).filter(Boolean);

  if (!Array.isArray(next.accounts)) next.accounts = [];
  next.accounts = next.accounts.map((a) => normalizeBulkAccount(a)).filter(Boolean);

  return next;
}

function resolveBulkImageDir(cfg) {
  const raw = safeString(cfg?.imageDir).trim();
  const value = raw || "data/bulk-images";
  if (value === "data/bulk-images") return BULK_IMAGES_DEFAULT_DIR;
  return path.isAbsolute(value) ? value : path.resolve(APP_DIR, value);
}

function isImageFileName(fileName) {
  const ext = safeString(path.extname(fileName)).trim().toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

	  if (!(await fileExists(CONFIG_EXAMPLE_PATH))) {
	    await writeJson(CONFIG_EXAMPLE_PATH, {
	      twitterApi: { baseUrl: "https://api.twitterapi.io", apiKey: "" },
	      monitor: { targets: [], pollIntervalSec: 60, fetchLimit: 20, includeReplies: false, includeQuoteTweets: true, skipMentions: false },
	      forward: {
	        enabled: false,
	        mode: "retweet",
	        dryRun: true,
	        sendIntervalSec: 5,
	        translateToZh: false,
	        proxy: "",
	        x: { apiKey: "", apiSecret: "", accessToken: "", accessSecret: "" },
	      },
	    });
	  }

  if (!(await fileExists(CONFIG_PATH))) {
    await writeJson(CONFIG_PATH, {});
  }

  if (!(await fileExists(DB_PATH))) {
    await writeJson(DB_PATH, { version: 1, targets: {}, queue: [] });
  }

  if (!(await fileExists(BULK_CONFIG_PATH))) {
    await writeJson(BULK_CONFIG_PATH, defaultBulkConfig());
  }
}

const logs = [];
const bulkLogs = [];
const stats = {
  apiCalls: 0,
  xCalls: 0,
  translateCalls: 0,
};

function addLog(message, extra) {
  const entry = {
    time: nowTime(),
    message: extra ? `${message} ${safeString(extra)}` : message,
  };
  logs.push(entry);
  while (logs.length > LOG_LIMIT) logs.shift();
}

function addBulkLog(message, extra) {
  const entry = {
    time: nowTime(),
    message: extra ? `${message} ${safeString(extra)}` : message,
  };
  bulkLogs.push(entry);
  while (bulkLogs.length > BULK_LOG_LIMIT) bulkLogs.shift();
}

function createTwitterClient(config) {
  const baseUrl = config?.twitterApi?.baseUrl || "https://api.twitterapi.io";
  const apiKey = config?.twitterApi?.apiKey || "";
  return axios.create({
    baseURL: baseUrl,
    timeout: 30_000,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    validateStatus: () => true,
  });
}

function formatAxiosError(err) {
  if (!err) return "未知错误";
  if (err.response) {
    return `HTTP ${err.response.status}: ${safeString(err.response.data?.msg || err.response.data?.message || err.response.data)}`;
  }
  return safeString(err.message || err);
}

async function twitterGetLastTweets(config, userName, cursor) {
  const client = createTwitterClient(config);
  stats.apiCalls += 1;
  const params = {
    userName,
    includeReplies: Boolean(config?.monitor?.includeReplies),
  };
  const c = safeString(cursor).trim();
  if (c) params.cursor = c;
  const res = await client.get("/twitter/user/last_tweets", {
    params,
  });
  return res;
}

async function twitterGetTweetsByIds(config, tweetIds) {
  const ids = Array.isArray(tweetIds) ? tweetIds.map((t) => safeString(t).trim()).filter(Boolean) : [];
  if (ids.length === 0) throw new Error("tweetIds 不能为空");

  const client = createTwitterClient(config);
  stats.apiCalls += 1;
  const res = await client.get("/twitter/tweets", {
    params: { tweet_ids: ids.join(",") },
  });
  return res;
}

function getXProxyUrlFromEnv() {
  return safeString(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY).trim();
}

function getXProxyUrl(config) {
  const cfgProxy = safeString(config?.forward?.proxy).trim();
  if (cfgProxy) return cfgProxy;
  return getXProxyUrlFromEnv();
}

function redactUrlCredentials(url) {
  const raw = safeString(url).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/([^@]+)@/g, "//***:***@");
  }
}

function getXCredentialsFromEnv() {
  return {
    appKey: safeString(process.env.X_API_KEY).trim(),
    appSecret: safeString(process.env.X_API_SECRET).trim(),
    accessToken: safeString(process.env.X_ACCESS_TOKEN).trim(),
    accessSecret: safeString(process.env.X_ACCESS_SECRET).trim(),
  };
}

function getXCredentials(config) {
  const x = config?.forward?.x && typeof config.forward.x === "object" ? config.forward.x : {};
  const env = getXCredentialsFromEnv();
  return {
    appKey: safeString(x?.apiKey).trim() || env.appKey,
    appSecret: safeString(x?.apiSecret).trim() || env.appSecret,
    accessToken: safeString(x?.accessToken).trim() || env.accessToken,
    accessSecret: safeString(x?.accessSecret).trim() || env.accessSecret,
  };
}

function validateXCredentials(creds) {
  if (!creds?.appKey) return "缺少 X API Key（请在页面配置或 .env 填 X_API_KEY）";
  if (!creds?.appSecret) return "缺少 X API Secret（请在页面配置或 .env 填 X_API_SECRET）";
  if (!creds?.accessToken) return "缺少 X Access Token（请在页面配置或 .env 填 X_ACCESS_TOKEN）";
  if (!creds?.accessSecret) return "缺少 X Access Token Secret（请在页面配置或 .env 填 X_ACCESS_SECRET）";
  return "";
}

function createXClient(config) {
  const creds = getXCredentials(config);
  const err = validateXCredentials(creds);
  if (err) throw new Error(err);

  const proxyUrl = getXProxyUrl(config);
  const settings = {};
  if (proxyUrl) {
    try {
      settings.httpAgent = new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      throw new Error(`HTTPS_PROXY 无效：${safeString(e?.message || e)}`);
    }
  }

  return {
    client: new TwitterApi(
      {
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken: creds.accessToken,
        accessSecret: creds.accessSecret,
      },
      settings,
    ),
    proxyUrl,
  };
}

async function getXLoggedUserId(xClient) {
  try {
    const me = await xClient.v2.get("users/me", {}, { timeout: X_REQUEST_TIMEOUT_MS });
    const id = safeString(me?.data?.id).trim();
    if (id) return id;
  } catch {}

  const user = await xClient.v1.get("account/verify_credentials.json", {}, { timeout: X_REQUEST_TIMEOUT_MS });
  return safeString(pickFirstString(user?.id_str, user?.id)).trim();
}

function truncateTweetText(text, maxLen) {
  const s = safeString(text);
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, maxLen);
  return `${s.slice(0, maxLen - 1)}…`;
}

function formatXError(err) {
  if (!err) return "未知错误";
  const code = Number(err?.code || err?.statusCode || err?.status) || 0;
  if (err.data) {
    const msg = safeString(err.data?.detail || err.data?.title || err.data?.error || err.data);
    return code ? `HTTP ${code}：${msg}` : msg;
  }
  const msg = safeString(err.message || err);
  return code ? `HTTP ${code}：${msg}` : msg;
}

function formatXRequestCause(err) {
  const e = err && typeof err === "object" ? err : null;
  if (!e) return "";

  const inner =
    e?.requestError ||
    e?._options?.requestError ||
    e?._options?.error ||
    e?.cause ||
    e?.error;

  const innerMsg = safeString(inner?.message || inner).trim();
  const innerCode = safeString(inner?.code).trim();
  if (innerCode && innerMsg) return `${innerCode}:${innerMsg}`;
  if (innerCode) return innerCode;
  return innerMsg;
}

function formatXErrorVerbose(err, ctx = {}) {
  const base = formatXError(err);
  const e = err && typeof err === "object" ? err : null;

  const parts = [];
  const type = safeString(e?.type || e?.name).trim();
  if (type) parts.push(`type=${type}`);

  const cause = formatXRequestCause(e);
  if (cause && !safeString(base).includes(cause)) parts.push(`cause=${cause}`);

  const proxy = safeString(ctx?.proxy).trim();
  if (proxy) parts.push(`proxy=${redactUrlCredentials(proxy)}`);

  if (parts.length === 0) return base;
  return `${base} (${parts.join(", ")})`;
}

const proxyAgentCache = new Map();

function getCachedHttpsProxyAgent(proxyUrl) {
  const key = safeString(proxyUrl).trim();
  if (!key) return null;
  if (proxyAgentCache.has(key)) return proxyAgentCache.get(key);
  const agent = new HttpsProxyAgent(key);
  proxyAgentCache.set(key, agent);
  return agent;
}

function guessImageMimeTypeFromUrl(url) {
  const u = safeString(url).trim().toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

function extensionForMimeType(mimeType) {
  const m = safeString(mimeType).trim().toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  return "bin";
}

function mimeTypeFromFileName(fileName) {
  const ext = safeString(path.extname(fileName)).trim().toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "";
}

async function findExistingMediaFile(dir, index) {
  const base = `media-${index + 1}`;
  const exts = ["jpg", "jpeg", "png", "gif", "webp", "bin"];
  for (const ext of exts) {
    const candidate = path.join(dir, `${base}.${ext}`);
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

async function readPreparedCache(dir) {
  const preparedPath = path.join(dir, "prepared.json");
  const raw = await fs.readFile(preparedPath, "utf8");
  const cached = JSON.parse(raw);

  const tweetId = safeString(cached?.tweetId).trim();
  const text = safeString(cached?.text).trim();
  const textZh = safeString(cached?.textZh).trim();
  const photoUrls = Array.isArray(cached?.photoUrls) ? cached.photoUrls.map((u) => safeString(u).trim()).filter(Boolean) : [];

  const mediaMeta = Array.isArray(cached?.media) ? cached.media : [];
  const media = [];
  for (const m of mediaMeta) {
    const fileName = safeString(m?.fileName).trim();
    if (!fileName) continue;
    const filePath = path.join(dir, fileName);
    // eslint-disable-next-line no-await-in-loop
    const buffer = await fs.readFile(filePath);
    const mimeType = safeString(m?.mimeType).trim() || mimeTypeFromFileName(fileName) || guessImageMimeTypeFromUrl(m?.url);
    media.push({
      url: safeString(m?.url).trim(),
      shortUrl: safeString(m?.shortUrl).trim(),
      mimeType,
      buffer,
      fileName,
    });
  }

  return {
    tweetId,
    text,
    textZh,
    photoUrls,
    downloadDir: dir,
    media,
    cached: true,
    proxy: redactUrlCredentials(getXProxyUrlFromEnv()),
  };
}

function containsCjk(text) {
  return /[\u4e00-\u9fff]/.test(safeString(text));
}

async function googleTranslateToZh(text, proxyUrl) {
  const q = safeString(text).trim();
  if (!q) return "";
  if (containsCjk(q)) return q;

  const agent = getCachedHttpsProxyAgent(proxyUrl);
  stats.translateCalls = (stats.translateCalls || 0) + 1;
  const res = await axios.get("https://translate.googleapis.com/translate_a/single", {
    params: {
      client: "gtx",
      sl: "auto",
      tl: "zh-CN",
      dt: "t",
      q,
    },
    timeout: 30_000,
    validateStatus: () => true,
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
  });

  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`谷歌翻译失败：HTTP ${res.status}`);
    err.upstream = "google-translate";
    err.code = Number(res.status) || 0;
    err.headers = res.headers;
    err.data = res.data;
    throw err;
  }

  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      const err = new Error("谷歌翻译返回非 JSON（可能被拦截/限流）");
      err.upstream = "google-translate";
      err.code = 0;
      err.data = res.data;
      throw err;
    }
  }

  const segments = Array.isArray(data) ? data[0] : null;
  if (!Array.isArray(segments)) {
    const err = new Error("谷歌翻译返回结构异常");
    err.upstream = "google-translate";
    err.code = 0;
    err.data = data;
    throw err;
  }

  const translated = segments
    .map((s) => (Array.isArray(s) ? safeString(s[0]) : ""))
    .join("")
    .trim();

  if (!translated) {
    const err = new Error("谷歌翻译结果为空");
    err.upstream = "google-translate";
    err.code = 0;
    err.data = data;
    throw err;
  }

  return translated;
}

function getXRateLimitResetMs(err) {
  const directReset = Number(err?.rateLimit?.reset) || 0;
  if (Number.isFinite(directReset) && directReset > 0) return directReset * 1000;

  const headerReset =
    (typeof err?.headers?.["x-rate-limit-reset"] === "string" && err.headers["x-rate-limit-reset"]) ||
    (typeof err?.headers?.["x-rate-limit-reset"] === "number" && String(err.headers["x-rate-limit-reset"])) ||
    "";
  const parsed = parseInt(String(headerReset || "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;

  return 0;
}

function computeRetryScheduleFromXError(err, attempts) {
  const now = Date.now();
  const code = Number(err?.code || err?.statusCode || err?.status) || 0;
  const isRateLimit = code === 420 || code === 429 || err?.rateLimitError === true;

  if (isRateLimit) {
    const resetMs = getXRateLimitResetMs(err);
    if (resetMs > now) {
      const nextMs = resetMs + 5_000;
      const delaySeconds = Math.max(5, Math.ceil((nextMs - now) / 1000));
      return { delaySeconds, nextAttemptAt: new Date(nextMs).toISOString() };
    }
    const delaySeconds = Math.max(60, computeBackoffSeconds(attempts));
    return { delaySeconds, nextAttemptAt: new Date(now + delaySeconds * 1000).toISOString() };
  }

  const delaySeconds = computeBackoffSeconds(attempts);
  return { delaySeconds, nextAttemptAt: new Date(now + delaySeconds * 1000).toISOString() };
}

function getTwitterApiIoRateLimitResetMs(err) {
  const headers = err?.headers && typeof err.headers === "object" ? err.headers : {};

  const retryAfter = safeString(headers["retry-after"]).trim();
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate) && asDate > 0) return asDate;
  }

  const resetHeader =
    safeString(headers["x-ratelimit-reset"]).trim() ||
    safeString(headers["x-rate-limit-reset"]).trim() ||
    safeString(headers["ratelimit-reset"]).trim();
  if (!resetHeader) return 0;

  const n = parseInt(resetHeader, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 10_000_000_000) return n; // 已是毫秒
  return n * 1000; // 视作 epoch seconds
}

function computeRetryScheduleFromError(err, attempts) {
  const upstream = safeString(err?.upstream).trim().toLowerCase();
  const code = Number(err?.code || err?.statusCode || err?.status) || 0;

  if (upstream === "twitterapi.io" && code === 429) {
    const now = Date.now();
    const resetMs = getTwitterApiIoRateLimitResetMs(err);
    if (resetMs > now) {
      const nextMs = resetMs + 5_000;
      const delaySeconds = Math.max(5, Math.ceil((nextMs - now) / 1000));
      return { delaySeconds, nextAttemptAt: new Date(nextMs).toISOString() };
    }

    const delaySeconds = Math.max(60, computeBackoffSeconds(attempts));
    return { delaySeconds, nextAttemptAt: new Date(now + delaySeconds * 1000).toISOString() };
  }

  return computeRetryScheduleFromXError(err, attempts);
}

async function downloadImageToBuffer(url, proxyUrl) {
  const targetUrl = safeString(url).trim();
  if (!targetUrl) throw new Error("图片 URL 为空");

  const agent = getCachedHttpsProxyAgent(proxyUrl);
  const res = await axios.get(targetUrl, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: 15 * 1024 * 1024,
    validateStatus: () => true,
    headers: { Accept: "image/*,*/*" },
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`图片下载失败：HTTP ${res.status}`);
  }

  const contentTypeRaw = safeString(res.headers?.["content-type"]);
  const contentType = contentTypeRaw.split(";")[0].trim();
  const mimeType = contentType || guessImageMimeTypeFromUrl(targetUrl) || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`图片类型不支持：${mimeType || "unknown"}`);
  }

  const buf = Buffer.from(res.data || []);
  if (buf.length === 0) throw new Error("图片下载为空");
  return { buffer: buf, mimeType };
}

async function fetchSourceTweetForRepost(config, tweetId) {
  const id = safeString(tweetId).trim();
  if (!id) throw new Error("tweetId 为空");

  const res = await twitterGetTweetsByIds(config, [id]);
  if (res.status === 401) {
    const err = new Error("twitterapi.io API Key 无效或未授权");
    err.upstream = "twitterapi.io";
    err.code = 401;
    err.headers = res.headers;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error("twitterapi.io 命中限流");
    err.upstream = "twitterapi.io";
    err.code = 429;
    err.headers = res.headers;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`twitterapi.io HTTP ${res.status}：${safeString(res.data?.message || res.data?.msg || res.data)}`);
    err.upstream = "twitterapi.io";
    err.code = Number(res.status) || 0;
    err.headers = res.headers;
    throw err;
  }
  if (res.data?.status && res.data.status !== "success") {
    const err = new Error(`twitterapi.io 返回 error：${safeString(res.data?.message || res.data?.msg)}`);
    err.upstream = "twitterapi.io";
    err.code = Number(res.status) || 0;
    err.headers = res.headers;
    throw err;
  }

  const tweets = extractTweetArrayFromApiResponse(res.data);
  const hit = tweets.find((t) => extractTweetId(t) === id) || tweets[0];
  if (!hit) throw new Error("twitterapi.io 未返回 tweet 详情");
  return hit;
}

async function prepareRepostFromTweet(config, tweetId, fallbackText, options = {}) {
  const id = safeString(tweetId).trim();
  const download = Boolean(options.download);
  const requireSourceTweet = options.requireSourceTweet !== undefined ? Boolean(options.requireSourceTweet) : true;
  const strictPhotos = options.strictPhotos !== undefined ? Boolean(options.strictPhotos) : true;
  const proxyUrl = getXProxyUrl(config);
  const translateToZh = Boolean(config?.forward?.translateToZh);

  const dir = path.join(DOWNLOAD_DIR, id);
  if (download) {
    const preparedPath = path.join(dir, "prepared.json");
    if (await fileExists(preparedPath)) {
      try {
        const cached = await readPreparedCache(dir);
        const cachedId = safeString(cached?.tweetId).trim();
        if (cachedId && cachedId !== id) throw new Error("prepared.json tweetId 不匹配");
        if (!translateToZh) return { ...cached, tweetId: id || cachedId, text: safeString(cached?.text).trim() };

        const cachedZh = safeString(cached?.textZh).trim();
        if (cachedZh) return { ...cached, tweetId: id || cachedId, text: cachedZh };

        const translated = await googleTranslateToZh(safeString(cached?.text).trim(), proxyUrl);
        try {
          const raw = await fs.readFile(preparedPath, "utf8");
          const meta = JSON.parse(raw);
          meta.textZh = translated;
          meta.textZhAt = nowIso();
          await fs.writeFile(preparedPath, JSON.stringify(meta, null, 2), "utf8");
          await fs.writeFile(path.join(dir, "text.zh.txt"), translated, "utf8");
        } catch {}
        return { ...cached, tweetId: id || cachedId, text: translated, textZh: translated };
      } catch (e) {
        addLog(`[缓存] 读取失败，将重新下载：tweet_id=${id} 错误=${safeString(e?.message || e)}`);
      }
    }
  }

  let sourceTweet = null;
  const hint = options.sourceTweetHint && typeof options.sourceTweetHint === "object" ? options.sourceTweetHint : null;
  if (hint && extractTweetId(hint) === id) sourceTweet = hint;

  if (!sourceTweet) {
    try {
      sourceTweet = await fetchSourceTweetForRepost(config, id);
    } catch (e) {
      if (requireSourceTweet) throw e;
      addLog(`[搬运] 获取 tweet 详情失败，将仅用缓存文本：tweet_id=${id} 错误=${safeString(e?.message || e)}`);
    }
  }

  const sourceText = sourceTweet ? extractTweetText(sourceTweet) : "";
  let text = safeString(sourceText || fallbackText).trim();

  const photos = sourceTweet ? extractPhotoMedia(sourceTweet) : [];
  if (photos.length) {
    const shortUrls = photos.map((p) => p.shortUrl).filter(Boolean);
    text = stripUrlsFromText(text, shortUrls);
  }

  const usedPhotos = photos.slice(0, 4);
  const photoUrls = usedPhotos.map((p) => p.url);

  let textZh = "";
  if (translateToZh) {
    textZh = await googleTranslateToZh(text, proxyUrl);
  }

  if (!download) {
    return {
      tweetId: id,
      text: translateToZh ? textZh : text,
      photoUrls,
      downloadDir: "",
      sourceTweet: sourceTweet ? { id: extractTweetId(sourceTweet) } : null,
    };
  }

  await fs.mkdir(dir, { recursive: true });

  if (sourceTweet) {
    await fs.writeFile(path.join(dir, "source_tweet.json"), JSON.stringify(sourceTweet, null, 2), "utf8");
  }
  await fs.writeFile(path.join(dir, "text.txt"), text, "utf8");
  if (translateToZh) {
    await fs.writeFile(path.join(dir, "text.zh.txt"), textZh, "utf8");
  }

  const downloaded = [];
  for (let i = 0; i < usedPhotos.length; i += 1) {
    const p = usedPhotos[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const existing = await findExistingMediaFile(dir, i);
      if (existing) {
        // eslint-disable-next-line no-await-in-loop
        const buffer = await fs.readFile(existing);
        const fileName = path.basename(existing);
        const mimeType = mimeTypeFromFileName(fileName) || guessImageMimeTypeFromUrl(p.url);
        downloaded.push({ url: p.url, shortUrl: p.shortUrl, mimeType, buffer, fileName, cached: true });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const { buffer, mimeType } = await downloadImageToBuffer(p.url, proxyUrl);
      const ext = extensionForMimeType(mimeType);
      const fileName = `media-${i + 1}.${ext}`;
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(path.join(dir, fileName), buffer);
      downloaded.push({ url: p.url, shortUrl: p.shortUrl, mimeType, buffer, fileName, cached: false });
    } catch (e) {
      const msg = safeString(e?.message || e);
      addLog(`[搬运] 图片下载失败：tweet_id=${id} url=${p.url} 错误=${msg}`);
      if (strictPhotos) {
        const err = new Error(`图片下载失败：${msg}`);
        err.code = Number(e?.code || e?.statusCode || e?.status) || 0;
        throw err;
      }
    }
  }

  if (strictPhotos && usedPhotos.length > 0 && downloaded.length !== usedPhotos.length) {
    throw new Error(`图片下载不完整：期望=${usedPhotos.length} 实际=${downloaded.length}`);
  }

  const preparedMeta = {
    tweetId: id,
    text,
    textZh: translateToZh ? textZh : "",
    textZhAt: translateToZh ? nowIso() : "",
    photoUrls,
    cachedAt: nowIso(),
    sourceTweetId: sourceTweet ? extractTweetId(sourceTweet) : "",
    media: downloaded.map((m) => ({
      url: safeString(m?.url).trim(),
      shortUrl: safeString(m?.shortUrl).trim(),
      mimeType: safeString(m?.mimeType).trim(),
      fileName: safeString(m?.fileName).trim(),
    })),
  };
  await fs.writeFile(path.join(dir, "prepared.json"), JSON.stringify(preparedMeta, null, 2), "utf8");

  return {
    tweetId: id,
    text: translateToZh ? textZh : text,
    textZh: translateToZh ? textZh : "",
    photoUrls,
    downloadDir: dir,
    media: downloaded,
    proxy: redactUrlCredentials(proxyUrl),
  };
}

async function uploadMediaToX(xClient, mediaItems) {
  const items = Array.isArray(mediaItems) ? mediaItems : [];
  const ids = [];
  for (const m of items) {
    if (!m?.buffer) continue;
    const mimeType = safeString(m?.mimeType).trim() || guessImageMimeTypeFromUrl(m?.url);
    stats.xCalls += 1;
    // v1 media upload 更通用（图片/视频）
    // eslint-disable-next-line no-await-in-loop
    const mediaId = await xClient.v1.uploadMedia(m.buffer, mimeType ? { mimeType } : {});
    ids.push(mediaId);
  }
  return ids;
}

let config = null;
let configFile = null;
let db = null;

let bulkConfig = null;
let bulkConfigFile = null;

let bulkRunning = false;
const bulkTimers = new Map(); // accountId -> Timeout
const bulkStates = new Map(); // accountId -> state
let bulkFollowJob = {
  running: false,
  tweetUrl: "",
  maxPerAccount: 0,
  startedAt: "",
  finishedAt: "",
  stopRequested: false,
  accountsTotal: 0,
  accountsDone: 0,
};
let bulkFollowStopRequested = false;
let bulkScanTimer = null;
let bulkImagesCache = { dir: "", images: [], scannedAt: "" };
let bulkImageWatcher = null;
let bulkImageWatchDir = "";
let bulkImageWatchDebounceTimer = null;

function ensureBulkAccountIds(cfgFile) {
  const next = cfgFile && typeof cfgFile === "object" ? cfgFile : {};
  if (!Array.isArray(next.accounts)) next.accounts = [];

  let changed = false;
  for (const a of next.accounts) {
    if (!a || typeof a !== "object") continue;
    if (!safeString(a.id).trim()) {
      // 仅在缺失时生成一次并落盘，避免每次启动都变化
      a.id = generateId("acc");
      changed = true;
    }
  }
  return { changed, config: next };
}

function getBulkAccounts() {
  return Array.isArray(bulkConfig?.accounts) ? bulkConfig.accounts : [];
}

function findBulkAccount(accountId) {
  const id = safeString(accountId).trim();
  if (!id) return null;
  return getBulkAccounts().find((a) => safeString(a?.id).trim() === id) || null;
}

function upsertBulkState(accountId) {
  const id = safeString(accountId).trim();
  if (!id) return null;
  if (!bulkStates.has(id)) {
    bulkStates.set(id, {
      running: false,
      nextPostAt: "",
      lastPostAt: "",
      posts: 0,
      lastError: "",
      lastErrorAt: "",
      lastTweetId: "",
      followDailyDate: "",
      followDailyCount: 0,
      followRunning: false,
      followLastRunAt: "",
      followLastTweetUrl: "",
      followDone: 0,
      followSkipped: 0,
      followWarnings: 0,
      followFailed: 0,
      followLastError: "",
      followLastErrorAt: "",
    });
  }
  return bulkStates.get(id);
}

function randomIntInclusive(min, max) {
  const a = Math.round(Number(min));
  const b = Math.round(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickRandomItem(items) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function sampleWithoutReplacement(items, count) {
  const arr = Array.isArray(items) ? items.slice() : [];
  const n = Math.max(0, Math.min(arr.length, Math.round(Number(count) || 0)));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

function uniqueStringList(items) {
  const arr = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    const s = safeString(it).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function pickBulkImagesForAccount(state, availableNames, count) {
  const st = state && typeof state === "object" ? state : {};
  const available = uniqueStringList(availableNames);
  const want = Math.max(0, Math.min(4, Math.round(Number(count) || 0)));
  if (want <= 0 || available.length === 0) return [];

  const availableSet = new Set(available);
  const usedArr = Array.isArray(st.usedImageNames) ? st.usedImageNames : [];
  const used = new Set();
  for (const u of usedArr) {
    const s = safeString(u).trim();
    if (!s) continue;
    if (!availableSet.has(s)) continue;
    used.add(s);
  }

  const unused = available.filter((n) => !used.has(n));
  let picked = [];

  if (unused.length >= want) {
    picked = sampleWithoutReplacement(unused, want);
  } else {
    // 先把本轮剩余未用的用完，再开启下一轮
    if (unused.length > 0) picked = sampleWithoutReplacement(unused, unused.length);
    used.clear();

    const need = want - picked.length;
    if (need > 0) {
      const pool = available.filter((n) => !picked.includes(n));
      if (pool.length > 0) picked.push(...sampleWithoutReplacement(pool, Math.min(need, pool.length)));
    }
  }

  for (const p of picked) used.add(p);
  st.usedImageNames = Array.from(used);
  st.usedImageUpdatedAt = nowIso();
  return picked;
}

function computeBulkDelayMs(schedule) {
  const s = schedule && typeof schedule === "object" ? schedule : {};
  const intervalMinRaw = Number(s.intervalMin ?? 120);
  const jitterMinFallback = s.jitterMin === undefined && s.jitterSec !== undefined ? Number(s.jitterSec) / 60 : undefined;
  const jitterMinRaw = Number(s.jitterMin ?? jitterMinFallback ?? 10);

  const baseSec = Number.isFinite(intervalMinRaw) ? Math.max(60, Math.round(intervalMinRaw * 60)) : 7200;
  const jitterMin = Number.isFinite(jitterMinRaw) ? Math.max(0, Math.round(jitterMinRaw)) : 0;

  const deltaSec = jitterMin > 0 ? randomIntInclusive(-jitterMin, jitterMin) * 60 : 0;
  const sec = Math.max(60, baseSec + deltaSec);
  return sec * 1000;
}

async function scanBulkImages(trigger) {
  const dir = resolveBulkImageDir(bulkConfig);
  if (!dir) {
    bulkImagesCache = { dir: "", images: [], scannedAt: nowIso() };
    return bulkImagesCache;
  }

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    addBulkLog(`[图库] 创建目录失败：${safeString(e?.message || e)}`);
    bulkImagesCache = { dir, images: [], scannedAt: nowIso() };
    return bulkImagesCache;
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    addBulkLog(`[图库] 读取目录失败：${safeString(e?.message || e)} dir=${dir}`);
    bulkImagesCache = { dir, images: [], scannedAt: nowIso() };
    return bulkImagesCache;
  }

  const images = [];
  for (const ent of entries) {
    if (!ent?.isFile?.()) continue;
    const name = safeString(ent.name).trim();
    if (!name || !isImageFileName(name)) continue;

    const fullPath = path.join(dir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(fullPath);
      images.push({ name, size: Number(stat.size) || 0, mtimeMs: Number(stat.mtimeMs) || 0 });
    } catch {}
  }

  images.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));

  const prevNames = new Set((bulkImagesCache?.images || []).map((i) => safeString(i?.name).trim()).filter(Boolean));
  const added = images.filter((i) => !prevNames.has(safeString(i?.name).trim())).length;

  bulkImagesCache = { dir, images, scannedAt: nowIso() };
  if (added > 0) addBulkLog(`[图库] 检测到新增图片：added=${added} trigger=${safeString(trigger || "manual")}`);
  return bulkImagesCache;
}

function stopBulkImageWatcher() {
  if (bulkImageWatcher) {
    try {
      bulkImageWatcher.close();
    } catch {}
  }
  bulkImageWatcher = null;
  bulkImageWatchDir = "";
  if (bulkImageWatchDebounceTimer) clearTimeout(bulkImageWatchDebounceTimer);
  bulkImageWatchDebounceTimer = null;
}

function startBulkImageWatcher() {
  const dir = resolveBulkImageDir(bulkConfig);
  if (!dir) return;

  const resolved = path.resolve(dir);
  if (bulkImageWatcher && bulkImageWatchDir === resolved) return;

  stopBulkImageWatcher();

  try {
    fssync.mkdirSync(resolved, { recursive: true });
  } catch {}

  try {
    bulkImageWatcher = fssync.watch(resolved, { persistent: false }, (_eventType, filename) => {
      const name = safeString(filename).trim();
      if (name && !isImageFileName(name)) return;

      if (bulkImageWatchDebounceTimer) clearTimeout(bulkImageWatchDebounceTimer);
      bulkImageWatchDebounceTimer = setTimeout(() => {
        scanBulkImages("watch").catch(() => {});
      }, 1200);
    });
    bulkImageWatchDir = resolved;
    addBulkLog(`[图库] 已开启文件夹监控 dir=${resolved}`);
  } catch (e) {
    addBulkLog(`[图库] 文件夹监控启动失败：${safeString(e?.message || e)} dir=${resolved}`);
    stopBulkImageWatcher();
  }
}

function startBulkScanTimer() {
  if (bulkScanTimer) return;
  const intervalSec = Number(bulkConfig?.scanIntervalSec ?? 3600);
  const sec = Number.isFinite(intervalSec) ? Math.max(300, Math.round(intervalSec)) : 3600;
  bulkScanTimer = setInterval(() => {
    scanBulkImages("timer").catch(() => {});
  }, sec * 1000);
}

function stopBulkScanTimer() {
  if (bulkScanTimer) clearInterval(bulkScanTimer);
  bulkScanTimer = null;
}

function getBulkXCredentials(account) {
  const x = account?.x && typeof account.x === "object" ? account.x : {};
  return {
    appKey: safeString(x.apiKey).trim(),
    appSecret: safeString(x.apiSecret).trim(),
    accessToken: safeString(x.accessToken).trim(),
    accessSecret: safeString(x.accessSecret).trim(),
  };
}

function getBulkProxyUrl(account) {
  const accProxy = safeString(account?.proxy).trim();
  if (accProxy) return accProxy;
  return getXProxyUrlFromEnv();
}

function createXClientForBulkAccount(account) {
  const creds = getBulkXCredentials(account);
  const err = validateXCredentials(creds);
  if (err) throw new Error(err);

  const proxyUrl = getBulkProxyUrl(account);
  const settings = {};
  if (proxyUrl) {
    try {
      settings.httpAgent = new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      throw new Error(`HTTPS_PROXY 无效：${safeString(e?.message || e)}`);
    }
  }

  return {
    client: new TwitterApi(
      {
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken: creds.accessToken,
        accessSecret: creds.accessSecret,
      },
      settings,
    ),
    proxyUrl,
  };
}

function pickBulkCaption() {
  const captions = Array.isArray(bulkConfig?.captions) ? bulkConfig.captions : [];
  return safeString(pickRandomItem(captions) || "").trim();
}

async function bulkPostOnce(account, options = {}) {
  const a = account && typeof account === "object" ? account : null;
  if (!a) throw new Error("账号不存在");

  const state = upsertBulkState(a.id);
  if (!state) throw new Error("账号状态异常");

  const trigger = safeString(options.trigger || "timer").trim() || "timer";

  const caption = pickBulkCaption();
  const imageDir = resolveBulkImageDir(bulkConfig);
  const imagesMin = Number(a?.schedule?.imagesMin ?? 1);
  const imagesMax = Number(a?.schedule?.imagesMax ?? 4);
  const wantCount = randomIntInclusive(imagesMin, imagesMax);

  const { images } = await scanBulkImages(trigger);
  const availableNames = images.map((i) => safeString(i?.name).trim()).filter(Boolean);
  const maxPhotos = Math.min(4, availableNames.length);
  const count = Math.max(0, Math.min(maxPhotos, wantCount));
  const pickState = a.dryRun ? { usedImageNames: Array.isArray(state.usedImageNames) ? state.usedImageNames.slice() : [] } : state;
  const pickedNames = pickBulkImagesForAccount(pickState, availableNames, count);

  if (!caption && pickedNames.length === 0) {
    addBulkLog(`[发帖] 跳过：无文案且无图片 account=${safeString(a.name || a.id)}`);
    return { skipped: true, reason: "empty" };
  }
  if (pickedNames.length > 0 && !imageDir) {
    throw new Error("未配置图片目录（imageDir）");
  }

  if (a.dryRun) {
    const preview = caption.length > 60 ? `${caption.slice(0, 60)}…` : caption;
    addBulkLog(
      `[DRY-RUN] 将发帖 account=${safeString(a.name || a.id)} images=${pickedNames.length} caption="${preview}"`,
      pickedNames.length ? `files=${pickedNames.join(",")}` : "",
    );
    return { dryRun: true, caption, images: pickedNames };
  }

  // 1. 尝试初始化 API 客户端
  let xClient = null;
  let proxyUrl = getBulkProxyUrl(a);
  let useCookieMode = false;

  try {
    const created = createXClientForBulkAccount(a);
    xClient = created.client;
    proxyUrl = created.proxyUrl;
    // 如果有 API Key 配置，优先用 API，否则下面会 fallback
  } catch (e) {
    // 仅当配置了浏览器登录(Profile)/Cookie 且 API 初始化失败（通常是没填 Key）时，才尝试浏览器模式
    const hasBrowserSession = Boolean(safeString(a.x?.profileDir).trim() || safeString(a.x?.cookieString).trim());
    if (hasBrowserSession) {
      useCookieMode = true;
    } else {
      throw new Error(safeString(e?.message || e));
    }
  }

  // 2. 准备媒体文件 (路径或buffer)
  const mediaItems = [];
  const mediaFilePaths = []; // For Puppeteer
  
  for (const name of pickedNames) {
    const filePath = path.join(imageDir, name);
    mediaFilePaths.push(filePath);
    
    // API模式才需要 Buffer
    if (!useCookieMode) {
        // eslint-disable-next-line no-await-in-loop
        const buffer = await fs.readFile(filePath);
        const mimeType = mimeTypeFromFileName(name) || "application/octet-stream";
        mediaItems.push({ buffer, mimeType, fileName: name });
    }
  }

  // 3. 上传媒体
  let mediaIds = [];
  if (!useCookieMode && mediaItems.length > 0) {
    try {
       mediaIds = await uploadMediaToX(xClient, mediaItems);
    } catch (e) {
      throw new Error(`上传媒体失败[API]: ${formatXErrorVerbose(e, { proxy: proxyUrl })}`);
    }
  }

  // 4. 发帖
  let tweetId = "";
  if (useCookieMode) {
     try {
       stats.xCalls += 1;
       // Switch to Puppeteer for Cookie mode to avoid fingerprinting issues (Error 226)
       tweetId = await bulkPostViaPuppeteer(a, truncateTweetText(caption || "", 280), mediaFilePaths);
     } catch(e) {
       throw new Error(`发帖失败[Puppeteer]: ${safeString(e.message || e)}`);
     }
  } else {
    const payload = { text: truncateTweetText(caption || "", 280) };
    if (mediaIds.length) payload.media = { media_ids: mediaIds };
    if (!payload.text && mediaIds.length === 0) throw new Error("无可发布内容（text/media 均为空）");

    let res;
    try {
      stats.xCalls += 1;
      res = await xClient.v2.post("tweets", payload, { timeout: X_REQUEST_TIMEOUT_MS });
    } catch (e) {
      throw new Error(`发帖失败[API]: ${formatXErrorVerbose(e, { proxy: proxyUrl })}`);
    }
    tweetId = safeString(res?.data?.id).trim();
  }
  
  if (!tweetId) throw new Error("发帖失败：未返回 tweet id");

  const mode = useCookieMode ? (safeString(a.x?.profileDir).trim() ? "Browser" : "Cookie") : "API";
  addBulkLog(
    `[发帖成功] account=${safeString(a.name || a.id)} tweet_id=${tweetId} images=${mediaIds.length} mode=${mode} proxy=${redactUrlCredentials(proxyUrl)}`,
  );
  state.lastTweetId = tweetId;
  return { ok: true, tweetId, mediaIds, caption, images: pickedNames };
}

async function bulkTick(accountId, trigger) {
  if (!bulkRunning) return;
  const a = findBulkAccount(accountId);
  if (!a || !a.enabled) return;

  const state = upsertBulkState(a.id);
  if (!state) return;
  if (state.running) {
    addBulkLog(`[发帖] 上一次未结束，跳过：account=${safeString(a.name || a.id)}`);
    return;
  }

  state.running = true;
  state.lastError = "";
  state.lastErrorAt = "";
  try {
    const result = await bulkPostOnce(a, { trigger });
    if (!result?.skipped) state.posts = Number(state.posts || 0) + 1;
    state.lastPostAt = nowIso();
  } catch (e) {
    state.lastError = safeString(e?.message || e);
    state.lastErrorAt = nowIso();
    addBulkLog(`[发帖失败] account=${safeString(a.name || a.id)} error=${state.lastError}`);
  } finally {
    state.running = false;
  }

  const delayMs = computeBulkDelayMs(a.schedule);
  const nextAt = new Date(Date.now() + delayMs).toISOString();
  state.nextPostAt = nextAt;
  scheduleBulkNext(a.id, delayMs);
}

function scheduleBulkNext(accountId, delayMs) {
  const id = safeString(accountId).trim();
  if (!id) return;
  if (!bulkRunning) return;

  const prev = bulkTimers.get(id);
  if (prev) clearTimeout(prev);

  const t = setTimeout(() => {
    bulkTick(id, "timer").catch(() => {});
  }, Math.max(1000, Math.round(Number(delayMs) || 0)));

  bulkTimers.set(id, t);
}

function startBulkScheduler() {
  if (bulkRunning) return;
  bulkRunning = true;
  startBulkImageWatcher();
  startBulkScanTimer();
  scanBulkImages("start").catch(() => {});

  for (const a of getBulkAccounts()) {
    if (!a?.enabled) continue;
    const state = upsertBulkState(a.id);
    if (!state) continue;

    const delayMs = computeBulkDelayMs(a.schedule);
    state.nextPostAt = new Date(Date.now() + delayMs).toISOString();
    scheduleBulkNext(a.id, delayMs);
  }

  addBulkLog(`[系统] 批量发帖已启动 accounts=${getBulkAccounts().filter((a) => a.enabled).length}`);
}

function stopBulkScheduler() {
  if (!bulkRunning) return;
  bulkRunning = false;
  stopBulkScanTimer();

  for (const t of bulkTimers.values()) clearTimeout(t);
  bulkTimers.clear();

  for (const state of bulkStates.values()) {
    state.running = false;
    state.nextPostAt = "";
  }

  addBulkLog("[系统] 批量发帖已停止");
}

let monitorTimer = null;
let monitorRunning = false;
let monitorTickInProgress = false;

let queueTimer = null;
let queueInProgress = false;

let xRateLimitUntilMs = 0;
let xRateLimitLastLogMs = 0;

function getTargetsFromConfig() {
  const targets = Array.isArray(config?.monitor?.targets) ? config.monitor.targets : [];
  return targets.map(normalizeScreenName).filter(Boolean);
}

function ensureTargetDb(target) {
  if (!db.targets) db.targets = {};
  if (!db.targets[target]) {
    db.targets[target] = { lastSeenId: "0", forwardedIds: [], failedIds: [] };
  }
  if (!Array.isArray(db.targets[target].forwardedIds)) db.targets[target].forwardedIds = [];
  if (!Array.isArray(db.targets[target].failedIds)) db.targets[target].failedIds = [];
  if (!db.targets[target].lastSeenId) db.targets[target].lastSeenId = "0";
}

function queueContains(target, tweetId) {
  return (db.queue || []).some((q) => q.target === target && q.tweetId === tweetId);
}

function pushForwarded(target, tweetId) {
  ensureTargetDb(target);
  const arr = db.targets[target].forwardedIds;
  if (arr.includes(tweetId)) return;
  arr.unshift(tweetId);
  db.targets[target].forwardedIds = arr.slice(0, 200);
}

function pushFailed(target, tweetId) {
  ensureTargetDb(target);
  const arr = db.targets[target].failedIds;
  if (arr.includes(tweetId)) return;
  arr.unshift(tweetId);
  db.targets[target].failedIds = arr.slice(0, 200);
}

function computeBackoffSeconds(attempts) {
  const base = 5;
  const delay = Math.round(Math.pow(2, attempts) * base);
  return Math.min(300, Math.max(5, delay));
}

async function processQueue() {
  if (queueInProgress) return;
  queueInProgress = true;
  try {
    if (!Array.isArray(db.queue)) db.queue = [];
    if (db.queue.length === 0) return;

  const activeTargets = new Set(getTargetsFromConfig());
  if (activeTargets.size) {
    const before = db.queue.length;
    db.queue = db.queue.filter((q) => activeTargets.has(safeString(q?.target).trim()));
    const removed = before - db.queue.length;
    if (removed > 0) addLog(`[队列] 已清理 ${removed} 条非监控目标的历史任务`);
    if (db.queue.length === 0) {
      await writeJson(DB_PATH, db);
      return;
    }
  }

  const now = Date.now();
  db.queue.sort((a, b) => {
    const aa = Date.parse(a?.nextAttemptAt || "") || 0;
    const bb = Date.parse(b?.nextAttemptAt || "") || 0;
    return aa - bb;
  });

  const forward = config?.forward || {};
  const enabled = Boolean(forward.enabled);
  const dryRun = Boolean(forward.dryRun);
  const mode = safeString(forward.mode || "retweet").trim().toLowerCase();
  const sendIntervalSecRaw = Number(forward.sendIntervalSec ?? 5);
  const sendIntervalMs = Number.isFinite(sendIntervalSecRaw) ? Math.max(0, Math.round(sendIntervalSecRaw * 1000)) : 5000;

  const forwardProfileDir = safeString(config?.forward?.x?.profileDir).trim();
  const hasForwardBrowserProfile = Boolean(forwardProfileDir);
  const forwardBrowserAccount = hasForwardBrowserProfile
    ? { id: "forward", name: "forward", proxy: getXProxyUrl(config), x: { profileDir: forwardProfileDir } }
    : null;

  let xClient = null;
  let xLoggedUserId = "";
  let xInitError = "";
  let xProxyForLog = "";
  let useBrowserMode = false;

  if (enabled && !dryRun) {
    try {
      const created = createXClient(config);
      xClient = created.client;
      xProxyForLog = redactUrlCredentials(created.proxyUrl);
    } catch (e) {
      if (hasForwardBrowserProfile) {
        useBrowserMode = true;
      } else {
        xInitError = safeString(e?.message || e);
      }
    }
  }

  if (enabled && !dryRun && !useBrowserMode && xClient && xRateLimitUntilMs > now) {
    const remaining = Math.max(1, Math.ceil((xRateLimitUntilMs - now) / 1000));
    if (now - xRateLimitLastLogMs > 15_000) {
      addLog(`[队列] X 命中限流，暂停处理 ${remaining}s`);
      xRateLimitLastLogMs = now;
    }
    return;
  }

  let loggedInitError = false;

  for (let i = 0; i < db.queue.length; i += 1) {
    const item = db.queue[i];
    const dueAt = Date.parse(item?.nextAttemptAt || "") || 0;
    if (dueAt > now && !(enabled && Number(item?.attempts || 0) === 0)) break;

    const tweetId = safeString(item?.tweetId).trim();
    const target = safeString(item?.target).trim();
    if (!tweetId || !target) continue;

    const skipMentions = Boolean(config?.monitor?.skipMentions);
    const itemText = safeString(pickFirstString(item?.text, extractTweetText(item?.sourceTweet))).trim();
    if (skipMentions && itemText.includes("@")) {
      addLog(`[过滤] 已丢弃（含@）：@${target} tweet_id=${tweetId}`);
      db.queue.splice(i, 1);
      i -= 1;
      continue;
    }

    const allowQuote = config?.monitor?.includeQuoteTweets !== false;
    if (!allowQuote && safeString(item?.kind).trim().toLowerCase() === "quote") {
      addLog(`[过滤] 已丢弃（quote）：@${target} tweet_id=${tweetId}`);
      db.queue.splice(i, 1);
      i -= 1;
      continue;
    }

    if (!enabled) {
      addLog(`[队列] 转发未开启，保留待处理：@${target} tweet_id=${tweetId}`);
      item.nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
      continue;
    }

    if (dryRun) {
      addLog(`[DRY-RUN] 将转发（${mode}）：@${target} tweet_id=${tweetId}`);
      pushForwarded(target, tweetId);
      db.queue.splice(i, 1);
      i -= 1;
      continue;
    }

    if (!useBrowserMode && (xInitError || !xClient)) {
      if (!loggedInitError) {
        const proxyHint = xProxyForLog ? ` proxy=${xProxyForLog}` : "";
        addLog(`[队列] X API 未就绪，无法转发：${xInitError || "未知原因"}${proxyHint}`);
        loggedInitError = true;
      }
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = xInitError || "X API 未就绪";
      item.lastAttemptAt = nowIso();
      item.nextAttemptAt = new Date(Date.now() + computeBackoffSeconds(item.attempts) * 1000).toISOString();
      continue;
    }

      item.lastAttemptAt = nowIso();
    try {
      if (mode === "create_tweet") {
        const shouldWait = sendIntervalMs > 0 && db.queue.length > 1;
        const prepared = await prepareRepostFromTweet(config, tweetId, item?.text, {
          download: true,
          sourceTweetHint: item?.sourceTweet,
          requireSourceTweet: true,
          strictPhotos: true,
        });
        if (useBrowserMode) {
          const filePaths = (prepared.media || [])
            .map((m) => path.join(prepared.downloadDir || "", safeString(m?.fileName).trim()))
            .filter((p) => safeString(p).trim());

          let newTweetId = "";
          try {
            stats.xCalls += 1;
            newTweetId = await bulkPostViaPuppeteer(
              forwardBrowserAccount,
              truncateTweetText(prepared.text || "", 280),
              filePaths,
            );
          } catch (e) {
            throw new Error(`发帖失败[Puppeteer]: ${safeString(e?.message || e)}`);
          }

          const savedHint = prepared.downloadDir ? ` saved=${prepared.downloadDir}` : "";
          const newIdHint = newTweetId ? ` -> new_tweet_id=${newTweetId}` : "";
          addLog(`[转发成功] create_tweet(browser) tweet_id=${tweetId}${newIdHint}${savedHint}`);
          pushForwarded(target, tweetId);
          db.queue.splice(i, 1);
          i -= 1;
          if (shouldWait) await sleep(sendIntervalMs);
          continue;
        }

        const mediaIds = await uploadMediaToX(xClient, prepared.media);

        const payload = {
          text: truncateTweetText(prepared.text || "", 280),
        };
        if (mediaIds.length) payload.media = { media_ids: mediaIds };

        if (!payload.text && mediaIds.length === 0) throw new Error("无可发布内容（text/media 均为空）");

        stats.xCalls += 1;
        const res = await xClient.v2.post("tweets", payload, { timeout: X_REQUEST_TIMEOUT_MS });
        if (res?.data?.id) {
          const mediaHint = mediaIds.length ? ` media=${mediaIds.length}` : "";
          const savedHint = prepared.downloadDir ? ` saved=${prepared.downloadDir}` : "";
          addLog(`[转发成功] create_tweet tweet_id=${tweetId} -> new_tweet_id=${res.data.id}${mediaHint}${savedHint}`);
          pushForwarded(target, tweetId);
          db.queue.splice(i, 1);
          i -= 1;
          if (shouldWait) await sleep(sendIntervalMs);
          continue;
        }
        throw new Error("create_tweet 失败：未返回 tweet id");
      }

      if (useBrowserMode) {
        const shouldWait = sendIntervalMs > 0 && db.queue.length > 1;
        const r = await xRetweetViaPuppeteer(forwardBrowserAccount, tweetId);
        const statusHint = safeString(r?.status).trim() ? ` status=${safeString(r.status).trim()}` : "";
        addLog(`[转发成功] retweet(browser) tweet_id=${tweetId}${statusHint}`);
        pushForwarded(target, tweetId);
        db.queue.splice(i, 1);
        i -= 1;
        if (shouldWait) await sleep(sendIntervalMs);
        continue;
      }

      if (!xLoggedUserId) {
        stats.xCalls += 1;
        xLoggedUserId = await getXLoggedUserId(xClient);
      }
      if (!xLoggedUserId) throw new Error("无法获取当前账号的 user id，无法 retweet");

      stats.xCalls += 1;
      const res = await xClient.v2.retweet(xLoggedUserId, tweetId);
      if (res?.data?.retweeted === true) {
        const shouldWait = sendIntervalMs > 0 && db.queue.length > 1;
        addLog(`[转发成功] retweet tweet_id=${tweetId}`);
        pushForwarded(target, tweetId);
        db.queue.splice(i, 1);
        i -= 1;
        if (shouldWait) await sleep(sendIntervalMs);
        continue;
      }
      throw new Error("retweet 失败：未返回 retweeted=true");
    } catch (e) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = formatXError(e);
      const schedule = computeRetryScheduleFromError(e, item.attempts);
      item.nextAttemptAt = schedule.nextAttemptAt;
      addLog(`[转发失败] tweet_id=${tweetId} attempts=${item.attempts} 下次重试=${schedule.delaySeconds}s 错误=${item.lastError}`);

      const upstream = safeString(e?.upstream).trim().toLowerCase();
      const code = Number(e?.code || e?.statusCode || e?.status) || 0;
      const isXRateLimit = !upstream && (code === 420 || code === 429 || e?.rateLimitError === true);
      if (isXRateLimit) {
        const until = Date.parse(schedule.nextAttemptAt || "") || now + Math.max(1, schedule.delaySeconds) * 1000;
        xRateLimitUntilMs = Math.max(xRateLimitUntilMs, until);
        xRateLimitLastLogMs = now;
        addLog(`[队列] 命中 X 限流，暂停处理到 ${new Date(xRateLimitUntilMs).toLocaleString()}`);
        break;
      }

      if (item.attempts >= QUEUE_MAX_ATTEMPTS) {
        addLog(`[放弃转发] 超过最大重试次数：tweet_id=${tweetId}`);
        pushFailed(target, tweetId);
        db.queue.splice(i, 1);
        i -= 1;
      }
    }
  }

  await writeJson(DB_PATH, db);
  } finally {
    queueInProgress = false;
  }
}

async function monitorTick(trigger) {
  if (monitorTickInProgress) {
    addLog(`[监控] 上一次轮询未结束，跳过本次（trigger=${trigger || "timer"}）`);
    return;
  }
  monitorTickInProgress = true;
  try {
    const targets = getTargetsFromConfig();
    if (!config?.twitterApi?.apiKey) {
      addLog("[监控] 缺少 API Key，无法轮询");
      return;
    }
    if (targets.length === 0) {
      addLog("[监控] 未配置目标账号");
      return;
    }

    if (!Array.isArray(db.queue)) db.queue = [];

	    for (const target of targets) {
	      ensureTargetDb(target);
	      const lastSeen = db.targets[target].lastSeenId || "0";
	
	      const fetchLimitRaw = Number(config?.monitor?.fetchLimit ?? 20);
	      const fetchLimit = Number.isFinite(fetchLimitRaw) ? Math.min(200, Math.max(1, Math.round(fetchLimitRaw))) : 20;
	      const maxPages = Math.min(20, Math.max(1, Math.ceil(fetchLimit / 20)));
	
	      addLog(`[轮询] 正在抓取 @${target} 的最新推文...`);
	
	      const tweets = [];
	      const seenIds = new Set();
	      let pinnedTweetId = "";
	      let newestId = "0";
	      let cursor = "";
	      let stopBecauseSeen = false;
	
	      for (let page = 0; page < maxPages && tweets.length < fetchLimit && !stopBecauseSeen; page += 1) {
	        let res;
	        try {
	          // eslint-disable-next-line no-await-in-loop
	          res = await twitterGetLastTweets(config, target, cursor);
	        } catch (e) {
	          addLog(`[轮询] 请求失败：@${target} 错误=${formatAxiosError(e)}`);
	          break;
	        }
	
	        if (res.status === 401) {
	          addLog("[轮询] API Key 无效或未授权（401）");
	          break;
	        }
	        if (res.status === 429) {
	          addLog("[轮询] 命中限流（429），稍后再试");
	          break;
	        }
	        if (res.status < 200 || res.status >= 300) {
	          addLog(`[轮询] HTTP ${res.status}：@${target} ${safeString(res.data?.msg || res.data?.message)}`);
	          break;
	        }
	        if (res.data?.status && res.data.status !== "success") {
	          addLog(`[轮询] API 返回 error：@${target} ${safeString(res.data?.msg || res.data?.message)}`);
	          break;
	        }
	
	        if (!pinnedTweetId) pinnedTweetId = extractPinnedTweetIdFromApiResponse(res.data);
	
	        const pageTweets = extractTweetArrayFromApiResponse(res.data);
	        for (const t of pageTweets) {
	          const id = extractTweetId(t);
	          if (!id) continue;
	          if (seenIds.has(id)) continue;
	          seenIds.add(id);
	          tweets.push(t);
	          if (compareNumericStrings(id, newestId) > 0) newestId = id;
	          if (lastSeen && compareNumericStrings(id, lastSeen) <= 0) {
	            stopBecauseSeen = true;
	            break;
	          }
	          if (tweets.length >= fetchLimit) break;
	        }
	
	        const hasNext = res.data?.has_next_page === true;
	        const nextCursor = safeString(res.data?.next_cursor).trim();
	        if (!hasNext || !nextCursor) break;
	        cursor = nextCursor;
	      }

      const newTweets = tweets
        .map((t) => ({ tweet: t, id: extractTweetId(t) }))
        .filter((x) => x.id && compareNumericStrings(x.id, lastSeen) > 0)
        .sort((a, b) => compareNumericStrings(a.id, b.id));

      if (newTweets.length === 0) {
        addLog(`[轮询] 未发现新推文：@${target} last_seen=${lastSeen}`);
        if (newestId && compareNumericStrings(newestId, lastSeen) > 0) {
          db.targets[target].lastSeenId = newestId;
          await writeJson(DB_PATH, db);
        }
        continue;
      }

      addLog(`[轮询] 发现 ${newTweets.length} 条新推文：@${target}`);

      for (const { tweet, id } of newTweets) {
        const { kind } = classifyTweet(tweet);
        const text = extractTweetText(tweet);

        const isPinned =
          tweet?.is_pinned === true ||
          tweet?.isPinned === true ||
          (pinnedTweetId && safeString(pinnedTweetId).trim() === id);
        if (isPinned) {
          addLog(`[过滤] 跳过置顶：tweet_id=${id}`);
          continue;
        }

        const skipMentions = Boolean(config?.monitor?.skipMentions);
        if (skipMentions && safeString(text).includes("@")) {
          addLog(`[过滤] 跳过（含@）：tweet_id=${id}`);
          continue;
        }

        const allowQuote = config?.monitor?.includeQuoteTweets !== false;
        const forwardable = kind === "original" || (allowQuote && kind === "quote");

        if (!forwardable) {
          addLog(`[过滤] 跳过（${kind}）：tweet_id=${id}`);
          continue;
        }

        if (queueContains(target, id)) {
          addLog(`[队列] 已存在，跳过：tweet_id=${id}`);
          continue;
        }
        if (db.targets[target].forwardedIds?.includes(id)) {
          addLog(`[队列] 已转发过，跳过：tweet_id=${id}`);
          continue;
        }
        if (db.targets[target].failedIds?.includes(id)) {
          addLog(`[队列] 已标记失败，跳过：tweet_id=${id}`);
          continue;
        }

        db.queue.push({
          target,
          tweetId: id,
          kind,
          text,
          sourceTweet: compactTweetForQueue(tweet),
          discoveredAt: nowIso(),
          attempts: 0,
          nextAttemptAt: nowIso(),
        });
        addLog(`[队列] 入队：@${target} tweet_id=${id}`);
      }

      db.targets[target].lastSeenId = maxId([lastSeen, newestId]);
      await writeJson(DB_PATH, db);
    }

	  } finally {
	    monitorTickInProgress = false;
	  }
	}

	function startQueueWorker() {
	  if (queueTimer) return;
	  queueTimer = setInterval(() => {
	    processQueue().catch((e) => addLog(`[队列] 处理异常：${safeString(e?.message || e)}`));
	  }, 2000);
	}

	function stopQueueWorker() {
	  if (queueTimer) clearInterval(queueTimer);
	  queueTimer = null;
	}

	function startMonitor() {
	  if (monitorTimer) return;
	  const pollIntervalSec = Math.max(10, Number(config?.monitor?.pollIntervalSec || 60));
	  monitorTimer = setInterval(() => {
	    monitorTick("timer").catch((e) => addLog(`[监控] Tick 异常：${safeString(e?.message || e)}`));
	  }, pollIntervalSec * 1000);
	  monitorRunning = true;
	  startQueueWorker();
	  processQueue().catch((e) => addLog(`[队列] 处理异常：${safeString(e?.message || e)}`));
	  addLog(`[监控] 已启动，间隔 ${pollIntervalSec}s`);
	}

	function stopMonitor() {
	  if (monitorTimer) clearInterval(monitorTimer);
	  monitorTimer = null;
	  monitorRunning = false;
	  stopQueueWorker();
	  addLog("[监控] 已停止");
	}

async function main() {
  await ensureDataFiles();
  configFile = await readJson(CONFIG_PATH, {});
  config = applyEnvOverrides(configFile);
  db = await readJson(DB_PATH, { version: 1, targets: {}, queue: [] });

  bulkConfigFile = await readJson(BULK_CONFIG_PATH, defaultBulkConfig());
  const ensured = ensureBulkAccountIds(bulkConfigFile);
  if (ensured.changed) {
    bulkConfigFile = ensured.config;
    await writeJson(BULK_CONFIG_PATH, bulkConfigFile);
  }
  bulkConfig = normalizeBulkConfig(bulkConfigFile);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  // API 默认不缓存，避免浏览器/代理缓存导致“刷新后配置看起来丢了”
  app.use((req, res, next) => {
    if (typeof req.path === "string" && req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
    }
    next();
  });
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/config", async (_req, res) => {
    res.json({ config: configFile });
  });

  app.post("/api/config", async (req, res) => {
    try {
      const incoming = req.body || {};
      const next = JSON.parse(JSON.stringify(configFile || {}));
      next.twitterApi = next.twitterApi || {};
      next.monitor = next.monitor || {};
      next.forward = next.forward || {};

      if (incoming?.twitterApi?.apiKey !== undefined) next.twitterApi.apiKey = safeString(incoming.twitterApi.apiKey).trim();
      if (incoming?.twitterApi?.baseUrl) next.twitterApi.baseUrl = safeString(incoming.twitterApi.baseUrl).trim();

	    if (Array.isArray(incoming?.monitor?.targets)) next.monitor.targets = incoming.monitor.targets.map(normalizeScreenName).filter(Boolean);
	    if (incoming?.monitor?.pollIntervalSec !== undefined) next.monitor.pollIntervalSec = Math.max(10, Number(incoming.monitor.pollIntervalSec || 60));
	    if (incoming?.monitor?.fetchLimit !== undefined) next.monitor.fetchLimit = Math.min(200, Math.max(1, Number(incoming.monitor.fetchLimit || 20)));
	    if (incoming?.monitor?.skipMentions !== undefined) next.monitor.skipMentions = Boolean(incoming.monitor.skipMentions);
	    if (incoming?.monitor?.includeQuoteTweets !== undefined) next.monitor.includeQuoteTweets = Boolean(incoming.monitor.includeQuoteTweets);

	    if (incoming?.forward?.enabled !== undefined) next.forward.enabled = Boolean(incoming.forward.enabled);
	    if (incoming?.forward?.dryRun !== undefined) next.forward.dryRun = Boolean(incoming.forward.dryRun);
	    if (incoming?.forward?.mode) next.forward.mode = safeString(incoming.forward.mode).trim();
	    if (incoming?.forward?.sendIntervalSec !== undefined) next.forward.sendIntervalSec = Math.max(0, Number(incoming.forward.sendIntervalSec || 0));
	    if (incoming?.forward?.translateToZh !== undefined) next.forward.translateToZh = Boolean(incoming.forward.translateToZh);
	    if (incoming?.forward?.proxy !== undefined) next.forward.proxy = safeString(incoming.forward.proxy).trim();

      if (incoming?.forward?.x && typeof incoming.forward.x === "object") {
        next.forward.x = next.forward.x || {};
        if (incoming.forward.x.apiKey !== undefined) next.forward.x.apiKey = safeString(incoming.forward.x.apiKey).trim();
        if (incoming.forward.x.apiSecret !== undefined) next.forward.x.apiSecret = safeString(incoming.forward.x.apiSecret).trim();
        if (incoming.forward.x.accessToken !== undefined) next.forward.x.accessToken = safeString(incoming.forward.x.accessToken).trim();
        if (incoming.forward.x.accessSecret !== undefined) next.forward.x.accessSecret = safeString(incoming.forward.x.accessSecret).trim();
        if (incoming.forward.x.profileDir !== undefined) next.forward.x.profileDir = safeString(incoming.forward.x.profileDir).trim();
      }

      configFile = next;
      await writeJson(CONFIG_PATH, configFile);
      config = applyEnvOverrides(configFile);
      addLog("[配置] 已保存");

      if (monitorRunning) {
        stopMonitor();
        startMonitor();
        addLog("[配置] 已重启监控以应用新配置");
      }

      return res.json({ ok: true, config: redactSecrets(config) });
    } catch (e) {
      const err = safeString(e?.message || e);
      addLog(`[配置] 保存失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  async function handleTestFetch(req, res) {
    try {
      const targets = getTargetsFromConfig();
      const userName = normalizeScreenName(req.query.username || targets[0] || "");
      if (!userName) return res.status(400).json({ error: "缺少 username 或未配置目标账号" });
      if (!config?.twitterApi?.apiKey) return res.status(400).json({ error: "请先配置 API Key" });

      addLog(`[测试] 手动抓取：@${userName}`);
      let apiRes;
      try {
        apiRes = await twitterGetLastTweets(config, userName);
      } catch (e) {
        return res.status(502).json({ error: formatAxiosError(e) });
      }

      const tweets = extractTweetArrayFromApiResponse(apiRes.data);
      const classifiedTweets = tweets.slice(0, 5).map((t) => {
        const id = extractTweetId(t);
        const kind = classifyTweet(t).kind;
        const text = extractTweetText(t);
        return { id, kind, text };
      });

      return res.json({
        ok: true,
        httpStatus: apiRes.status,
        api: apiRes.data,
        classifiedTweets,
      });
    } catch (e) {
      const err = safeString(e?.message || e);
      addLog(`[测试] 手动抓取失败：${err}`);
      return res.status(500).json({ error: err });
    }
  }

  async function handleTestPost(req, res) {
    const text = safeString(req.body?.text).trim();
    if (!text) return res.status(400).json({ error: "缺少 text" });

    addLog("[测试] X create_tweet 发推测试");
    const forwardProfileDir = safeString(config?.forward?.x?.profileDir).trim();
    const hasForwardProfile = Boolean(forwardProfileDir);

    let xClient = null;
    let proxyUrl = "";
    let useBrowserMode = false;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      if (hasForwardProfile) {
        useBrowserMode = true;
        proxyUrl = getXProxyUrl(config);
      } else {
        return res.status(400).json({ error: safeString(e?.message || e) });
      }
    }

    if (useBrowserMode) {
      const browserAccount = { id: "forward", name: "forward", proxy: getXProxyUrl(config), x: { profileDir: forwardProfileDir } };
      let tweetId = "";
      try {
        stats.xCalls += 1;
        tweetId = await bulkPostViaPuppeteer(browserAccount, truncateTweetText(text, 280), []);
      } catch (e) {
        return res.status(502).json({ error: `发帖失败[Puppeteer]: ${safeString(e?.message || e)}` });
      }
      return res.json({ ok: true, mode: "browser", profileDir: forwardProfileDir, proxy: redactUrlCredentials(proxyUrl), tweetId });
    }

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.post("tweets", { text: truncateTweetText(text, 280) }, { timeout: X_REQUEST_TIMEOUT_MS });
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }

    return res.json({ ok: true, mode: "api", proxy: redactUrlCredentials(proxyUrl), api: apiRes });
  }

  app.get("/api/test-fetch", handleTestFetch);

  // 兼容 architecture.md 中的代理接口命名
  app.get("/api/tweets", (req, res) => {
    if (req.query.user && !req.query.username) req.query.username = req.query.user;
    return handleTestFetch(req, res);
  });

  app.post("/api/test-post", handleTestPost);

  // 兼容 architecture.md 中的代理接口命名
  app.post("/api/tweet", handleTestPost);

  app.post("/api/test-retweet", async (req, res) => {
    const tweetId = safeString(req.body?.tweetId).trim();
    if (!tweetId) return res.status(400).json({ error: "缺少 tweetId" });

    addLog(`[测试] X retweet 测试 tweet_id=${tweetId}`);
    const forwardProfileDir = safeString(config?.forward?.x?.profileDir).trim();
    const hasForwardProfile = Boolean(forwardProfileDir);

    let xClient = null;
    let proxyUrl = "";
    let useBrowserMode = false;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      if (hasForwardProfile) {
        useBrowserMode = true;
        proxyUrl = getXProxyUrl(config);
      } else {
        return res.status(400).json({ error: safeString(e?.message || e) });
      }
    }

    if (useBrowserMode) {
      const browserAccount = { id: "forward", name: "forward", proxy: getXProxyUrl(config), x: { profileDir: forwardProfileDir } };
      try {
        stats.xCalls += 1;
        const r = await xRetweetViaPuppeteer(browserAccount, tweetId);
        return res.json({
          ok: true,
          mode: "browser",
          profileDir: forwardProfileDir,
          proxy: redactUrlCredentials(proxyUrl),
          result: r,
        });
      } catch (e) {
        return res.status(502).json({ error: `转推失败[Puppeteer]: ${safeString(e?.message || e)}` });
      }
    }

    let loggedUserId = "";
    try {
      stats.xCalls += 1;
      loggedUserId = await getXLoggedUserId(xClient);
    } catch (e) {
      return res.status(502).json({ error: `获取 user id 失败：${formatXError(e)}` });
    }
    if (!loggedUserId) return res.status(502).json({ error: "无法获取当前账号的 user id，无法 retweet" });

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.retweet(loggedUserId, tweetId);
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }

    res.json({ ok: true, mode: "api", proxy: redactUrlCredentials(proxyUrl), api: apiRes });
  });

  app.post("/api/test-repost", async (req, res) => {
    const tweetId = safeString(req.body?.tweetId).trim();
    if (!tweetId) return res.status(400).json({ error: "缺少 tweetId" });
    if (!config?.twitterApi?.apiKey) return res.status(400).json({ error: "缺少 twitterapi.io API Key（用于读取原推内容）" });

    const dryRun = Boolean(config?.forward?.dryRun);
    addLog(`[测试] 搬运 tweet_id=${tweetId} dryRun=${dryRun}`);

    let prepared;
    try {
      prepared = await prepareRepostFromTweet(config, tweetId, "", { download: true, requireSourceTweet: true, strictPhotos: true });
    } catch (e) {
      return res.status(502).json({ error: safeString(e?.message || e) });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        prepared: { tweetId: prepared.tweetId, text: prepared.text, photoUrls: prepared.photoUrls, downloadDir: prepared.downloadDir },
      });
    }

    const forwardProfileDir = safeString(config?.forward?.x?.profileDir).trim();
    const hasForwardProfile = Boolean(forwardProfileDir);

    let xClient = null;
    let proxyUrl = "";
    let useBrowserMode = false;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      if (hasForwardProfile) {
        useBrowserMode = true;
        proxyUrl = getXProxyUrl(config);
      } else {
        return res.status(400).json({ error: safeString(e?.message || e) });
      }
    }

    if (useBrowserMode) {
      const browserAccount = { id: "forward", name: "forward", proxy: getXProxyUrl(config), x: { profileDir: forwardProfileDir } };
      const filePaths = (prepared.media || [])
        .map((m) => path.join(prepared.downloadDir || "", safeString(m?.fileName).trim()))
        .filter((p) => safeString(p).trim());

      let newTweetId = "";
      try {
        stats.xCalls += 1;
        newTweetId = await bulkPostViaPuppeteer(browserAccount, truncateTweetText(prepared.text || "", 280), filePaths);
      } catch (e) {
        return res.status(502).json({ error: `发帖失败[Puppeteer]: ${safeString(e?.message || e)}` });
      }

      return res.json({
        ok: true,
        mode: "browser",
        profileDir: forwardProfileDir,
        proxy: redactUrlCredentials(proxyUrl),
        source: { tweetId: prepared.tweetId, photos: prepared.photoUrls?.length || 0, saved: prepared.downloadDir },
        posted: { tweetId: newTweetId || "" },
      });
    }

    let mediaIds;
    try {
      mediaIds = await uploadMediaToX(xClient, prepared.media);
    } catch (e) {
      return res.status(502).json({ error: `上传媒体失败：${formatXError(e)}` });
    }

    const payload = { text: truncateTweetText(prepared.text || "", 280) };
    if (mediaIds.length) payload.media = { media_ids: mediaIds };
    if (!payload.text && mediaIds.length === 0) return res.status(400).json({ error: "无可发布内容（text/media 均为空）" });

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.post("tweets", payload, { timeout: X_REQUEST_TIMEOUT_MS });
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }

    return res.json({
      ok: true,
      mode: "api",
      proxy: redactUrlCredentials(proxyUrl),
      source: { tweetId: prepared.tweetId, photos: prepared.photoUrls?.length || 0, saved: prepared.downloadDir },
      posted: apiRes,
    });
  });

  app.get("/api/test-x-auth", async (_req, res) => {
    addLog("[测试] X auth 测试：v2.me");
    const forwardProfileDir = safeString(config?.forward?.x?.profileDir).trim();
    const hasForwardProfile = Boolean(forwardProfileDir);

    let xClient = null;
    let proxyUrl = "";
    let useBrowserMode = false;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      if (hasForwardProfile) {
        useBrowserMode = true;
        proxyUrl = getXProxyUrl(config);
      } else {
        return res.status(400).json({ error: safeString(e?.message || e) });
      }
    }

    if (useBrowserMode) {
      const browserAccount = { id: "forward", name: "forward", proxy: getXProxyUrl(config), x: { profileDir: forwardProfileDir } };
      try {
        stats.xCalls += 1;
        const r = await xAuthViaPuppeteer(browserAccount);
        return res.json({ ok: true, mode: "browser", profileDir: forwardProfileDir, proxy: redactUrlCredentials(proxyUrl), result: r });
      } catch (e) {
        return res.status(502).json({ error: `验证失败[Puppeteer]: ${safeString(e?.message || e)}` });
      }
    }

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.get("users/me", {}, { timeout: X_REQUEST_TIMEOUT_MS });
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }
    return res.json({ ok: true, mode: "api", proxy: redactUrlCredentials(proxyUrl), api: apiRes });
  });

  app.post("/api/monitor/start", async (_req, res) => {
    if (monitorRunning) return res.json({ ok: true, monitor: { running: true } });
    startMonitor();
    res.json({ ok: true, monitor: { running: true } });
  });

  app.post("/api/monitor/stop", async (_req, res) => {
    stopMonitor();
    res.json({ ok: true, monitor: { running: false } });
  });

	  app.post("/api/monitor/run-once", async (_req, res) => {
	    try {
	      await monitorTick("manual");
	      await processQueue();
	      return res.json({
	        ok: true,
	        message: "已执行一次轮询",
	        stats: { apiCalls: stats.apiCalls, xCalls: stats.xCalls, translateCalls: stats.translateCalls, queueSize: Array.isArray(db?.queue) ? db.queue.length : 0 },
	      });
	    } catch (e) {
	      const err = safeString(e?.message || e);
	      addLog(`[监控] 手动执行失败：${err}`);
	      return res.status(502).json({ error: err });
	    }
	  });

  app.get("/api/logs", async (_req, res) => {
    res.json({
      logs,
      monitor: { running: monitorRunning },
	      stats: {
	        apiCalls: stats.apiCalls,
	        xCalls: stats.xCalls,
	        translateCalls: stats.translateCalls,
	        queueSize: Array.isArray(db?.queue) ? db.queue.length : 0,
	      },
	    });
	  });

  app.post("/api/logs/clear", async (_req, res) => {
    logs.splice(0, logs.length);
    res.json({ ok: true });
  });

  app.post("/api/queue/clear", async (req, res) => {
    try {
      const target = normalizeScreenName(req.body?.target || "");
      if (!Array.isArray(db.queue)) db.queue = [];

      const before = db.queue.length;
      if (target) {
        db.queue = db.queue.filter((q) => normalizeScreenName(q?.target || "") !== target);
      } else {
        db.queue = [];
      }
      const removed = before - db.queue.length;

      await writeJson(DB_PATH, db);
      addLog(`[队列] 已清空${target ? `：@${target}` : ""} removed=${removed}`);
      return res.json({ ok: true, removed, queueSize: db.queue.length });
    } catch (e) {
      const err = safeString(e?.message || e);
      addLog(`[队列] 清空失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  // =========================
  // 批量起号（多账号定时发帖）
  // =========================

  app.get("/api/bulk/config", async (_req, res) => {
    res.json({ config: bulkConfig });
  });

  app.get("/api/bulk/debug", async (_req, res) => {
    res.json({
      ok: true,
      pkg: Boolean(process.pkg),
      execPath: process.execPath,
      node: process.version,
      appDir: APP_DIR,
      dataDir: DATA_DIR,
      publicDir: PUBLIC_DIR,
      bulkConfigPath: BULK_CONFIG_PATH,
      bulkImagesDefaultDir: BULK_IMAGES_DEFAULT_DIR,
      imageDirValue: safeString(bulkConfig?.imageDir).trim(),
      imageDirResolved: resolveBulkImageDir(bulkConfig),
    });
  });

  app.post("/api/bulk/config", async (req, res) => {
    try {
      const incoming = req.body || {};
      const nextFile = normalizeBulkConfig(incoming);
      const ensured2 = ensureBulkAccountIds(nextFile);

      const wasRunning = bulkRunning;
      if (wasRunning) stopBulkScheduler();

      bulkConfigFile = ensured2.config;
      await writeJson(BULK_CONFIG_PATH, bulkConfigFile);
      bulkConfig = normalizeBulkConfig(bulkConfigFile);
      startBulkImageWatcher();

      addBulkLog("[配置] 已保存");

      await scanBulkImages("config-save");
      if (wasRunning) startBulkScheduler();

      return res.json({ ok: true, config: bulkConfig });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[配置] 保存失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  app.get("/api/bulk/status", async (_req, res) => {
    const accounts = getBulkAccounts().map((a) => {
      const id = safeString(a?.id).trim();
      const state = id ? bulkStates.get(id) : null;
      const creds = getBulkXCredentials(a);
      const hasCreds = Boolean(creds.appKey && creds.appSecret && creds.accessToken && creds.accessSecret);
      return {
        id,
        name: safeString(a?.name).trim(),
        enabled: Boolean(a?.enabled),
        dryRun: Boolean(a?.dryRun),
        followCommentersEnabled: Boolean(a?.followCommentersEnabled),
        proxy: redactUrlCredentials(safeString(a?.proxy).trim()),
        schedule: a?.schedule || {},
        hasCreds,
        state: state || {
          running: false,
          nextPostAt: "",
          lastPostAt: "",
          posts: 0,
          lastError: "",
          lastErrorAt: "",
          lastTweetId: "",
          followDailyDate: "",
          followDailyCount: 0,
          followRunning: false,
          followLastRunAt: "",
          followLastTweetUrl: "",
          followDone: 0,
          followSkipped: 0,
          followWarnings: 0,
          followFailed: 0,
          followLastError: "",
          followLastErrorAt: "",
        },
      };
    });

    res.json({
      ok: true,
      running: bulkRunning,
      followJob: bulkFollowJob,
      imageDir: resolveBulkImageDir(bulkConfig),
      images: { count: Array.isArray(bulkImagesCache?.images) ? bulkImagesCache.images.length : 0, scannedAt: bulkImagesCache?.scannedAt || "" },
      accounts,
    });
  });

  app.post("/api/bulk/start", async (_req, res) => {
    if (!bulkRunning) startBulkScheduler();
    res.json({ ok: true, running: bulkRunning });
  });

  app.post("/api/bulk/stop", async (_req, res) => {
    stopBulkScheduler();
    res.json({ ok: true, running: bulkRunning });
  });

  app.post("/api/bulk/run-once", async (req, res) => {
    const accountId = safeString(req.body?.accountId).trim();
    if (!accountId) return res.status(400).json({ error: "缺少 accountId" });

    const a = findBulkAccount(accountId);
    if (!a) return res.status(404).json({ error: "账号不存在" });

    const state = upsertBulkState(a.id);
    if (!state) return res.status(500).json({ error: "账号状态异常" });
    if (state.running) return res.status(409).json({ error: "该账号正在发帖中" });

    state.running = true;
    state.lastError = "";
    state.lastErrorAt = "";
    try {
      const result = await bulkPostOnce(a, { trigger: "manual" });
      if (!result?.skipped) state.posts = Number(state.posts || 0) + 1;
      state.lastPostAt = nowIso();

      if (bulkRunning) {
        const delayMs = computeBulkDelayMs(a.schedule);
        state.nextPostAt = new Date(Date.now() + delayMs).toISOString();
        scheduleBulkNext(a.id, delayMs);
      }

      return res.json({ ok: true, result, state });
    } catch (e) {
      state.lastError = safeString(e?.message || e);
      state.lastErrorAt = nowIso();
      addBulkLog(`[手动] 发帖失败 account=${safeString(a.name || a.id)} error=${state.lastError}`);
      return res.status(502).json({ error: state.lastError, state });
    } finally {
      state.running = false;
    }
  });

  // 关注某条推文下的评论用户（按账号执行，复用浏览器 Profile 登录态）
  app.post("/api/bulk/follow-commenters/start", async (req, res) => {
    try {
      const tweetUrl = safeString(req.body?.tweetUrl).trim();
      if (!tweetUrl) return res.status(400).json({ error: "缺少 tweetUrl" });
      const maxPerAccount = Math.round(Number(req.body?.maxPerAccount) || 30);

      if (bulkFollowJob?.running) return res.status(409).json({ error: "关注任务正在运行中" });

      const url = normalizeXStatusUrl(tweetUrl);
      if (!isLikelyXStatusUrl(url)) return res.status(400).json({ error: "链接不合法：请提供 X 推文链接（包含 /status/）" });

      const accounts = getBulkAccounts().filter((a) => Boolean(a?.followCommentersEnabled));
      if (accounts.length === 0) return res.status(400).json({ error: "没有可执行账号：请在账号里勾选「关注评论」" });

      // 启动后台任务（不阻塞接口）
      runBulkFollowCommenters(url, { maxPerAccount }).catch((e) => {
        const err = safeString(e?.message || e);
        addBulkLog(`[关注] 全局任务异常：${err}`);
        bulkFollowJob.running = false;
        bulkFollowJob.finishedAt = nowIso();
      });

      return res.json({ ok: true, job: bulkFollowJob });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[关注] 启动失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  app.post("/api/bulk/follow-commenters/stop", async (_req, res) => {
    setBulkFollowStopRequested();
    addBulkLog("[关注] 已请求停止");
    res.json({ ok: true, job: bulkFollowJob });
  });

  app.get("/api/bulk/follow-commenters/status", async (_req, res) => {
    const accounts = getBulkAccounts()
      .filter((a) => Boolean(a?.followCommentersEnabled))
      .map((a) => {
        const id = safeString(a?.id).trim();
        const st = id ? upsertBulkState(id) : null;
        ensureBulkFollowDailyState(st);
        return {
          id,
          name: safeString(a?.name).trim(),
          proxy: redactUrlCredentials(getBulkProxyUrl(a)),
          profileDir: safeString(a?.x?.profileDir).trim(),
          state: st || {},
        };
      });
    res.json({ ok: true, job: bulkFollowJob, accounts });
  });

  app.post("/api/bulk/test-x-auth", async (req, res) => {
    const accountId = safeString(req.body?.accountId).trim();
    if (!accountId) return res.status(400).json({ error: "缺少 accountId" });

    const a = findBulkAccount(accountId);
    if (!a) return res.status(404).json({ error: "账号不存在" });

    let xClient;
    let proxyUrl;
    try {
      const created = createXClientForBulkAccount(a);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      return res.status(400).json({ error: safeString(e?.message || e) });
    }

    let me;
    try {
      stats.xCalls += 1;
      me = await xClient.v2.get("users/me", {}, { timeout: X_REQUEST_TIMEOUT_MS });
    } catch (e) {
      return res.status(502).json({ error: formatXErrorVerbose(e, { proxy: proxyUrl }) });
    }

    return res.json({ ok: true, proxy: redactUrlCredentials(proxyUrl), me });
  });

  app.get("/api/bulk/logs", async (_req, res) => {
    res.json({ logs: bulkLogs, running: bulkRunning });
  });

  app.post("/api/bulk/logs/clear", async (_req, res) => {
    bulkLogs.splice(0, bulkLogs.length);
    res.json({ ok: true });
  });

  app.get("/api/bulk/images", async (_req, res) => {
    try {
      const cache = await scanBulkImages("manual");
      startBulkImageWatcher();
      return res.json({
        ok: true,
        dir: cache.dir,
        scannedAt: cache.scannedAt,
        images: (cache.images || []).map((i) => ({
          name: i.name,
          size: i.size,
          mtimeMs: i.mtimeMs,
          url: `/api/bulk/image?name=${encodeURIComponent(i.name)}&v=${encodeURIComponent(String(i.mtimeMs || 0))}`,
        })),
      });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[图库] 列表获取失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  app.post("/api/bulk/images/refresh", async (_req, res) => {
    try {
      const cache = await scanBulkImages("refresh");
      startBulkImageWatcher();
      return res.json({ ok: true, dir: cache.dir, scannedAt: cache.scannedAt, count: (cache.images || []).length });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[图库] 刷新失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  app.get("/api/bulk/image", async (req, res) => {
    const dir = resolveBulkImageDir(bulkConfig);
    if (!dir) return res.status(400).json({ error: "未配置图片目录（imageDir）" });

    const name = safeString(req.query?.name).trim();
    if (!name) return res.status(400).json({ error: "缺少 name" });

    const safeName = path.basename(name);
    if (!safeName || !isImageFileName(safeName)) return res.status(400).json({ error: "文件名不合法或非图片" });

    const baseDir = path.resolve(dir);
    const fullPath = path.resolve(baseDir, safeName);
    const baseDirLower = baseDir.toLowerCase();
    const fullLower = fullPath.toLowerCase();
    if (!fullLower.startsWith(`${baseDirLower}${path.sep}`)) return res.status(400).json({ error: "路径不合法" });

    try {
      await fs.access(fullPath);
    } catch {
      return res.status(404).json({ error: "文件不存在" });
    }

    return res.sendFile(fullPath);
  });

  app.put("/api/bulk/upload", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
    try {
      const dir = resolveBulkImageDir(bulkConfig);
      if (!dir) return res.status(400).json({ error: "未配置图片目录（imageDir）" });

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "缺少文件内容" });

      let fileName = safeString(req.query?.filename).trim() || safeString(req.headers["x-filename"]).trim();
      if (!fileName) return res.status(400).json({ error: "缺少 filename（query 或 x-filename）" });

      fileName = path.basename(fileName);
      fileName = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
      if (!fileName) return res.status(400).json({ error: "filename 不合法" });

      const contentType = safeString(req.headers["content-type"]).trim().toLowerCase();
      if (!isImageFileName(fileName)) {
        if (contentType === "image/jpeg") fileName += ".jpg";
        else if (contentType === "image/png") fileName += ".png";
        else if (contentType === "image/gif") fileName += ".gif";
        else if (contentType === "image/webp") fileName += ".webp";
      }
      if (!isImageFileName(fileName)) return res.status(400).json({ error: "仅支持 jpg/jpeg/png/gif/webp" });

      await fs.mkdir(dir, { recursive: true });

      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      let finalName = fileName;

      const targetPath = () => path.join(dir, finalName);
      if (await fileExists(targetPath())) {
        const suffix = generateId("u").split("_").slice(-2).join("_");
        finalName = `${base}-${suffix}${ext}`;
      }

      await fs.writeFile(targetPath(), body);
      addBulkLog(`[上传] 已保存：${finalName} size=${body.length}`);

      await scanBulkImages("upload");

      return res.json({ ok: true, fileName: finalName });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[上传] 失败：${err}`);
      return res.status(500).json({ error: err });
    }
  });

  async function loginTwitterViaBrowser(account) {
    const exe = findLocalBrowser();
    if (!exe) throw new Error("未找到本地 Chrome 或 Edge 浏览器，无法打开登录窗口。");

    const a = account && typeof account === "object" ? account : null;
    const accountId = safeString(a?.id).trim() || "acc";
    const profileDirValue = safeString(a?.x?.profileDir).trim() || defaultBulkBrowserProfileDirValue(accountId);
    const profileDir = resolveAppDirPath(profileDirValue);

    if (!profileDir) throw new Error("Profile 目录解析失败");
    await fs.mkdir(profileDir, { recursive: true });

    const proxyUrl = getBulkProxyUrl(a);

    console.log(`[Login] Launching browser: ${exe} profile=${profileDir}`);

    let browser;
    try {
      const args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--window-position=0,0",
        "--window-size=1280,800",
      ];
      if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

      browser = await puppeteer.launch({
        executablePath: exe,
        headless: false,
        defaultViewport: null,
        userDataDir: profileDir,
        ignoreDefaultArgs: ["--enable-automation"],
        args,
      });
    } catch (e) {
      throw new Error(`启动浏览器失败: ${e.message}`);
    }

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    try {
      await page.goto("https://x.com/i/flow/login", { waitUntil: "networkidle2", timeout: 60000 });
    } catch (e) {
      console.log(`[Login] Nav warning: ${e.message}`);
    }

    return new Promise((resolve, reject) => {
      let checkTimer = null;
      let timeoutTimer = null;
      let injected = false;

      const cleanup = () => {
        clearInterval(checkTimer);
        clearTimeout(timeoutTimer);
        browser.close().catch(() => {});
      };

      checkTimer = setInterval(async () => {
        try {
          if (browser.process()?.killed) {
            cleanup();
            reject(new Error("浏览器已关闭"));
            return;
          }

          if (!injected) {
            injected = true;
            page
              .evaluate(() => {
                try {
                  const div = document.createElement("div");
                  div.id = "x-login-helper";
                  div.style =
                    "position:fixed;top:0;left:0;right:0;background:#1d9bf0;color:white;z-index:99999;padding:12px;text-align:center;font-family:sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.2);";
                  div.innerHTML = `
                    <div style="font-size:16px;font-weight:bold;margin-bottom:4px;">🔐 请完成登录</div>
                    <div style="font-size:13px;opacity:0.95;">
                      可选择「Continue with Google」或账号密码登录；登录成功后保持在首页，窗口会自动关闭。
                    </div>
                  `;
                  document.body.appendChild(div);
                } catch {}
              })
              .catch(() => {});
          }

          const loggedIn = await page
            .evaluate(() => {
              return Boolean(
                document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
                  document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
                  document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
                  document.querySelector('[data-testid="AppTabBar_Profile_Link"]'),
              );
            })
            .catch(() => false);

          // 有些登录方式（例如 Continue with Google）会打开新窗口/新标签页，导致主页面一直停在登录页。
          // 兜底：只要检测到 auth_token/ct0 等关键 Cookie，就认为已登录并自动关闭窗口。
          const cookieLoggedIn = loggedIn
            ? true
            : await (async () => {
                try {
                  const pagesNow = await browser.pages().catch(() => []);
                  const p = pagesNow[0] || page;
                  const cookies = await p.cookies("https://x.com", "https://twitter.com").catch(() => []);
                  return cookies.some((c) => c && (c.name === "auth_token" || c.name === "ct0"));
                } catch {
                  return false;
                }
              })();

          if (cookieLoggedIn) {
            cleanup();
            resolve({ profileDir: profileDirValue });
          }
        } catch {}
      }, 1000);

      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error("操作超时（3分钟），请重试"));
      }, 180_000);
    });
  }

  async function handleBulkOpenLogin(req, res) {
    try {
      const { accountId } = req.body || {};
      if (!accountId) throw new Error("缺少 accountId");

      const acc = findBulkAccount(accountId);
      if (!acc) throw new Error("账号未找到");
      if (!acc.x) acc.x = {};

      // 若未设置，则为该账号分配一个默认 Profile 目录（相对 APP_DIR）
      if (!safeString(acc.x.profileDir).trim()) {
        acc.x.profileDir = defaultBulkBrowserProfileDirValue(acc.id);
      }

      const result = await loginTwitterViaBrowser(acc);
      if (result?.profileDir) acc.x.profileDir = safeString(result.profileDir).trim() || acc.x.profileDir;

      // 采用 Profile 方式后，不再需要 Cookie/QueryId（避免误用旧值）
      acc.x.cookieString = "";
      acc.x.queryId = "";

      ensureBulkAccountIds(bulkConfig);
      await writeJson(BULK_CONFIG_PATH, bulkConfig);

      addBulkLog(`[登录] 已保存浏览器 Profile：account=${safeString(acc.name || acc.id)} dir=${safeString(acc.x.profileDir)}`);
      return res.json({ ok: true, msg: "登录完成，已保存 Profile（后续发帖将复用）", profileDir: acc.x.profileDir });
    } catch (e) {
      const err = safeString(e?.message || e);
      addBulkLog(`[登录] 失败：${err}`);
      return res.status(500).json({ error: err });
    }
  }

  async function handleForwardOpenLogin(_req, res) {
    try {
      const next = configFile && typeof configFile === "object" ? configFile : {};
      next.forward = next.forward || {};
      next.forward.x = next.forward.x || {};

      // 若未设置，则为主面板分配一个默认 Profile 目录（相对 APP_DIR）
      if (!safeString(next.forward.x.profileDir).trim()) {
        next.forward.x.profileDir = defaultBulkBrowserProfileDirValue("forward");
      }

      const acc = {
        id: "forward",
        name: "forward",
        proxy: getXProxyUrl(config),
        x: { profileDir: safeString(next.forward.x.profileDir).trim() },
      };

      const result = await loginTwitterViaBrowser(acc);
      if (result?.profileDir) next.forward.x.profileDir = safeString(result.profileDir).trim() || next.forward.x.profileDir;

      configFile = next;
      await writeJson(CONFIG_PATH, configFile);
      config = applyEnvOverrides(configFile);

      addLog(`[登录] 已保存浏览器 Profile：dir=${safeString(next.forward.x.profileDir)}`);
      return res.json({ ok: true, msg: "登录完成，已保存 Profile（转发/发帖将复用）", profileDir: next.forward.x.profileDir });
    } catch (e) {
      const err = safeString(e?.message || e);
      addLog(`[登录] 失败：${err}`);
      return res.status(500).json({ error: err });
    }
  }

  // 主面板登录：保存 Profile（用于监控转发/发帖）
  app.post("/api/open-login", handleForwardOpenLogin);

  // 浏览器登录（推荐）：保存 Profile；兼容旧按钮路径
  app.post("/api/bulk/open-login", handleBulkOpenLogin);
  app.post("/api/bulk/auto-cookie", handleBulkOpenLogin);

  async function listenWithFallback(startPort) {
    let port = startPort;
    const maxTries = 20;
    for (let i = 0; i < maxTries; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const server = await new Promise((resolve, reject) => {
          const server = app.listen(port, () => resolve(server));
          server.on("error", (err) => {
            try {
              server.close(() => {});
            } catch {}
            reject(err);
          });
        });
        const address = server.address();
        if (address && typeof address === "object" && address.port) return address.port;
        return port;
      } catch (e) {
        if (e?.code === "EADDRINUSE") {
          port += 1;
          continue;
        }
        throw e;
      }
    }
    throw new Error(`端口 ${startPort} 起连续 ${maxTries} 个端口都被占用`);
  }

  const actualPort = await listenWithFallback(PORT);
  const baseUrl = `http://localhost:${actualPort}`;
  addLog(`[启动] Server listening on ${baseUrl}`);
  console.log(`Server listening on ${baseUrl}`);

  const autoOpenEnv = parseBoolEnv(process.env.AUTO_OPEN_BROWSER);
  const shouldAutoOpen = Boolean(process.pkg) && (autoOpenEnv === undefined ? true : autoOpenEnv);
  if (shouldAutoOpen) {
    addLog(`[启动] 自动打开浏览器：${baseUrl}`);
    openInBrowser(baseUrl);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
