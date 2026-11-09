"use strict";
(() => {
  const ZIP_CACHE_NAME = "ytcloud-assets-v5";
  const MIME = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg",
    m4a: "audio/mp4", flac: "audio/flac", wav: "audio/wav", opus: "audio/opus", srt: "text/plain;charset=utf-8", zip: "application/zip"
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function sendProgress(jobId, localDlPct, overallPct, detail, tempPath) {
    if (!jobId) return;
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_PROGRESS",
      jobId,
      localDlPct,
      overallPct,
      detail,
      tempPath
    }).catch(() => {});
  }

  async function readFromCache(cacheKey, jobId) {
    if (!cacheKey || typeof caches === "undefined") return null;
    try {
      const cache = await caches.open(ZIP_CACHE_NAME);
      const res = await cache.match(cacheKey);
      if (!res) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      await cache.delete(cacheKey).catch(() => {});
      if (buf.length) {
        sendProgress(
          jobId,
          100,
          90,
          "נטען מזיכרון המטמון המקומי (" + fmtMB(buf.length) + ")...",
          cacheKey + " -> Offscreen Memory Buffer"
        );
      }
      return buf.length ? buf : null;
    } catch { return null; }
  }

  async function fetchStreamWithProgress(res, expectedSize, jobId, sourceLabel) {
    const contentLen = Number(res.headers.get("content-length") || 0) || Number(expectedSize || 0);
    if (!res.body || !res.body.getReader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      sendProgress(jobId, 100, 90, "הורדה למחשב הושלמה (" + fmtMB(buf.length) + ")", sourceLabel);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let lastReport = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        chunks.push(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastReport >= 350) {
          lastReport = now;
          const pct = contentLen > 0 ? Math.min(99, Math.round((received / contentLen) * 100)) : 50;
          const overall = 75 + Math.round((pct / 100) * 15);
          const sizeText = contentLen > 0 ? (fmtMB(received) + " / " + fmtMB(contentLen)) : fmtMB(received);
          sendProgress(
            jobId,
            pct,
            overall,
            "מוריד מהענן למחשב: " + pct + "% (" + sizeText + ")...",
            "Offscreen Stream Buffer <- " + sourceLabel + " (" + sizeText + ")"
          );
        }
      }
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    sendProgress(
      jobId,
      100,
      90,
      "הורדה למחשב הושלמה: 100% (" + fmtMB(received) + ")",
      "Offscreen Memory Buffer (" + fmtMB(received) + ")"
    );
    return out;
  }

  async function fetchWithRetry(apiUrl, token, fallbackUrl, expectedSize, jobId) {
    const isArtifactUrl = apiUrl && apiUrl.includes("/actions/artifacts/");
    const candidates = [
      apiUrl ? {
        url: apiUrl,
        headers: token
          ? {
              Authorization: "Bearer " + token,
              Accept: isArtifactUrl ? "application/vnd.github+json" : "application/octet-stream",
              "X-GitHub-Api-Version": "2022-11-28"
            }
          : { Accept: "application/octet-stream" }
      } : null,
      fallbackUrl ? { url: fallbackUrl, headers: {} } : null,
      fallbackUrl && token ? { url: fallbackUrl, headers: { Authorization: "Bearer " + token } } : null
    ].filter((c) => Boolean(c && c.url));

    let lastErr = "Failed to fetch";
    for (let attempt = 1; attempt <= 4; attempt++) {
      for (const cand of candidates) {
        try {
          const res = await fetch(cand.url, { headers: cand.headers, redirect: "follow", credentials: "omit", cache: "no-store" });
          if (res.ok) {
            const buf = await fetchStreamWithProgress(res, expectedSize, jobId, cand.url.split("?")[0]);
            if (buf.length > 0) return buf;
          } else { lastErr = "HTTP " + res.status; }
        } catch (e) { lastErr = e.message || "Failed to fetch"; }
      }
      if (attempt < 4) await sleep(1500 * attempt);
    }
    throw new Error(lastErr);
  }

  async function unzipArtifact(msg) {
    try {
      let buf = await readFromCache(msg.cacheKey, msg.jobId);
      if (!buf) buf = await fetchWithRetry(msg.url, msg.token, msg.fallbackUrl, msg.expectedSize, msg.jobId);
      const isPkZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
      if (msg.rawZip || !isPkZip) {
        const fname = msg.zipName || "download.mp4";
        const ext = (fname.toLowerCase().split(".").pop() || "mp4");
        const blob = new Blob([buf], { type: MIME[ext] || "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob);
        const size = buf.length;
        buf = null;
        sendProgress(msg.jobId, 100, 93, "בונה קובץ מדיה לשמירה...", blobUrl + " (" + fname + ")");
        return { ok: true, files: [{ name: fname, size, blobUrl }] };
      }

      sendProgress(msg.jobId, 100, 91, "פורס ארכיון ובונה קובץ מדיה בזיכרון...", "fflate.unzipAsync -> Offscreen Blob Builder");
      const entries = fflate.unzipAsync ? await fflate.unzipAsync(buf) : fflate.unzipSync(buf);
      buf = null;
      const files = [];
      for (const name of Object.keys(entries)) {
        const data = entries[name];
        delete entries[name];
        if (!data || !data.length || name.endsWith("/")) continue;
        const cleanName = name.split("/").pop() || name;
        const ext = (cleanName.toLowerCase().split(".").pop() || "");
        const blob = new Blob([data], { type: MIME[ext] || "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob);
        files.push({ name: cleanName, size: data.length, blobUrl });
      }
      if (files.length) {
        sendProgress(msg.jobId, 100, 93, "קובץ המדיה נבנה בהצלחה! מעביר לשמירה בדיסק...", files[0].blobUrl + " -> Downloads/" + files[0].name);
      }
      return files.length ? { ok: true, files } : { ok: false, error: "ארכיון ה-ZIP ריק" };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return undefined;
    if (msg.type === "UNZIP_ARTIFACT") { unzipArtifact(msg).then(sendResponse); return true; }
    if (msg.type === "REVOKE") { try { URL.revokeObjectURL(msg.blobUrl); } catch {} sendResponse({ ok: true }); return true; }
  });
})();
