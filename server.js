const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

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
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
const PUBLIC_DIR = (() => {
  const external = path.join(APP_DIR, "public");
  if (fssync.existsSync(external)) return external;
  return path.join(__dirname, "public");
})();

const LOG_LIMIT = 200;
const QUEUE_MAX_ATTEMPTS = 5;

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

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
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

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

	  if (!(await fileExists(CONFIG_EXAMPLE_PATH))) {
	    await writeJson(CONFIG_EXAMPLE_PATH, {
	      twitterApi: { baseUrl: "https://api.twitterapi.io", apiKey: "" },
	      monitor: { targets: [], pollIntervalSec: 60, includeReplies: false, includeQuoteTweets: true, skipMentions: false },
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
}

const logs = [];
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

async function twitterGetLastTweets(config, userName) {
  const client = createTwitterClient(config);
  stats.apiCalls += 1;
  const res = await client.get("/twitter/user/last_tweets", {
    params: {
      userName,
      includeReplies: Boolean(config?.monitor?.includeReplies),
    },
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
    const me = await xClient.v2.me();
    const id = safeString(me?.data?.id).trim();
    if (id) return id;
  } catch {}

  const user = await xClient.v1.verifyCredentials();
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

let monitorTimer = null;
let monitorRunning = false;
let monitorTickInProgress = false;

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

  let xClient = null;
  let xLoggedUserId = "";
  let xInitError = "";
  let xProxyForLog = "";

  if (enabled && !dryRun) {
    try {
      const created = createXClient(config);
      xClient = created.client;
      xProxyForLog = redactUrlCredentials(created.proxyUrl);
    } catch (e) {
      xInitError = safeString(e?.message || e);
    }
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

    if (xInitError || !xClient) {
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
        const mediaIds = await uploadMediaToX(xClient, prepared.media);

        const payload = {
          text: truncateTweetText(prepared.text || "", 280),
        };
        if (mediaIds.length) payload.media = { media_ids: mediaIds };

        if (!payload.text && mediaIds.length === 0) throw new Error("无可发布内容（text/media 均为空）");

        stats.xCalls += 1;
        const res = await xClient.v2.tweet(payload);
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

      if (item.attempts >= QUEUE_MAX_ATTEMPTS) {
        addLog(`[放弃转发] 超过最大重试次数：tweet_id=${tweetId}`);
        pushFailed(target, tweetId);
        db.queue.splice(i, 1);
        i -= 1;
      }
    }
  }

  await writeJson(DB_PATH, db);
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

      addLog(`[轮询] 正在抓取 @${target} 的最新推文...`);
      let res;
      try {
        res = await twitterGetLastTweets(config, target);
      } catch (e) {
        addLog(`[轮询] 请求失败：@${target} 错误=${formatAxiosError(e)}`);
        continue;
      }

      if (res.status === 401) {
        addLog("[轮询] API Key 无效或未授权（401）");
        continue;
      }
      if (res.status === 429) {
        addLog("[轮询] 命中限流（429），稍后再试");
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        addLog(`[轮询] HTTP ${res.status}：@${target} ${safeString(res.data?.msg || res.data?.message)}`);
        continue;
      }
      if (res.data?.status && res.data.status !== "success") {
        addLog(`[轮询] API 返回 error：@${target} ${safeString(res.data?.msg || res.data?.message)}`);
        continue;
      }

      const tweets = extractTweetArrayFromApiResponse(res.data);
      const pinnedTweetId = extractPinnedTweetIdFromApiResponse(res.data);
      const ids = tweets.map(extractTweetId).filter(Boolean);
      const newestId = maxId(ids);

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

    await processQueue();
  } finally {
    monitorTickInProgress = false;
  }
}

function startMonitor() {
  if (monitorTimer) return;
  const pollIntervalSec = Math.max(10, Number(config?.monitor?.pollIntervalSec || 60));
  monitorTimer = setInterval(() => {
    monitorTick("timer").catch((e) => addLog(`[监控] Tick 异常：${safeString(e?.message || e)}`));
  }, pollIntervalSec * 1000);
  monitorRunning = true;
  addLog(`[监控] 已启动，间隔 ${pollIntervalSec}s`);
}

function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  monitorRunning = false;
  addLog("[监控] 已停止");
}

async function main() {
  await ensureDataFiles();
  configFile = await readJson(CONFIG_PATH, {});
  config = applyEnvOverrides(configFile);
  db = await readJson(DB_PATH, { version: 1, targets: {}, queue: [] });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/config", async (_req, res) => {
    res.json({ config: configFile });
  });

  app.post("/api/config", async (req, res) => {
    const incoming = req.body || {};
    const next = JSON.parse(JSON.stringify(configFile || {}));
    next.twitterApi = next.twitterApi || {};
    next.monitor = next.monitor || {};
    next.forward = next.forward || {};

    if (incoming?.twitterApi?.apiKey !== undefined) next.twitterApi.apiKey = safeString(incoming.twitterApi.apiKey).trim();
    if (incoming?.twitterApi?.baseUrl) next.twitterApi.baseUrl = safeString(incoming.twitterApi.baseUrl).trim();

    if (Array.isArray(incoming?.monitor?.targets)) next.monitor.targets = incoming.monitor.targets.map(normalizeScreenName).filter(Boolean);
    if (incoming?.monitor?.pollIntervalSec !== undefined) next.monitor.pollIntervalSec = Math.max(10, Number(incoming.monitor.pollIntervalSec || 60));
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

    res.json({ ok: true, config: redactSecrets(config) });
  });

  async function handleTestFetch(req, res) {
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
  }

  async function handleTestPost(req, res) {
    const text = safeString(req.body?.text).trim();
    if (!text) return res.status(400).json({ error: "缺少 text" });

    addLog("[测试] X create_tweet 发推测试");
    let xClient;
    let proxyUrl;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      return res.status(400).json({ error: safeString(e?.message || e) });
    }

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.tweet(truncateTweetText(text, 280));
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }

    return res.json({ ok: true, proxy: redactUrlCredentials(proxyUrl), api: apiRes });
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
    let xClient;
    let proxyUrl;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      return res.status(400).json({ error: safeString(e?.message || e) });
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

    res.json({ ok: true, proxy: redactUrlCredentials(proxyUrl), api: apiRes });
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

    let xClient;
    let proxyUrl;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      return res.status(400).json({ error: safeString(e?.message || e) });
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
      apiRes = await xClient.v2.tweet(payload);
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }

    return res.json({
      ok: true,
      proxy: redactUrlCredentials(proxyUrl),
      source: { tweetId: prepared.tweetId, photos: prepared.photoUrls?.length || 0, saved: prepared.downloadDir },
      posted: apiRes,
    });
  });

  app.get("/api/test-x-auth", async (_req, res) => {
    addLog("[测试] X auth 测试：v2.me");
    let xClient;
    let proxyUrl;
    try {
      const created = createXClient(config);
      xClient = created.client;
      proxyUrl = created.proxyUrl;
    } catch (e) {
      return res.status(400).json({ error: safeString(e?.message || e) });
    }

    let apiRes;
    try {
      stats.xCalls += 1;
      apiRes = await xClient.v2.me();
    } catch (e) {
      return res.status(502).json({ error: formatXError(e) });
    }
    return res.json({ ok: true, proxy: redactUrlCredentials(proxyUrl), api: apiRes });
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
	    await monitorTick("manual");
	    res.json({ ok: true, message: "已执行一次轮询", stats: { apiCalls: stats.apiCalls, xCalls: stats.xCalls, translateCalls: stats.translateCalls } });
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
    res.json({ ok: true, removed, queueSize: db.queue.length });
  });

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
