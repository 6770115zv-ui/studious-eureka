"use strict";
importScripts("shared/common.js");

const BUILTIN_CONFIG = {
  owner: "6770115zv-ui", repo: "studious-eureka", workflow: "download.yml", ref: "main",
  token: "", cookieKey: "ea1641dc747be6a7af79e7152865d3f8d566fd74ec00c02cb13db642d05fddc3", autoCleanRelease: "true", updateOwner: "6770115zv-ui", updateRepo: "studious-eureka",
  emailTo: ""
};
try { importScripts("config.js"); } catch {}

const DEFAULTS = { ...BUILTIN_CONFIG, ...(self.DEFAULT_CONFIG || {}) };
const API = "https://api.github.com";
const CFG_KEY = "ytproxy_cfg";
const JOBS_KEY = "ytproxy_jobs";
const HIST_KEY = "ytproxy_history";
const RECS_KEY = "ytproxy_recs";
const UPDATE_HOST = "com.rafi.ytproxy.updater";
const ZIP_CACHE_NAME = "ytcloud-assets-v5";
const KEEPALIVE_ALARM = "ytcloud_keepalive";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
const driving = new Set();
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function getConfig() {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      cfg[k] = String(v).trim();
    }
  }
  if (self.DEFAULT_CONFIG && self.DEFAULT_CONFIG.token && !cfg.token) {
    cfg.token = self.DEFAULT_CONFIG.token;
  }
  for (const k of Object.keys(BUILTIN_CONFIG)) cfg[k] = String(cfg[k] ?? "").trim();
  if (!cfg.workflow) cfg.workflow = "download.yml";
  if (!cfg.ref) cfg.ref = "main";
  if (!cfg.autoCleanRelease) cfg.autoCleanRelease = "true";
  return cfg;
}

async function setConfig(patch) {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  await chrome.storage.local.set({ [CFG_KEY]: { ...stored, ...patch } });
  return getConfig();
}

async function getHistory() {
  return (await chrome.storage.local.get(HIST_KEY))[HIST_KEY] || [];
}

async function addHistoryEntry(entry) {
  const list = await getHistory();
  const vid = self.extractYoutubeId ? self.extractYoutubeId(entry.url) : "";
  const idTailRx = new RegExp("\\s*\\[[a-zA-Z0-9_-]{11}\\]\\.[a-z0-9]+\\x24", "i");
  const cleanTitle = String(entry.title || "").replace(idTailRx, "").trim();
  if (!cleanTitle || cleanTitle.startsWith("http")) return list;
  const filtered = list.filter((x) => (vid ? x.videoId !== vid : x.title !== cleanTitle));
  filtered.unshift({
    videoId: vid || "",
    title: cleanTitle,
    url: entry.url || "",
    quality: entry.quality || "best",
    actualQuality: entry.actualQuality || "",
    timestamp: Date.now()
  });
  const trimmed = filtered.slice(0, 80);
  await chrome.storage.local.set({ [HIST_KEY]: trimmed });
  return trimmed;
}

function updateActionBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  let activeCount = 0;
  for (const job of jobs.values()) {
    if (!TERMINAL.has(job.status)) activeCount++;
  }
  if (activeCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#0284c7" }).catch(() => {});
    chrome.action.setBadgeText({ text: String(activeCount) }).catch(() => {});
    if (chrome.alarms) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  } else {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    if (chrome.alarms) chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      await restoreJobs();
      for (const [id, job] of jobs) {
        if (!TERMINAL.has(job.status)) void driveJob(id);
      }
    }
  });
}

function notifyUser(title, message) {
  if (!chrome.notifications || !chrome.notifications.create) return;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message
    });
  } catch {}
}

async function ghFetch(url, cfg, init = {}, retries = 4) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers || {})
      };
      if (cfg && cfg.token) headers.Authorization = "Bearer " + cfg.token;
      const res = await fetch(url, { ...init, headers, cache: "no-store" });
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await sleep(1500 * attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  throw lastErr || new Error("שגיאת רשת בתקשורת מול GitHub API");
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const YT_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "SIDCC", "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "YSC", "__Secure-YEC", "CONSENT", "SOCS"
]);

async function exportYoutubeCookies() {
  if (!chrome.cookies || !chrome.cookies.getAll) return null;
  try {
    const groups = await Promise.all(["youtube.com", "google.com"].map((d) => chrome.cookies.getAll({ domain: d })));
    const seen = new Set();
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of groups.flat()) {
      const host = c.domain.replace(/^\./, "");
      if (host !== "youtube.com" && !host.endsWith(".youtube.com") && !YT_AUTH_COOKIES.has(c.name)) continue;
      const key = c.domain + "|" + c.name + "|" + c.path;
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = !c.hostOnly && !c.domain.startsWith(".") ? "." + c.domain : c.domain;
      lines.push((c.httpOnly ? "#HttpOnly_" : "") + domain + "\t" + (c.hostOnly ? "FALSE" : "TRUE") + "\t" + c.path + "\t" + (c.secure ? "TRUE" : "FALSE") + "\t" + (c.expirationDate ? Math.floor(c.expirationDate) : 0) + "\t" + c.name + "\t" + c.value);
    }
    return lines.length > 1 ? lines.join("\n") + "\n" : null;
  } catch { return null; }
}

async function encryptCookies(text, hexKey) {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) return "";
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0); blob.set(ct, iv.length);
  return bytesToB64(blob);
}

async function persistJobs() {
  const plain = {};
  for (const [id, job] of jobs) plain[id] = job;
  updateActionBadge();
  try { await chrome.storage.session.set({ [JOBS_KEY]: plain }); } catch {}
  chrome.runtime.sendMessage({ type: "JOBS_CHANGED", jobs: plain }).catch(() => {});
}

async function restoreJobs() {
  if (jobs.size) return;
  try {
    const plain = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || {};
    for (const [id, job] of Object.entries(plain)) jobs.set(id, job);
    updateActionBadge();
  } catch {}
}

function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  if (typeof patch.percent === "number" && typeof job.percent === "number" && patch.percent < 100) {
    patch.percent = Math.max(job.percent, patch.percent);
  }
  Object.assign(job, patch);
  void persistJobs();
  return job;
}

async function findRunByTitle(cfg, targetTitle, signal) {
  const url = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs?event=workflow_dispatch&per_page=35";
  for (let i = 0; i < 120; i++) {
    if (signal && signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(url, cfg);
    if (res.ok) {
      const runs = ((await res.json()).workflow_runs) || [];
      const exact = runs.find((r) => r.display_title === targetTitle || r.name === targetTitle);
      if (exact) return exact.id;
    }
    await sleep(2000);
  }
  throw new Error("לא נמצאה ריצה תואמת ב-GitHub Actions");
}

async function fetchLiveStepInfo(cfg, runId, tickIdx, requestId) {
  try {
    const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + runId + "/jobs", cfg, {}, 1);
    if (!res.ok) return null;
    const data = await res.json();
    const ghJob = (data.jobs || [])[0];
    if (!ghJob || !Array.isArray(ghJob.steps)) return null;
    const active = ghJob.steps.find((s) => s.status === "in_progress");
    const completedCount = ghJob.steps.filter((s) => s.status === "completed").length;
    const totalCount = Math.max(1, ghJob.steps.length);
    if (active) {
      const nameMap = {
        "Set up Deno": {
          label: "מכין סביבת ריצה בענן (Deno)...",
          path: "/runner/_work/studious-eureka (Cloud VM Init)"
        },
        "Install yt-dlp + ffmpeg + curl_cffi + atomicparsley": {
          label: "מתקין כלי הורדה וקידוד (yt-dlp + FFmpeg + PO Token)...",
          path: "/usr/bin/ffmpeg + /usr/local/lib/python3/yt_dlp"
        },
        "Execute Smart Engine v5 (Release + Direct API Blob Bridge + Email Delivery)": {
          label: "מוריד ובונה את הקובץ בענן...",
          path: "/tmp/stage/*.part -> /tmp/out/*.mp4 -> /tmp/pkg/dl-" + requestId + ".zip"
        },
        "Upload Backup Artifact": {
          label: "שומר גיבוי תוצר ב-GitHub...",
          path: "/tmp/out/* -> GitHub Artifact Storage"
        }
      };
      const mapped = nameMap[active.name] || { label: "מבצע שלב: " + active.name, path: "/tmp/stage -> /tmp/out" };
      const baseStepPct = 20 + Math.round((completedCount / totalCount) * 35);
      const smoothBoost = Math.min(16, Math.floor(tickIdx * 1.2));
      return {
        label: mapped.label,
        tempPath: mapped.path,
        pct: Math.min(72, baseStepPct + smoothBoost)
      };
    }
  } catch {}
  return null;
}

async function waitForRun(cfg, runId, requestId, onTick, signal) {
  let cachedStepInfo = null;
  for (let i = 0; i < 900; i++) {
    if (signal && signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + runId, cfg);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const run = await res.json();
    if (run.status === "completed") return run.conclusion;
    if (run.status === "in_progress" && i % 2 === 0) {
      const latest = await fetchLiveStepInfo(cfg, runId, i, requestId);
      if (latest) cachedStepInfo = latest;
    } else if (cachedStepInfo) {
      cachedStepInfo = {
        label: cachedStepInfo.label,
        tempPath: cachedStepInfo.tempPath,
        pct: Math.min(72, cachedStepInfo.pct + 1)
      };
    }
    if (onTick) onTick(run, i, cachedStepInfo);
    await sleep(3500);
  }
  throw new Error("זמן ההמתנה הסתיים");
}

async function findReleaseAssetsByTag(cfg, tag) {
  let rel = null;
  const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/releases/tags/" + tag, cfg);
  if (res.ok) {
    rel = await res.json();
  } else {
    const listRes = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/releases?per_page=20", cfg);
    if (listRes.ok) {
      const all = await listRes.json();
      if (Array.isArray(all)) rel = all.find((r) => r.tag_name === tag || r.name === tag) || null;
    }
  }
  if (!rel) return null;
  let blobShas = [];
  let qualityInfo = "";
  let emailStatus = "";
  let cloudTempPath = "";
  if (rel.body && String(rel.body).trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(String(rel.body).trim());
      if (Array.isArray(parsed.blobs)) blobShas = parsed.blobs;
      if (parsed.quality_info) qualityInfo = String(parsed.quality_info);
      if (parsed.email_status) emailStatus = String(parsed.email_status);
      if (parsed.cloud_temp_path) cloudTempPath = String(parsed.cloud_temp_path);
    } catch {}
  }
  const assets = (rel.assets || []).filter((a) => a.url || a.browser_download_url).map((a) => ({
    id: a.id, name: a.name, size: a.size || 0, apiUrl: a.url, url: a.browser_download_url, releaseId: rel.id, tagName: rel.tag_name, blobShas, qualityInfo, emailStatus, cloudTempPath
  }));
  return assets.length ? assets : null;
}

async function deleteReleaseAndTagByName(cfg, tag) {
  try {
    const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/releases/tags/" + tag, cfg);
    if (res.ok) {
      const rel = await res.json();
      if (rel && rel.id) await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/releases/" + rel.id, cfg, { method: "DELETE" });
    }
    await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/git/refs/tags/" + tag, cfg, { method: "DELETE" });
  } catch {}
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Unzip and Blob creation" });
}

async function fetchDirectBlobsToCache(cfg, blobShas, jobId) {
  if (!Array.isArray(blobShas) || !blobShas.length) return null;
  try {
    const chunks = [];
    let totalLen = 0;
    for (let i = 0; i < blobShas.length; i++) {
      const sha = blobShas[i];
      const localPct = Math.round(((i) / blobShas.length) * 100);
      patchJob(jobId, {
        localDlPct: localPct,
        percent: 75 + Math.round((i / blobShas.length) * 14),
        tempPath: "CacheStorage://" + ZIP_CACHE_NAME + "/asset-" + jobId + ".zip (Git Blob Part " + (i + 1) + "/" + blobShas.length + ")",
        detail: "מוריד למחשב דרך API ישיר: " + localPct + "% (חלק " + (i + 1) + "/" + blobShas.length + ")..."
      });
      const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/git/blobs/" + sha, cfg);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.content) return null;
      const bytes = b64ToBytes(data.content);
      chunks.push(bytes);
      totalLen += bytes.byteLength;
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    const cacheKey = "https://ytcloud.local/asset-" + jobId + "-" + Date.now() + ".zip";
    const cache = await caches.open(ZIP_CACHE_NAME);
    await cache.put(cacheKey, new Response(merged, { headers: { "Content-Type": "application/zip" } }));
    patchJob(jobId, {
      localDlPct: 100,
      percent: 90,
      tempPath: cacheKey + " (" + self.formatBytes(totalLen) + ")"
    });
    return cacheKey;
  } catch {
    return null;
  }
}

async function unpackZipUrl(assetOrUrl, jobId, cfg, rawZip = false) {
  await ensureOffscreen();
  const apiUrl = typeof assetOrUrl === "string" ? assetOrUrl : (assetOrUrl.apiUrl || assetOrUrl.url);
  const fallbackUrl = typeof assetOrUrl === "string" ? "" : (assetOrUrl.url || "");
  const zipName = (typeof assetOrUrl === "object" && assetOrUrl.name) ? assetOrUrl.name : ("dl-" + jobId + ".zip");
  const expectedSize = (typeof assetOrUrl === "object" && assetOrUrl.size) ? assetOrUrl.size : 0;
  const blobShas = (typeof assetOrUrl === "object" && assetOrUrl.blobShas) ? assetOrUrl.blobShas : [];

  let cacheKey = null;
  if (blobShas && blobShas.length) {
    cacheKey = await fetchDirectBlobsToCache(cfg, blobShas, jobId);
  }

  let lastErr = "שגיאה במשיכת או פריסת ה-ZIP";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UNZIP_ARTIFACT",
      jobId,
      cacheKey,
      url: apiUrl,
      fallbackUrl,
      token: cfg.token,
      rawZip,
      zipName,
      expectedSize
    }).catch((e) => ({ ok: false, error: e.message }));
    if (res && res.ok && res.files && res.files.length) return res.files;
    lastErr = (res && res.error) || lastErr;
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw new Error(lastErr);
}

const pendingNames = new Map();
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const desired = pendingNames.get(item.url);
    if (!desired) { suggest(); return; }
    pendingNames.delete(item.url);
    suggest({ filename: desired, conflictAction: "uniquify" });
  });
}

function sanitizeFilename(name) {
  const edgeDots = new RegExp("^[. ]+|[. ]+\\x24", "g");
  const segs = String(name || "").split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(edgeDots, "").slice(0, 150)).filter(Boolean);
  return segs.length ? segs.join("/") : "download.mp4";
}

function saveBlob(blobUrl, filename, jobId) {
  return new Promise((resolve, reject) => {
    pendingNames.set(blobUrl, filename);
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingNames.delete(blobUrl);
        reject(new Error("שגיאה בשמירת הקובץ במחשב"));
        return;
      }

      // מעקב רציף אחרי כתיבת הקובץ לדיסק המקומי והצגת הנתיב הזמני (.crdownload) והסופי במחשב!
      const pollTimer = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          const item = results && results[0];
          if (!item) return;
          const diskPath = item.filename || filename;
          if (item.state === "in_progress") {
            const dlPct = item.totalBytes > 0 ? Math.round((item.bytesReceived / item.totalBytes) * 100) : 100;
            patchJob(jobId, {
              localDlPct: dlPct,
              tempPath: diskPath + ".crdownload (Local Disk Write -> " + blobUrl + ")",
              detail: "כותב קובץ לתיקיית ההורדות במחשב: " + dlPct + "%..."
            });
          } else if (item.state === "complete") {
            patchJob(jobId, {
              localDlPct: 100,
              finalDiskPath: diskPath
            });
          }
        });
      }, 300);

      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          clearInterval(pollTimer);
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            const item = results && results[0];
            if (item && item.filename) {
              patchJob(jobId, { finalDiskPath: item.filename, localDlPct: 100 });
            }
            if (blobUrl.startsWith("blob:")) {
              chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
            }
            if (delta.state.current === "complete") resolve((item && item.filename) || filename);
            else reject(new Error("שמירת הקובץ הופסקה"));
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

async function driveJob(jobId) {
  if (driving.has(jobId)) return;
  driving.add(jobId);
  const job = jobs.get(jobId);
  if (!job) { driving.delete(jobId); return; }
  const signal = { get cancelled() { const j = jobs.get(jobId); return !j || j.status === "cancelled"; } };

  try {
    await ensureOffscreen();
    const cfg = await getConfig();
    const tag = "dl-" + job.requestId;
    if (!job.runId) {
      patchJob(jobId, {
        status: "queued",
        detail: "מאתר ריצה ב-GitHub Actions...",
        tempPath: "GitHub Actions Queue -> dl-" + job.requestId,
        percent: 12
      });
      const runId = await findRunByTitle(cfg, tag, signal);
      patchJob(jobId, { runId });
    }
    patchJob(jobId, { status: "running", detail: "מתחבר לשרת GitHub Actions...", percent: 20 });
    const conclusion = await waitForRun(cfg, jobs.get(jobId).runId, job.requestId, (run, tickIdx, stepInfo) => {
      const fallbackPct = Math.min(68, 20 + Math.floor(tickIdx * 1.5));
      patchJob(jobId, {
        detail: stepInfo ? stepInfo.label : (run.status === "queued" ? "ממתין בתור ב-GitHub..." : "מעבד ומוריד מדיה ב-GitHub Actions..."),
        tempPath: (stepInfo && stepInfo.tempPath) || ("/tmp/stage -> /tmp/out -> /tmp/pkg/dl-" + job.requestId + ".zip"),
        percent: stepInfo ? stepInfo.pct : fallbackPct
      });
    }, signal);

    if (conclusion !== "success") throw new Error("הריצה הסתיימה עם סטטוס: " + conclusion);
    patchJob(jobId, {
      status: "fetching",
      localDlPct: 0,
      detail: "מתחיל הורדת קובץ מהענן למחשב (0%)...",
      tempPath: "GitHub Release Asset -> Local Browser Stream Buffer",
      percent: 75
    });

    let files = null;
    let detectedQuality = "";
    let detectedEmailStatus = "";

    for (let a = 0; a < 10 && !files; a++) {
      const assets = await findReleaseAssetsByTag(cfg, tag).catch(() => null);
      if (assets && assets.length) {
        if (assets[0].qualityInfo) detectedQuality = assets[0].qualityInfo;
        if (assets[0].emailStatus) detectedEmailStatus = assets[0].emailStatus;
        if (assets[0].cloudTempPath) patchJob(jobId, { tempPath: assets[0].cloudTempPath });
        if (detectedQuality) patchJob(jobId, { actualQuality: detectedQuality });

        const isBundle = job.mode === "collection";
        const inner = [];
        for (const x of assets) {
          try {
            const isZip = x.name.toLowerCase().endsWith(".zip");
            const unpacked = await unpackZipUrl(x, jobId, cfg, isBundle || !isZip);
            inner.push(...unpacked);
          } catch (unpackErr) {
            console.warn("Release asset unpack warning:", unpackErr);
          }
        }
        if (inner.length) { files = inner; break; }
      }
      await sleep(2500);
    }

    if (!files) {
      patchJob(jobId, { detail: "מושך תוצר מגיבוי Artifacts ב-GitHub...", percent: 82 });
      const artRes = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + jobs.get(jobId).runId + "/artifacts", cfg);
      const list = ((await artRes.json()).artifacts) || [];
      const found = list.find((x) => x.name === tag) || list[0];
      if (!found) throw new Error("לא נמצא תוצר להורדה ב-Release או ב-Artifacts");
      const artUrl = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/artifacts/" + found.id + "/zip";
      const isBundle = job.mode === "collection";
      files = await unpackZipUrl({ apiUrl: artUrl, url: "", name: tag + ".zip", size: found.size_in_bytes || 0 }, jobId, cfg, isBundle);
    }

    patchJob(jobId, { status: "saving", localDlPct: 100, detail: "שומר קובץ בתיקיית ההורדות במחשב...", percent: 94 });
    const saved = [];
    for (const f of files) {
      const name = sanitizeFilename(f.name);
      await saveBlob(f.blobUrl || f.url, name, jobId);
      saved.push(name);
    }

    await addHistoryEntry({
      url: job.url,
      title: saved[0] || job.title || job.url,
      quality: job.quality,
      actualQuality: detectedQuality
    });

    if (cfg.autoCleanRelease === "true") await deleteReleaseAndTagByName(cfg, tag);
    const qualityNote = detectedQuality ? (" | איכות: " + detectedQuality) : "";
    const emailNote = detectedEmailStatus
      ? (" | " + detectedEmailStatus)
      : (job.sendEmail ? " | נשלח גם למייל הקבוע" : "");

    patchJob(jobId, {
      status: "completed",
      localDlPct: 100,
      actualQuality: detectedQuality,
      detail: "הושלם ונשמר במחשב! (" + saved.length + " קבצים)" + qualityNote + emailNote,
      files: saved,
      percent: 100
    });
    notifyUser("הורדה הושלמה בהצלחה", (saved[0] || job.title || "הקובץ נשמר") + qualityNote + emailNote);
  } catch (err) {
    patchJob(jobId, { status: "failed", detail: err.message, error: err.message });
  } finally {
    driving.delete(jobId);
  }
}

async function startDownload(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    return { ok: false, error: "חסרות הגדרות חיבור (owner/repo/token)" };
  }
  const requestId = crypto.randomUUID();
  let cookiesEnc = "";
  if (cfg.cookieKey && cfg.cookieKey.length === 64) {
    const cookies = await exportYoutubeCookies();
    if (cookies) {
      try { cookiesEnc = await encryptCookies(cookies, cfg.cookieKey); } catch {}
    }
  }
  const mode = payload.mode || "video";
  let urlsJson = "";
  let repUrl = payload.url;
  if (mode === "list") {
    const list = (payload.urls || []).filter(Boolean);
    if (!list.length) return { ok: false, error: "רשימת קישורים ריקה" };
    urlsJson = JSON.stringify(list);
    repUrl = list[0];
  }

  const targetEmail = payload.sendEmail ? (payload.emailTo || cfg.emailTo || "AUTO_SECRET") : "";
  const extOptions = JSON.stringify({
    sb: Boolean(payload.sponsorblock),
    geo: payload.geoCountry || "IL",
    chapters: Boolean(payload.splitChapters),
    norm: Boolean(payload.normalizeAudio),
    speed: payload.speedFactor || "1",
    send_email: Boolean(payload.sendEmail),
    email: targetEmail
  });

  const effectiveQuality = (payload.subtitles === "only" || payload.quality === "subs_only") ? "subs_only" : (payload.quality || "best");
  const effectiveSubs = effectiveQuality === "subs_only" ? "only" : (payload.subtitles || "none");

  jobs.set(requestId, {
    id: requestId, requestId, url: repUrl, urls: payload.urls || [], title: payload.title || repUrl,
    thumbnail: payload.thumbnail || "", quality: effectiveQuality, actualQuality: "", mode,
    clipStart: payload.clipStart || "", clipEnd: payload.clipEnd || "", subtitles: effectiveSubs,
    sponsorblock: payload.sponsorblock ? "true" : "false",
    splitChapters: Boolean(payload.splitChapters),
    normalizeAudio: Boolean(payload.normalizeAudio),
    speedFactor: payload.speedFactor || "1",
    sendEmail: Boolean(payload.sendEmail),
    emailTo: targetEmail,
    geoCountry: payload.geoCountry || "IL",
    localDlPct: null,
    tempPath: "/tmp/stage -> /tmp/out (Cloud Runner Initializing)",
    finalDiskPath: "",
    status: "preparing", detail: "שולח פקודה ל-GitHub Actions...", percent: 5,
    startedAt: Date.now(), dispatchedAt: Date.now(), files: []
  });
  await persistJobs();

  if (payload.title && !payload.title.startsWith("http")) {
    await addHistoryEntry({ url: repUrl, title: payload.title, quality: effectiveQuality });
  }

  const url = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/workflows/" + encodeURIComponent(cfg.workflow) + "/dispatches";
  const res = await ghFetch(url, cfg, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: cfg.ref,
      inputs: {
        request_id: requestId,
        url: repUrl,
        quality: effectiveQuality,
        mode,
        urls: urlsJson,
        clip_start: payload.clipStart || "",
        clip_end: payload.clipEnd || "",
        subtitles: effectiveSubs,
        sponsorblock: extOptions,
        cookies_enc: cookiesEnc
      }
    })
  });
  if (res.status !== 204) {
    patchJob(requestId, { status: "failed", detail: "HTTP " + res.status, error: "HTTP " + res.status });
    return { ok: false, error: "שגיאה מ-GitHub (HTTP " + res.status + ")" };
  }
  void driveJob(requestId);
  return { ok: true, jobId: requestId };
}

async function setRecsState(state) {
  await chrome.storage.local.set({ [RECS_KEY]: state });
  chrome.runtime.sendMessage({ type: "RECS_CHANGED", state }).catch(() => {});
}

async function fetchJsonAssetWithRetry(asset, cfg) {
  if (asset.blobShas && asset.blobShas.length) {
    try {
      const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/git/blobs/" + asset.blobShas[0], cfg);
      if (res.ok) {
        const d = await res.json();
        if (d && d.content) {
          const text = new TextDecoder("utf-8").decode(b64ToBytes(d.content));
          return JSON.parse(text);
        }
      }
    } catch {}
  }

  const candidates = [
    asset.url ? { url: asset.url, headers: {} } : null,
    asset.apiUrl ? {
      url: asset.apiUrl,
      headers: cfg.token ? { Authorization: "Bearer " + cfg.token, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } : { Accept: "application/octet-stream" }
    } : null,
    asset.url && cfg.token ? { url: asset.url, headers: { Authorization: "Bearer " + cfg.token } } : null
  ].filter((c) => Boolean(c && c.url));

  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const cand of candidates) {
      try {
        const res = await fetch(cand.url, { headers: cand.headers, redirect: "follow", credentials: "omit", cache: "no-store" });
        if (res.ok) return await res.json();
      } catch {}
    }
    if (attempt < 4) await sleep(1500 * attempt);
  }
  return null;
}

async function driveRecommendations(requestId, query, minViews) {
  const cfg = await getConfig();
  const tag = "rec-" + requestId;
  if (chrome.alarms) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  try {
    await setRecsState({ status: "running", query, minViews, detail: "מאתר ריצת חיפוש רב-לשוני וסינון AI ב-GitHub Actions...", items: [] });
    const runId = await findRunByTitle(cfg, tag, null);
    await setRecsState({ status: "running", query, minViews, detail: "סורק תוצאות מכל הזמנים ומסנן עם AI בענן...", items: [] });
    const conclusion = await waitForRun(cfg, runId, requestId, null, null);
    if (conclusion !== "success") throw new Error("החיפוש הסתיים עם סטטוס: " + conclusion);

    await setRecsState({ status: "fetching", query, minViews, detail: "מושך תוצאות מסוננות מ-GitHub...", items: [] });
    let data = null;
    for (let a = 0; a < 8 && !data; a++) {
      const assets = await findReleaseAssetsByTag(cfg, tag).catch(() => null);
      if (assets && assets.length) {
        data = await fetchJsonAssetWithRetry(assets[0], cfg);
        if (data) break;
      }
      await sleep(2000);
    }
    await deleteReleaseAndTagByName(cfg, tag);
    if (!data || !Array.isArray(data.items)) throw new Error("לא התקבלו תוצאות מהענן");
    const trLabel = data.en_query ? (" (כולל תרגום: " + data.en_query + ")") : "";
    await setRecsState({
      status: "completed",
      query,
      minViews,
      detail: "נמצאו ואושרו ע\"י ה-AI " + data.items.length + " תוצאות נקיות בנושא \"" + query + "\"" + trLabel,
      items: data.items,
      updatedAt: Date.now()
    });
  } catch (err) {
    await setRecsState({ status: "failed", query, minViews, detail: err.message, error: err.message, items: [] });
  } finally {
    updateActionBadge();
  }
}

async function startRecommendations(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    return { ok: false, error: "חסרות הגדרות מאגר (owner/repo/token)" };
  }
  const query = String(payload.query || "").trim();
  if (!query) return { ok: false, error: "נא להזין או לבחור נושא לחיפוש" };
  const minViews = String(payload.minViews || "100000").trim();
  const filterPrompt = String(payload.filterPrompt || "").trim();
  const hist = await getHistory();
  const excludeIds = hist.map((h) => h.videoId).filter(Boolean).slice(0, 40).join(",");
  const requestId = crypto.randomUUID();

  const url = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/workflows/recommend.yml/dispatches";
  const res = await ghFetch(url, cfg, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: cfg.ref,
      inputs: {
        request_id: requestId,
        query,
        min_views: minViews,
        exclude_ids: excludeIds,
        filter_prompt: filterPrompt
      }
    })
  });
  if (res.status !== 204) {
    return { ok: false, error: "שגיאה מ-GitHub (HTTP " + res.status + ")" };
  }
  void driveRecommendations(requestId, query, minViews);
  return { ok: true, requestId };
}

async function runCloudCleanup() {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) return { ok: false, error: "חסרות הגדרות מאגר" };
  const url = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/workflows/cleanup.yml/dispatches";
  const res = await ghFetch(url, cfg, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: cfg.ref, inputs: {} })
  });
  return res.status === 204 ? { ok: true } : { ok: false, error: "HTTP " + res.status };
}

async function handle(msg) {
  await restoreJobs();
  switch (msg.type) {
    case "OFFSCREEN_PROGRESS": {
      if (msg.jobId && jobs.has(msg.jobId)) {
        const patch = {};
        if (typeof msg.localDlPct === "number") patch.localDlPct = msg.localDlPct;
        if (typeof msg.overallPct === "number") patch.percent = msg.overallPct;
        if (msg.detail) patch.detail = msg.detail;
        if (msg.tempPath) patch.tempPath = msg.tempPath;
        patchJob(msg.jobId, patch);
      }
      return { ok: true };
    }
    case "GET_PREFS": {
      const cfg = await getConfig();
      return { configured: Boolean(cfg.owner && cfg.repo && cfg.token), owner: cfg.owner, repo: cfg.repo, emailTo: cfg.emailTo || "" };
    }
    case "GET_CONFIG": return getConfig();
    case "SET_CONFIG": return setConfig(msg.patch);
    case "RESET_CONFIG": await chrome.storage.local.remove(CFG_KEY); return getConfig();
    case "TEST_CONNECTION": {
      const cfg = await getConfig();
      const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/workflows/" + encodeURIComponent(cfg.workflow), cfg);
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      return { ok: true, detail: cfg.owner + "/" + cfg.repo };
    }
    case "START_DOWNLOAD": return startDownload(msg.payload);
    case "START_RECOMMEND": return startRecommendations(msg.payload || {});
    case "GET_RECOMMENDATIONS": {
      const state = (await chrome.storage.local.get(RECS_KEY))[RECS_KEY] || { status: "idle", items: [] };
      const history = await getHistory();
      return { ok: true, state, history };
    }
    case "CLEAR_HISTORY": {
      await chrome.storage.local.remove(HIST_KEY);
      return { ok: true };
    }
    case "RETRY_JOB": {
      const old = jobs.get(msg.jobId);
      if (!old) return { ok: false, error: "המשימה לא נמצאה" };
      jobs.delete(msg.jobId);
      await persistJobs();
      return startDownload({
        url: old.url, urls: old.urls, title: old.title, thumbnail: old.thumbnail, quality: old.quality, mode: old.mode,
        clipStart: old.clipStart, clipEnd: old.clipEnd, subtitles: old.subtitles, sponsorblock: old.sponsorblock === "true",
        splitChapters: Boolean(old.splitChapters), normalizeAudio: Boolean(old.normalizeAudio),
        speedFactor: old.speedFactor || "1", sendEmail: Boolean(old.sendEmail), emailTo: old.emailTo === "AUTO_SECRET" ? "" : (old.emailTo || ""), geoCountry: old.geoCountry || "IL"
      });
    }
    case "RUN_CLEANUP": return runCloudCleanup();
    case "CLEAR_COMPLETED_JOBS": {
      for (const [id, job] of jobs) if (TERMINAL.has(job.status)) jobs.delete(id);
      await persistJobs();
      return { ok: true };
    }
    case "LIST_JOBS": {
      const plain = {};
      for (const [id, job] of jobs) { plain[id] = job; if (!TERMINAL.has(job.status)) void driveJob(id); }
      return { ok: true, jobs: plain };
    }
    case "CANCEL_JOB": patchJob(msg.jobId, { status: "cancelled", detail: "בוטל על ידי המשתמש" }); return { ok: true };
    case "OPEN_RUN": {
      const job = jobs.get(msg.jobId);
      const cfg = await getConfig();
      const url = job && job.runId ? "https://github.com/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + job.runId : "https://github.com/" + cfg.owner + "/" + cfg.repo + "/actions";
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case "TRIGGER_SELF_UPDATE": {
      const cfg = await getConfig();
      try {
        const res = await chrome.runtime.sendNativeMessage(UPDATE_HOST, { updateOwner: cfg.updateOwner || cfg.owner, updateRepo: cfg.updateRepo || cfg.repo });
        return res && res.ok ? { ok: true } : { ok: false, error: (res && res.error) || "נכשל בעדכון" };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case "OPEN_DOWNLOADS": chrome.downloads.showDefaultFolder(); return { ok: true };
    case "OPEN_OPTIONS": await chrome.runtime.openOptionsPage(); return { ok: true };
    default: return { ok: false, error: "Unknown command" };
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.target === "offscreen") return undefined;
  handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("panel.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url });
});
