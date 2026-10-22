"use strict";
importScripts("shared/common.js");

const BUILTIN_CONFIG = {
  owner: "ZVGFFTFGGGG", repo: "SFDF", workflow: "download.yml", ref: "main",
  token: "", cookieKey: "", autoCleanRelease: "true", updateOwner: "ZVGFFTFGGGG", updateRepo: "SFDF"
};
try { importScripts("config.js"); } catch {}

const DEFAULTS = { ...BUILTIN_CONFIG, ...(self.DEFAULT_CONFIG || {}) };
const API = "https://api.github.com";
const CFG_KEY = "ytproxy_cfg";
const JOBS_KEY = "ytproxy_jobs";
const HIST_KEY = "ytproxy_history";
const RECS_KEY = "ytproxy_recs";
const UPDATE_HOST = "com.rafi.ytproxy.updater";
const ZIP_CACHE_NAME = "ytcloud-assets-v3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
const driving = new Set();
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function getConfig() {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const cfg = { ...DEFAULTS, ...stored };
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
  } else {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
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
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: "Bearer " + cfg.token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.headers || {})
        }
      });
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
  if (raw.length !== 32) throw new Error("COOKIE_KEY חייב להיות 64 תווי hex");
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
  Object.assign(job, patch);
  void persistJobs();
  return job;
}

async function findRunByTitle(cfg, targetTitle, signal, dispatchedAt) {
  const url = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs?event=workflow_dispatch&per_page=30";
  const since = (dispatchedAt || Date.now()) - 20000;
  for (let i = 0; i < 120; i++) {
    if (signal && signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(url, cfg);
    if (res.ok) {
      const runs = ((await res.json()).workflow_runs) || [];
      const exact = runs.find((r) => r.display_title === targetTitle || r.name === targetTitle);
      if (exact) return exact.id;
      const taken = new Set(Array.from(jobs.values()).map((j) => j.runId).filter(Boolean));
      const cands = runs.filter((r) => !taken.has(r.id) && r.status !== "completed" && new Date(r.created_at).getTime() >= since);
      if (cands.length === 1) return cands[0].id;
    }
    await sleep(2000);
  }
  throw new Error("לא נמצאה ריצה ב-GitHub");
}

async function fetchLiveStepInfo(cfg, runId) {
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
        "Set up Deno": "מכין סביבת ריצה בענן (Deno)...",
        "Install yt-dlp + ffmpeg + curl_cffi + atomicparsley": "מתקין כלי הורדה וקידוד (yt-dlp + FFmpeg)...",
        "Execute Smart Fallback Engine v4 and Publish": "מוריד, מעבד ואורז מדיה בענן (Smart Engine v4)...",
        "Upload Backup Artifact": "שומר גיבוי תוצר ב-GitHub..."
      };
      return {
        label: nameMap[active.name] || ("מבצע שלב: " + active.name),
        pct: Math.min(70, 22 + Math.round((completedCount / totalCount) * 48))
      };
    }
  } catch {}
  return null;
}

async function waitForRun(cfg, runId, onTick, signal) {
  for (let i = 0; i < 600; i++) {
    if (signal && signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + runId, cfg);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const run = await res.json();
    if (run.status === "completed") return run.conclusion;
    let stepInfo = null;
    if (run.status === "in_progress" && i % 2 === 0) {
      stepInfo = await fetchLiveStepInfo(cfg, runId);
    }
    if (onTick) onTick(run, i, stepInfo);
    await sleep(3800);
  }
  throw new Error("זמן ההמתנה הסתיים");
}

async function findReleaseAssetsByTag(cfg, tag) {
  const res = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/releases/tags/" + tag, cfg);
  if (!res.ok) return null;
  const rel = await res.json();
  const assets = (rel.assets || []).filter((a) => a.url || a.browser_download_url).map((a) => ({
    id: a.id, name: a.name, apiUrl: a.url, url: a.browser_download_url, releaseId: rel.id, tagName: rel.tag_name
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

async function fetchAssetToCache(apiUrl, fallbackUrl, token, jobId) {
  const cacheKey = "https://ytcloud.local/asset-" + jobId + "-" + Date.now() + ".zip";
  const candidates = [
    {
      url: apiUrl,
      headers: token ? { Authorization: "Bearer " + token, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } : { Accept: "application/octet-stream" }
    },
    { url: fallbackUrl, headers: token ? { Authorization: "Bearer " + token } : {} },
    { url: fallbackUrl, headers: {} }
  ].filter((c) => Boolean(c.url));

  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const cand of candidates) {
      try {
        const res = await fetch(cand.url, { headers: cand.headers, redirect: "follow", credentials: "omit", cache: "no-store" });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf && buf.byteLength > 0) {
            const cache = await caches.open(ZIP_CACHE_NAME);
            await cache.put(cacheKey, new Response(buf, { headers: { "Content-Type": "application/zip" } }));
            return cacheKey;
          }
        }
      } catch {}
    }
    if (attempt < 4) await sleep(2000 * attempt);
  }
  return null;
}

async function unpackZipUrl(assetOrUrl, jobId, token = null, rawZip = false) {
  await ensureOffscreen();
  const apiUrl = typeof assetOrUrl === "string" ? assetOrUrl : (assetOrUrl.apiUrl || assetOrUrl.url);
  const fallbackUrl = typeof assetOrUrl === "string" ? "" : (assetOrUrl.url || "");
  const zipName = (typeof assetOrUrl === "object" && assetOrUrl.name) ? assetOrUrl.name : ("dl-" + jobId + ".zip");
  const cacheKey = await fetchAssetToCache(apiUrl, fallbackUrl, token, jobId);

  let lastErr = "שגיאה במשיכת או פריסת ה-ZIP";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await chrome.runtime.sendMessage({
      target: "offscreen", type: "UNZIP_ARTIFACT", jobId, cacheKey, url: apiUrl, fallbackUrl, token, rawZip, zipName
    }).catch((e) => ({ ok: false, error: e.message }));
    if (res && res.ok && res.files && res.files.length) return res.files;
    lastErr = (res && res.error) || lastErr;
    if (attempt < 4) await sleep(2000 * attempt);
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

function saveBlob(blobUrl, filename) {
  return new Promise((resolve, reject) => {
    pendingNames.set(blobUrl, filename);
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingNames.delete(blobUrl);
        reject(new Error("שגיאה בשמירת הקובץ במחשב"));
        return;
      }
      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          if (blobUrl.startsWith("blob:")) chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
          if (delta.state.current === "complete") resolve(filename);
          else reject(new Error("שמירת הקובץ הופסקה"));
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
    const cfg = await getConfig();
    const tag = "dl-" + job.requestId;
    if (!job.runId) {
      patchJob(jobId, { status: "queued", detail: "מאתר ריצה ב-GitHub Actions...", percent: 12 });
      const runId = await findRunByTitle(cfg, tag, signal, job.dispatchedAt);
      patchJob(jobId, { runId });
    }
    patchJob(jobId, { status: "running", detail: "מתחבר לשרת GitHub Actions...", percent: 24 });
    const conclusion = await waitForRun(cfg, jobs.get(jobId).runId, (run, tickIdx, stepInfo) => {
      const fallbackPct = Math.min(68, 24 + Math.floor(tickIdx * 2));
      patchJob(jobId, {
        detail: stepInfo ? stepInfo.label : (run.status === "queued" ? "ממתין בתור ב-GitHub..." : "מעבד ומוריד מדיה ב-GitHub Actions..."),
        percent: stepInfo ? stepInfo.pct : fallbackPct
      });
    }, signal);

    if (conclusion !== "success") throw new Error("הריצה הסתיימה עם סטטוס: " + conclusion);
    patchJob(jobId, { status: "fetching", detail: "מושך קובץ מ-GitHub API (כולל גיבוי אוטומטי)...", percent: 76 });

    let files = null;
    for (let a = 0; a < 8 && !files; a++) {
      const assets = await findReleaseAssetsByTag(cfg, tag).catch(() => null);
      if (assets && assets.length) {
        const isBundle = job.mode === "collection" || job.mode === "list" || job.splitChapters;
        const inner = [];
        for (const x of assets) {
          const isZip = x.name.toLowerCase().endsWith(".zip");
          const unpacked = await unpackZipUrl(x, jobId, cfg.token, isBundle || !isZip);
          inner.push(...unpacked);
        }
        if (inner.length) { files = inner; break; }
      }
      await sleep(2500);
    }

    if (!files) {
      const artRes = await ghFetch(API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/runs/" + jobs.get(jobId).runId + "/artifacts", cfg);
      const list = ((await artRes.json()).artifacts) || [];
      const found = list.find((x) => x.name === tag);
      if (!found) throw new Error("לא נמצא תוצר להורדה ב-Release או ב-Artifacts");
      const artUrl = API + "/repos/" + cfg.owner + "/" + cfg.repo + "/actions/artifacts/" + found.id + "/zip";
      const isBundle = job.mode === "collection" || job.mode === "list" || job.splitChapters;
      files = await unpackZipUrl({ apiUrl: artUrl, url: artUrl, name: tag + ".zip" }, jobId, cfg.token, isBundle);
    }

    patchJob(jobId, { status: "saving", detail: "שומר קובץ במחשב...", percent: 92 });
    const saved = [];
    for (const f of files) {
      const name = sanitizeFilename(f.name);
      await saveBlob(f.blobUrl || f.url, name);
      saved.push(name);
    }

    await addHistoryEntry({
      url: job.url,
      title: saved[0] || job.title || job.url,
      quality: job.quality
    });

    if (cfg.autoCleanRelease === "true") await deleteReleaseAndTagByName(cfg, tag);
    patchJob(jobId, { status: "completed", detail: "הושלם ונשמר במחשב!", files: saved, percent: 100 });
    notifyUser("הורדה הושלמה בהצלחה", saved[0] || job.title || "הקובץ נשמר בתיקיית ההורדות");
  } catch (err) {
    patchJob(jobId, { status: "failed", detail: err.message, error: err.message });
  } finally {
    driving.delete(jobId);
  }
}

async function startDownload(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token || !cfg.cookieKey) {
    return { ok: false, error: "חסרות הגדרות חיבור (owner/repo/token/cookieKey)" };
  }
  const requestId = crypto.randomUUID();
  let cookiesEnc = "";
  const cookies = await exportYoutubeCookies();
  if (cookies) {
    try { cookiesEnc = await encryptCookies(cookies, cfg.cookieKey); }
    catch (e) { return { ok: false, error: e.message }; }
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

  const extOptions = JSON.stringify({
    sb: Boolean(payload.sponsorblock),
    geo: payload.geoCountry || "IL",
    chapters: Boolean(payload.splitChapters),
    norm: Boolean(payload.normalizeAudio)
  });

  jobs.set(requestId, {
    id: requestId, requestId, url: repUrl, urls: payload.urls || [], title: payload.title || repUrl,
    thumbnail: payload.thumbnail || "", quality: payload.quality || "best", mode,
    clipStart: payload.clipStart || "", clipEnd: payload.clipEnd || "", subtitles: payload.subtitles || "none",
    sponsorblock: payload.sponsorblock ? "true" : "false",
    splitChapters: Boolean(payload.splitChapters),
    normalizeAudio: Boolean(payload.normalizeAudio),
    geoCountry: payload.geoCountry || "IL",
    status: "preparing", detail: "שולח פקודה ל-GitHub Actions...", percent: 5,
    startedAt: Date.now(), dispatchedAt: Date.now(), files: []
  });
  await persistJobs();

  if (payload.title && !payload.title.startsWith("http")) {
    await addHistoryEntry({ url: repUrl, title: payload.title, quality: payload.quality || "best" });
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
        quality: payload.quality || "best",
        mode,
        urls: urlsJson,
        clip_start: payload.clipStart || "",
        clip_end: payload.clipEnd || "",
        subtitles: payload.subtitles || "none",
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
  const candidates = [
    {
      url: asset.apiUrl,
      headers: cfg.token ? { Authorization: "Bearer " + cfg.token, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } : { Accept: "application/octet-stream" }
    },
    { url: asset.url, headers: cfg.token ? { Authorization: "Bearer " + cfg.token } : {} },
    { url: asset.url, headers: {} }
  ].filter((c) => Boolean(c.url));

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

async function driveRecommendations(requestId, query, minViews, dispatchedAt) {
  const cfg = await getConfig();
  const tag = "rec-" + requestId;
  try {
    await setRecsState({ status: "running", query, minViews, detail: "מאתר ריצת חיפוש ב-GitHub Actions...", items: [] });
    const runId = await findRunByTitle(cfg, tag, null, dispatchedAt);
    await setRecsState({ status: "running", query, minViews, detail: "סורק ומסנן תוצאות פופולריות במקביל בענן...", items: [] });
    const conclusion = await waitForRun(cfg, runId, null, null);
    if (conclusion !== "success") throw new Error("החיפוש הסתיים עם סטטוס: " + conclusion);

    await setRecsState({ status: "fetching", query, minViews, detail: "מושך תוצאות מומלצות מ-GitHub...", items: [] });
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
    await setRecsState({
      status: "completed",
      query,
      minViews,
      detail: "נמצאו " + data.items.length + " תוצאות פופולריות בנושא \"" + query + "\"",
      items: data.items,
      updatedAt: Date.now()
    });
  } catch (err) {
    await setRecsState({ status: "failed", query, minViews, detail: err.message, error: err.message, items: [] });
  }
}

async function startRecommendations(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    return { ok: false, error: "חסרות הגדרות מאגר (owner/repo/token)" };
  }
  const query = String(payload.query || "").trim();
  if (!query) return { ok: false, error: "נא להזין או לבחור נושא לחיפוש" };
  const minViews = String(payload.minViews || "500000").trim();
  const hist = await getHistory();
  const excludeIds = hist.map((h) => h.videoId).filter(Boolean).slice(0, 40).join(",");
  const requestId = crypto.randomUUID();
  const dispatchedAt = Date.now();

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
        exclude_ids: excludeIds
      }
    })
  });
  if (res.status !== 204) {
    return { ok: false, error: "שגיאה מ-GitHub (HTTP " + res.status + ") - ודא שהעלית את הקובץ recommend.yml למאגר" };
  }
  void driveRecommendations(requestId, query, minViews, dispatchedAt);
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
    case "GET_PREFS": {
      const cfg = await getConfig();
      return { configured: Boolean(cfg.owner && cfg.repo && cfg.token && cfg.cookieKey), owner: cfg.owner, repo: cfg.repo };
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
        splitChapters: Boolean(old.splitChapters), normalizeAudio: Boolean(old.normalizeAudio), geoCountry: old.geoCountry || "IL"
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