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

  function readU16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function readU32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0; }
  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
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
      const blob = await res.blob();
      await cache.delete(cacheKey).catch(() => {});
      if (blob.size) {
        sendProgress(jobId, 100, 90, "נטען מזיכרון המטמון המקומי (" + fmtMB(blob.size) + ")...", cacheKey);
        return blob;
      }
      return null;
    } catch { return null; }
  }

  async function fetchStreamAsBlob(res, expectedSize, jobId, sourceLabel) {
    const contentLen = Number(res.headers.get("content-length") || 0) || Number(expectedSize || 0);
    if (!res.body || !res.body.getReader) {
      const blob = await res.blob();
      sendProgress(jobId, 100, 90, "הורדה למחשב הושלמה (" + fmtMB(blob.size) + ")", sourceLabel);
      return blob;
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

    // איחוד ל-Blob וירטואלי ללא הקצאת Uint8Array בזיכרון ה-RAM!
    const finalBlob = new Blob(chunks);
    chunks.length = 0;
    sendProgress(
      jobId,
      100,
      90,
      "הורדה למחשב הושלמה: 100% (" + fmtMB(received) + ")",
      "Offscreen Blob Storage (" + fmtMB(received) + ")"
    );
    return finalBlob;
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
            const blob = await fetchStreamAsBlob(res, expectedSize, jobId, cand.url.split("?")[0]);
            if (blob.size > 0) return blob;
          } else { lastErr = "HTTP " + res.status; }
        } catch (e) { lastErr = e.message || "Failed to fetch"; }
      }
      if (attempt < 4) await sleep(1500 * attempt);
    }
    throw new Error(lastErr);
  }

  // חילוץ Zero-Copy מתוך ה-Blob של ה-ZIP: קורא רק את 128KB האחרונים של ה-ZIP וחותך את ה-MP4 ישירות עם blob.slice() ב-0MB RAM!
  async function zeroCopyUnzipBlob(zipBlob, jobId) {
    const tailSize = Math.min(zipBlob.size, 131072);
    const tailOffset = zipBlob.size - tailSize;
    const tailBuf = new Uint8Array(await zipBlob.slice(tailOffset, zipBlob.size).arrayBuffer());

    let eocd = -1;
    for (let i = tailBuf.length - 22; i >= 0; i--) {
      if (readU32(tailBuf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Invalid ZIP Central Directory");

    const totalEntries = readU16(tailBuf, eocd + 8);
    const cdSize = readU32(tailBuf, eocd + 12);
    const cdOffset = readU32(tailBuf, eocd + 16);

    const cdBuf = new Uint8Array(await zipBlob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    let ptr = 0;
    const files = [];

    for (let idx = 0; idx < totalEntries; idx++) {
      if (ptr + 46 > cdBuf.length || readU32(cdBuf, ptr) !== 0x02014b50) break;
      const method = readU16(cdBuf, ptr + 10);
      const compSize = readU32(cdBuf, ptr + 20);
      const nameLen = readU16(cdBuf, ptr + 28);
      const extraLen = readU16(cdBuf, ptr + 30);
      const commentLen = readU16(cdBuf, ptr + 32);
      const lho = readU32(cdBuf, ptr + 42);
      const name = decodeUtf8(cdBuf.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;

      const lhBuf = new Uint8Array(await zipBlob.slice(lho, lho + 30).arrayBuffer());
      const lhNameLen = readU16(lhBuf, 26);
      const lhExtraLen = readU16(lhBuf, 28);
      const dataStart = lho + 30 + lhNameLen + lhExtraLen;

      const cleanName = name.split("/").pop() || name;
      const ext = (cleanName.toLowerCase().split(".").pop() || "");
      const mimeType = MIME[ext] || "application/octet-stream";

      let fileBlob;
      if (method === 0) {
        // ZIP_STORED: חיתוך מיידי ב-0 מילי-שניות וללא שום הקצאת זיכרון!
        fileBlob = zipBlob.slice(dataStart, dataStart + compSize, mimeType);
      } else if (method === 8) {
        const compSlice = zipBlob.slice(dataStart, dataStart + compSize);
        const decompStream = compSlice.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        const rawDecomp = await new Response(decompStream).blob();
        fileBlob = new Blob([rawDecomp], { type: mimeType });
      } else {
        fileBlob = zipBlob.slice(dataStart, dataStart + compSize, mimeType);
      }

      if (fileBlob.size > 0) {
        const blobUrl = URL.createObjectURL(fileBlob);
        files.push({ name: cleanName, size: fileBlob.size, blobUrl });
      }
    }

    if (files.length) {
      sendProgress(jobId, 100, 93, "קובץ המדיה חולץ ב-Zero-Copy! מעביר לשמירה בדיסק...", files[0].blobUrl + " -> Downloads/" + files[0].name);
    }
    return files;
  }

  async function unzipArtifact(msg) {
    try {
      let dataBlob = await readFromCache(msg.cacheKey, msg.jobId);
      if (!dataBlob) dataBlob = await fetchWithRetry(msg.url, msg.token, msg.fallbackUrl, msg.expectedSize, msg.jobId);

      const headBuf = new Uint8Array(await dataBlob.slice(0, 4).arrayBuffer());
      const isPkZip = headBuf.length === 4 && headBuf[0] === 0x50 && headBuf[1] === 0x4b && headBuf[2] === 0x03 && headBuf[3] === 0x04;

      if (msg.rawZip || !isPkZip) {
        const fname = msg.zipName || "download.mp4";
        const ext = (fname.toLowerCase().split(".").pop() || "mp4");
        const typedBlob = dataBlob.slice(0, dataBlob.size, MIME[ext] || "application/octet-stream");
        const blobUrl = URL.createObjectURL(typedBlob);
        return { ok: true, files: [{ name: fname, size: typedBlob.size, blobUrl }] };
      }

      sendProgress(msg.jobId, 100, 91, "מחלץ קובץ מדיה בשיטת Zero-Copy...", "Offscreen Zero-Copy Blob Slice");
      const files = await zeroCopyUnzipBlob(dataBlob, msg.jobId);
      return files.length ? { ok: true, files } : { ok: false, error: "ארכיון ה-ZIP ריק" };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return undefined;
    if (msg.type === "UNZIP_ARTIFACT") { unzipArtifact(msg).then(sendResponse); return true; }
    if (msg.type === "REVOKE") { try { URL.revokeObjectURL(msg.blobUrl); } catch {} sendResponse({ ok: true }); return true; }
  });
})();
