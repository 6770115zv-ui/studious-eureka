"use strict";
const YTPROXY_PRESETS = [
  { id: "video_best", quality: "best", label: "האיכות הטובה ביותר (Auto Best MP4)" },
  { id: "video_2160", quality: "2160", label: "וידאו 4K Ultra HD (2160p)" },
  { id: "video_1440", quality: "1440", label: "וידאו 2K QHD (1440p)" },
  { id: "video_1080", quality: "1080", label: "וידאו Full HD (1080p)" },
  { id: "video_720", quality: "720", label: "וידאו HD (720p)" },
  { id: "video_480", quality: "480", label: "וידאו חסכוני (480p)" },
  { id: "video_360", quality: "360", label: "וידאו מהיר (360p)" },
  { id: "subs_only", quality: "subs_only", label: "📝 כתוביות בלבד - קובץ SRT (עברית, או אנגלית אם אין)" },
  { id: "audio_only", quality: "audio", label: "אודיו בלבד - MP3 320kbps (עם עטיפה)" },
  { id: "audio_m4a", quality: "audio_m4a", label: "אודיו בלבד - M4A (AAC)" },
  { id: "audio_opus", quality: "audio_opus", label: "אודיו איכותי - OPUS" },
  { id: "audio_flac", quality: "audio_flac", label: "אודיו Lossless - FLAC (איכות אולפן)" },
  { id: "audio_wav", quality: "audio_wav", label: "אודיו לא דחוס - WAV" }
];
const YTPROXY_PRESETS_BY_ID = Object.fromEntries(YTPROXY_PRESETS.map((p) => [p.id, p]));

const NETFREE_SAFE_THUMB_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#1e293b"/></linearGradient></defs>' +
  '<rect width="320" height="180" rx="12" fill="url(#g)"/>' +
  '<circle cx="160" cy="90" r="28" fill="rgba(56,189,248,0.18)" stroke="#38bdf8" stroke-width="2"/>' +
  '<polygon points="153,77 153,103 175,90" fill="#38bdf8"/>' +
  '</svg>'
);

function formatBytes(n) {
  if (!n || n < 0) return "";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map((v) => String(v).padStart(2, "0")).join(":");
}

function extractYoutubeId(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const mBr = s.match(/\[([a-zA-Z0-9_-]{11})\]/);
  if (mBr) return mBr[1];
  const m = s.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/|vi\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchYoutubeOembed(url) {
  const vid = extractYoutubeId(url);
  if (!vid) return null;
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", hl: "he", gl: "IL" } },
        videoId: vid
      })
    });
    if (res.ok) {
      const data = await res.json();
      const vd = data.videoDetails || {};
      if (vd.title) {
        return {
          title: vd.title,
          author: vd.author || "",
          thumbnail: "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg"
        };
      }
    }
  } catch {}
  return null;
}

if (typeof self !== "undefined") {
  self.YTPROXY_PRESETS = YTPROXY_PRESETS;
  self.YTPROXY_PRESETS_BY_ID = YTPROXY_PRESETS_BY_ID;
  self.NETFREE_SAFE_THUMB_SVG = NETFREE_SAFE_THUMB_SVG;
  self.formatBytes = formatBytes;
  self.formatClock = formatClock;
  self.extractYoutubeId = extractYoutubeId;
  self.fetchYoutubeOembed = fetchYoutubeOembed;
}