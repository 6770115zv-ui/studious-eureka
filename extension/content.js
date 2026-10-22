"use strict";
(() => {
  function inject() {
    if (location.pathname !== "/watch") return;
    if (document.querySelector(".ytproxy-bar")) return;
    const bar = document.querySelector("ytd-watch-metadata #top-level-buttons-computed") || document.querySelector("#top-level-buttons-computed");
    if (!bar) return;

    const wrap = document.createElement("div");
    wrap.className = "ytproxy-bar";

    const sel = document.createElement("select");
    sel.className = "ytproxy-select";
    for (const p of (self.YTPROXY_PRESETS || [{ quality: "best", label: "Best" }])) {
      const opt = document.createElement("option");
      opt.value = p.quality;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }

    const btn = document.createElement("button");
    btn.className = "ytproxy-btn";
    btn.textContent = "⬇ הורד בענן";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "שולח ל-GitHub...";
      const res = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        payload: {
          url: location.href,
          title: document.title.replace(/ - YouTube/gi, "").trim(),
          quality: sel.value,
          mode: "video",
          geoCountry: "IL"
        }
      }).catch(() => null);
      btn.textContent = res && res.ok ? "✓ נשלח להורדה!" : "✕ שגיאה";
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "⬇ הורד בענן";
      }, 2800);
    };

    const clipBtn = document.createElement("button");
    clipBtn.className = "ytproxy-btn";
    clipBtn.style.background = "rgba(56, 189, 248, 0.25)";
    clipBtn.title = "הורד החל מנקודת הזמן הנוכחית בנגן";
    clipBtn.textContent = "✂ מכאן";
    clipBtn.onclick = async () => {
      const vidEl = document.querySelector("video");
      const startSec = vidEl ? vidEl.currentTime : 0;
      const startStr = self.formatClock ? self.formatClock(startSec) : "00:00:00";
      clipBtn.disabled = true;
      clipBtn.textContent = "שולח מ-" + startStr + "...";
      const res = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        payload: {
          url: location.href,
          title: document.title.replace(/ - YouTube/gi, "").trim(),
          quality: sel.value,
          clipStart: startStr,
          mode: "video",
          geoCountry: "IL"
        }
      }).catch(() => null);
      clipBtn.textContent = res && res.ok ? ("✓ מ-" + startStr) : "✕ שגיאה";
      setTimeout(() => {
        clipBtn.disabled = false;
        clipBtn.textContent = "✂ מכאן";
      }, 2800);
    };

    wrap.append(sel, btn, clipBtn);
    bar.appendChild(wrap);
  }
  setInterval(inject, 2000);
})();