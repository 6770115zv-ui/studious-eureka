"use strict";
const YTPROXY_PRESETS = [
  { id: "video_best", quality: "best", label: "האיכות הטובה ביותר (Auto Best MP4)" },
  { id: "video_2160", quality: "2160", label: "וידאו 4K Ultra HD (2160p)" },
  { id: "video_1440", quality: "1440", label: "וידאו 2K QHD (1440p)" },
  { id: "video_1080", quality: "1080", label: "וידאו Full HD (1080p)" },
  { id: "video_720", quality: "720", label: "וידאו HD (720p)" },
  { id: "video_480", quality: "480", label: "וידאו חסכוני (480p)" },
  { id: "video_360", quality: "360", label: "וידאו מהיר (360p)" },
  { id: "audio_only", quality: "audio", label: "אודיו בלבד - MP3 320kbps (עם עטיפה)" },
  { id: "audio_m4a", quality: "audio_m4a", label: "אודיו בלבד - M4A (AAC)" },
  { id: "audio_opus", quality: "audio_opus", label: "אודיו איכותי - OPUS" },
  { id: "audio_flac", quality: "audio_flac", label: "אודיו Lossless - FLAC (איכות אולפן)" },
  { id: "audio_wav", quality: "audio_wav", label: "אודיו לא דחוס - WAV" }
];
const YTPROXY_PRESETS_BY_ID = Object.fromEntries(YTPROXY_PRESETS.map((p) => [p.id, p]));

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
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchYoutubeOembed(url) {
  try {
    const res = await fetch("https://noembed.com/embed?url=" + encodeURIComponent(url));
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.title) {
      return {
        title: data.title,
        author: data.author_name || "",
        thumbnail: data.thumbnail_url || ""
      };
    }
  } catch {}
  return null;
}

if (typeof self !== "undefined") {
  self.YTPROXY_PRESETS = YTPROXY_PRESETS;
  self.YTPROXY_PRESETS_BY_ID = YTPROXY_PRESETS_BY_ID;
  self.formatBytes = formatBytes;
  self.formatClock = formatClock;
  self.extractYoutubeId = extractYoutubeId;
  self.fetchYoutubeOembed = fetchYoutubeOembed;
}