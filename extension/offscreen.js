"use strict";
(() => {
  const ZIP_CACHE_NAME = "ytcloud-assets-v5";
  const MIME = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg",
    m4a: "audio/mp4", flac: "audio/flac", wav: "audio/wav", opus: "audio/opus", srt: "text/plain", zip: "application/zip"
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function readFromCache(cacheKey) {
    if (!cacheKey || typeof caches === "undefined") return null;
    try {
      const cache = await caches.open(ZIP_CACHE_NAME);
      const res = await cache.match(cacheKey);
      if (!res) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      await cache.delete(cacheKey).catch(() => {});
      return buf.length ? buf : null;
    } catch { return null; }
  }

  async function fetchWithRetry(apiUrl, token, fallbackUrl) {
    const isArtifactUrl = apiUrl && apiUrl.includes("/actions/artifacts/");
    const candidates = [
      fallbackUrl ? { url: fallbackUrl, headers: {} } : null,
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
      fallbackUrl && token ? { url: fallbackUrl, headers: { Authorization: "Bearer " + token } } : null
    ].filter((c) => Boolean(c && c.url));

    let lastErr = "Failed to fetch";
    for (let attempt = 1; attempt <= 4; attempt++) {
      for (const cand of candidates) {
        try {
          const res = await fetch(cand.url, { headers: cand.headers, redirect: "follow", credentials: "omit", cache: "no-store" });
          if (res.ok) {
            const buf = new Uint8Array(await res.arrayBuffer());
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
      let buf = await readFromCache(msg.cacheKey);
      if (!buf) buf = await fetchWithRetry(msg.url, msg.token, msg.fallbackUrl);
      const isPkZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
      if (msg.rawZip || !isPkZip) {
        const fname = msg.zipName || "download.mp4";
        const ext = (fname.toLowerCase().split(".").pop() || "mp4");
        const blob = new Blob([buf], { type: MIME[ext] || "application/octet-stream" });
        return { ok: true, files: [{ name: fname, size: buf.length, blobUrl: URL.createObjectURL(blob) }] };
      }
      const entries = fflate.unzipAsync ? await fflate.unzipAsync(buf) : fflate.unzipSync(buf);
      const files = [];
      for (const name of Object.keys(entries)) {
        const data = entries[name];
        delete entries[name];
        if (!data || !data.length || name.endsWith("/")) continue;
        const cleanName = name.split("/").pop() || name;
        const ext = (cleanName.toLowerCase().split(".").pop() || "");
        const blob = new Blob([data], { type: MIME[ext] || "application/octet-stream" });
        files.push({ name: cleanName, size: data.length, blobUrl: URL.createObjectURL(blob) });
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
