"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  document.body.style.overflowAnchor = "auto";
  const mainWrap = document.querySelector("main.wrap");
  if (mainWrap) mainWrap.style.overflowAnchor = "auto";

  function extract11Id(raw) {
    const s = String(raw || "").trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    const mBr = s.match(/\[([a-zA-Z0-9_-]{11})\]/);
    if (mBr) return mBr[1];
    const mUrl = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([a-zA-Z0-9_-]{11})/);
    return mUrl ? mUrl[1] : "";
  }

  function normalizeYtInputValue(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return "https://www.youtube.com/watch?v=" + s;
    const mBr = s.match(/\[([a-zA-Z0-9_-]{11})\]/);
    if (mBr && !s.startsWith("http")) return "https://www.youtube.com/watch?v=" + mBr[1];
    const parts = s.split(/[\s,]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => /^[a-zA-Z0-9_-]{11}$/.test(p) || /^\[[a-zA-Z0-9_-]{11}\]$/.test(p) || p.startsWith("http"))) {
      return parts.map((p) => {
        const clean = p.replace(/^\[|\]$/g, "");
        return /^[a-zA-Z0-9_-]{11}$/.test(clean) ? "https://www.youtube.com/watch?v=" + clean : p;
      }).join(" ");
    }
    return s;
  }

  if (typeof window !== "undefined") {
    const origExtract = window.extractYoutubeId;
    window.extractYoutubeId = function (u) {
      return extract11Id(u) || (origExtract ? origExtract(u) : "");
    };
  }

  let scrollLock = null;
  function lockCardScroll(cardEl) {
    if (!cardEl || !cardEl.parentElement) return;
    const cards = Array.from(cardEl.parentElement.children);
    scrollLock = { card: cardEl, idx: cards.indexOf(cardEl), boxId: cardEl.parentElement.id, top: cardEl.getBoundingClientRect().top, exp: Date.now() + 2200 };
    const fix = () => {
      if (!scrollLock || Date.now() > scrollLock.exp) return;
      let el = scrollLock.card;
      if (!el || !el.isConnected) {
        const b = $(scrollLock.boxId);
        if (b && b.children[scrollLock.idx]) el = b.children[scrollLock.idx];
      }
      if (el && el.isConnected) {
        const d = el.getBoundingClientRect().top - scrollLock.top;
        if (Math.abs(d) > 2) window.scrollBy(0, d);
      }
    };
    requestAnimationFrame(fix);
    [40, 120, 260, 500].forEach((ms) => setTimeout(fix, ms));
  }

  document.addEventListener("mousedown", (e) => {
    const btn = e.target.closest("#recList button, #historyList button");
    if (btn) {
      let card = btn;
      while (card.parentElement && card.parentElement.id !== "recList" && card.parentElement.id !== "historyList") card = card.parentElement;
      lockCardScroll(card);
    }
  }, true);

  if ($("jobList")) {
    new MutationObserver(() => {
      if (scrollLock && Date.now() <= scrollLock.exp) {
        let el = scrollLock.card;
        if (!el || !el.isConnected) {
          const b = $(scrollLock.boxId);
          if (b && b.children[scrollLock.idx]) el = b.children[scrollLock.idx];
        }
        if (el && el.isConnected) {
          const d = el.getBoundingClientRect().top - scrollLock.top;
          if (Math.abs(d) > 2) window.scrollBy(0, d);
        }
      }
    }).observe($("jobList"), { childList: true, subtree: true });
  }

  const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function (msg, ...rest) {
    if (msg && msg.type === "START_DOWNLOAD" && msg.payload) {
      if (msg.payload.url) msg.payload.url = normalizeYtInputValue(msg.payload.url);
      if (msg.payload.title) msg.payload.title = cleanSportsTermsHe(msg.payload.title);
      const listSubsSel = $("v15ListSubsSelect");
      if (listSubsSel && listSubsSel.value !== "default" && (!msg.payload.subtitles || msg.payload.subtitles === "none")) {
        msg.payload.subtitles = listSubsSel.value;
        if (listSubsSel.value === "only") msg.payload.quality = "subs_only";
      }
    }
    return origSend(msg, ...rest);
  };

  function cleanSportsTermsHe(t) {
    return String(t || "")
      .replace(/\s*\([^)]*[a-zA-Z]{4,}[^)]*\)\s*$/g, "")
      .replace(/\bEXTENDED HIGHLIGHTS\b/gi, "תקציר מורחב")
      .replace(/\b(?:HIGHLIGHTS|HHIHLIGHTS|RESUMEN)\b/gi, "תקציר")
      .replace(/\b(?:FULL MATCH|PARTIDO COMPLETO)\b/gi, "משחק מלא")
      .replace(/\bFC Barcelona\b/gi, "ברצלונה")
      .replace(/\bReal Madrid\b/gi, "ריאל מדריד")
      .replace(/\bAtl[eé]tico de Madrid\b/gi, "אתלטיקו מדריד")
      .replace(/\bLALIGA EA SPORTS\b/gi, "לה ליגה")
      .replace(/\bדגשים\b|\bהבהרה\b/g, "תקציר")
      .trim();
  }

  async function translateSingleToHebrew(text) {
    const pre = cleanSportsTermsHe(text);
    const res = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=iw&dt=t&q=" + encodeURIComponent(pre));
    if (!res.ok) return pre;
    const data = await res.json();
    const tr = ((data[0] || []).map((x) => (x && x[0]) || "").join("") || "").trim();
    return cleanSportsTermsHe(tr || pre);
  }

  function showStatus(msg, isErr = false) {
    for (const id of ["hint", "v15QuickStatus"]) {
      const el = $(id);
      if (el) { el.textContent = msg; el.style.color = isErr ? "var(--fail)" : "var(--ok)"; }
    }
  }

  let lastPreviewVid = "";
  async function updateInstantPreview(rawVal) {
    const vid = extract11Id(rawVal);
    const box = $("videoPreview"), thumb = $("previewThumb"), titleEl = $("previewTitle"), authorEl = $("previewAuthor");
    if (!vid || !box || !titleEl || !authorEl) return;
    if (vid === lastPreviewVid && box.style.display !== "none") return;
    lastPreviewVid = vid;
    box.style.display = "flex";
    titleEl.textContent = "⏳ טוען פרטי סרטון (" + vid + ")...";
    authorEl.textContent = "מזהה: " + vid;
    if (thumb) {
      thumb.src = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" rx="8" fill="#1c2742"/><polygon points="68,30 68,60 96,45" fill="#38bdf8"/><text x="80" y="80" font-family="Segoe UI,sans-serif" font-size="11" fill="#94a3b8" text-anchor="middle">${vid}</text></svg>`);
    }
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", hl: "he", gl: "IL" } }, videoId: vid })
      });
      if (res.ok) {
        const data = await res.json();
        const vd = data.videoDetails || {}, mf = (data.microformat && data.microformat.playerMicroformatRenderer) || {};
        if (vd.title) {
          let t = vd.title;
          if ($("translateTitleDlToggle") && $("translateTitleDlToggle").checked) t = await translateSingleToHebrew(t);
          titleEl.textContent = t;
          const dur = vd.lengthSeconds ? Math.floor(vd.lengthSeconds / 60) + ":" + String(vd.lengthSeconds % 60).padStart(2, "0") : "";
          const views = vd.viewCount ? Number(vd.viewCount).toLocaleString() : "";
          const pub = (mf.publishDate || "").split("T")[0];
          authorEl.textContent = [vd.author, pub ? "📅 " + pub : "", views ? "👁 " + views : "", dur ? "⏱ " + dur : "", "🆔 " + vid].filter(Boolean).join(" • ");
        }
      }
    } catch {}
  }

  function triggerSimilarSearch(vid11, label) {
    if (!vid11 || !$("recQueryInput") || !$("findRecsBtn")) return;
    if ($("recChannelInput")) $("recChannelInput").value = "";
    $("recQueryInput").value = "SIMILAR:" + vid11;
    showStatus(`🔍 מחפש סרטונים דומים עבור: ${label || vid11}...`);
    $("findRecsBtn").click();
    setTimeout(() => { if ($("recQueryInput").value.startsWith("SIMILAR:")) $("recQueryInput").value = ""; }, 400);
  }

  function injectV15Controls() {
    const hd = document.querySelector("header.hd");
    if (hd && !$("v15QuickBar")) {
      const bar = document.createElement("div");
      bar.id = "v15QuickBar";
      bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;background:var(--surface);padding:10px 14px;border-radius:14px;border:1px solid var(--border);align-items:center;";
      bar.innerHTML = `
        <span class="small muted" style="font-weight:600;">⚡ כלים מהירים:</span>
        <button class="btn btn--danger small" id="purgeAllRepoBtn" type="button">🗑️ מחק כל הריצות והשחרורים</button>
        <button class="btn small" id="copyGhTokenBtn" type="button">🔑 העתק טוקן</button>
        <button class="btn small" id="copyYtCookiesBtn" type="button">🍪 העתק עוגיות</button>
        <button class="btn small" id="copyYtCookiesEncBtn" type="button">🔐 העתק עוגיות מוצפנות</button>
        <span id="v15QuickStatus" class="small" style="margin-inline-start:auto;font-weight:600;color:var(--accent);"></span>
      `;
      hd.insertAdjacentElement("afterend", bar);
    }

    const urlInput = $("urlInput");
    if (urlInput && !$("v15TopSimilarBtn")) {
      urlInput.placeholder = "https://www.youtube.com/watch?v=... או מזהה 11 תווים בלבד (למשל BwSMOsc_J3A)";
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;gap:8px;align-items:center;";
      urlInput.parentNode.insertBefore(wrap, urlInput);
      wrap.appendChild(urlInput);
      const simBtn = document.createElement("button");
      simBtn.id = "v15TopSimilarBtn";
      simBtn.type = "button";
      simBtn.className = "btn small";
      simBtn.style.cssText = "white-space:nowrap;padding:10px 12px;border-color:var(--accent);color:var(--accent);font-weight:600;";
      simBtn.textContent = "🔍 חפש דומים";
      simBtn.addEventListener("click", () => {
        const vid = extract11Id(urlInput.value);
        if (!vid) return showStatus("❌ הזן קישור או מזהה 11 תווים בתיבה", true);
        triggerSimilarSearch(vid, ($("previewTitle") && $("previewTitle").textContent) || vid);
      });
      wrap.appendChild(simBtn);

      const onUrlInput = () => {
        const raw = urlInput.value.trim();
        const vid = extract11Id(raw);
        if (vid && !raw.startsWith("http") && raw.split(/[\s,]+/).length === 1) {
          urlInput.value = "https://www.youtube.com/watch?v=" + vid;
          urlInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (vid) updateInstantPreview(vid);
      };
      urlInput.addEventListener("input", onUrlInput);
      urlInput.addEventListener("paste", () => setTimeout(onUrlInput, 30));
    }

    const emailToggle = $("emailToggle");
    if (emailToggle && !$("translateTitleDlToggle")) {
      const lbl = document.createElement("label");
      lbl.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
      lbl.className = "small";
      lbl.innerHTML = `<input type="checkbox" id="translateTitleDlToggle" class="switch" checked/><span>🔤 תרגם שם לעברית</span>`;
      emailToggle.closest("div").appendChild(lbl);
    }

    const topicChips = $("topicChips");
    if (topicChips && !$("v15QuickChannelsBar")) {
      const chBar = document.createElement("div");
      chBar.id = "v15QuickChannelsBar";
      chBar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;";
      const channels = [["⚽ LaLiga", "@LaLiga"], ["🏈 NFL", "@NFL"], ["🏆 UEFA", "@UEFA"], ["🦁 Premier League", "@premierleague"], ["🏀 NBA", "@NBA"], ["🐂 Red Bull", "@redbull"], ["🎙️ הפודיום", "@hapodium_podcast"], ["🔥 MrBeast", "@MrBeast"]];
      chBar.innerHTML = `<span class="small muted" style="font-weight:600;">⚡ ערוצים מהירים:</span>` +
        channels.map(([l, h]) => `<button type="button" class="btn small v15-ch" data-h="${h}" style="padding:3px 9px;font-size:11.5px;border-radius:999px;">${l}</button>`).join("");
      topicChips.insertAdjacentElement("afterend", chBar);
      chBar.querySelectorAll(".v15-ch").forEach((b) => b.addEventListener("click", () => {
        if ($("recChannelInput")) { $("recChannelInput").value = "https://www.youtube.com/" + b.dataset.h; if ($("findRecsBtn")) $("findRecsBtn").click(); }
      }));
    }

    const recSortSelect = $("recSortBySelect");
    if (recSortSelect && !recSortSelect.querySelector('option[value="quality_score"]')) {
      const opt = document.createElement("option");
      opt.value = "quality_score";
      opt.textContent = "💎 איכות ודירוג משוקלל (Full HD 1080p/4K + לייקים + צפיות)";
      recSortSelect.appendChild(opt);
    }

    const recFilterInput = $("recFilterPromptInput");
    if (recFilterInput && !$("v15SearchToggles")) {
      const wrap = document.createElement("div");
      wrap.id = "v15SearchToggles";
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:10px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:10px;";
      wrap.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;" class="small">
            <input type="checkbox" id="recHighQualityOnlyToggle" class="switch"/>
            <span>💎 רק איכותיים מאוד (Full HD 1080p/4K • ללא Shorts)</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;" class="small">
            <input type="checkbox" id="recTranslateTitlesToggle" class="switch" checked/>
            <span>🔤 תרגם שמות תוצאות לעברית נקייה</span>
          </label>
          <button class="btn small" id="translateVisibleRecsBtn" type="button" style="margin-inline-start:auto;padding:4px 10px;">🔤 תרגם תוצאות מוצגות לעברית</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px;">
          <span class="small muted" style="font-weight:600;">📝 כתוביות בהורדה מתוך הרשימה:</span>
          <select id="v15ListSubsSelect" class="input small" style="width:auto;padding:4px 10px;flex:1;">
            <option value="default">לפי הבחירה למעלה (ברירת מחדל)</option>
            <option value="embed">🎬+📝 הטמע כתוביות בעברית בתוך הווידאו (Embed)</option>
            <option value="files">📄 הורד קובץ כתוביות SRT בעברית לצד הווידאו</option>
            <option value="only">📝 הורד כתוביות בעברית בלבד (SRT ללא וידאו)</option>
          </select>
          <span class="small muted" style="font-weight:600;">⏱ סינון אורך:</span>
          <button type="button" class="btn small v15-dur" data-d="all" style="padding:3px 8px;font-size:11.5px;border-color:var(--accent);">הכל</button>
          <button type="button" class="btn small v15-dur" data-d="short" style="padding:3px 8px;font-size:11.5px;">⏱ תקצירים (עד 20 דק')</button>
          <button type="button" class="btn small v15-dur" data-d="long" style="padding:3px 8px;font-size:11.5px;">🏟️ משחקים מלאים (+20 דק')</button>
        </div>
      `;
      recFilterInput.parentElement.insertAdjacentElement("afterend", wrap);
      wrap.querySelectorAll(".v15-dur").forEach((btn) => btn.addEventListener("click", () => {
        wrap.querySelectorAll(".v15-dur").forEach((b) => { b.style.borderColor = ""; });
        btn.style.borderColor = "var(--accent)";
        const m = btn.dataset.d, recList = $("recList");
        if (!recList) return;
        for (const card of recList.children) {
          const md = (card.textContent || "").match(/⏱\s*(\d+):(\d+)/);
          const mins = md ? parseInt(md[1], 10) : 0;
          card.style.display = m === "all" ? "" : (m === "short" ? (mins < 20 ? "" : "none") : (mins >= 20 ? "" : "none"));
        }
      }));
    }

    const clearHistBtn = $("clearHistBtn");
    if (clearHistBtn && !$("translateHistAllBtn")) {
      const btn = document.createElement("button");
      btn.id = "translateHistAllBtn";
      btn.type = "button";
      btn.className = "btn small";
      btn.textContent = "🔤 תרגם שמות לעברית";
      clearHistBtn.insertAdjacentElement("beforebegin", btn);
    }
  }

  function wireV15Events() {
    const purgeHandler = async () => {
      const btn = $("purgeAllRepoBtn");
      if (btn) btn.disabled = true;
      showStatus("⏳ מוחק את כל הריצות והשחרורים מהמאגר...");
      try {
        const res = await chrome.runtime.sendMessage({ type: "PURGE_ALL_CLOUD" });
        if (res && res.ok) showStatus(`✅ נמחקו ${res.deletedReleases || 0} שחרורים ו-${res.deletedRuns || 0} ריצות!`);
        else showStatus("❌ שגיאה במחיקה", true);
      } catch (e) { showStatus("❌ שגיאה: " + e.message, true); }
      finally { if (btn) btn.disabled = false; }
    };
    if ($("purgeAllRepoBtn")) $("purgeAllRepoBtn").addEventListener("click", purgeHandler);
    if ($("cleanCloudBtn")) $("cleanCloudBtn").addEventListener("click", purgeHandler);

    if ($("copyGhTokenBtn")) $("copyGhTokenBtn").addEventListener("click", async () => {
      const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      if (!cfg || !cfg.token) return showStatus("❌ לא נמצא טוקן", true);
      await navigator.clipboard.writeText(cfg.token.trim());
      showStatus("✅ ה-GitHub Token הועתק ללוח!");
    });

    if ($("copyYtCookiesBtn")) $("copyYtCookiesBtn").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
      if (res && res.ok && res.raw) { await navigator.clipboard.writeText(res.raw); showStatus(`✅ הועתקו ${res.count || ""} עוגיות YouTube ללוח!`); }
      else showStatus("❌ לא נמצאו עוגיות YouTube", true);
    });

    if ($("copyYtCookiesEncBtn")) $("copyYtCookiesEncBtn").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
      if (res && res.ok && res.encrypted) { await navigator.clipboard.writeText(res.encrypted); showStatus("✅ העוגיות המוצפנות הועתקו ללוח!"); }
      else showStatus("❌ שגיאה בהצפנת עוגיות", true);
    });

    if ($("findRecsBtn")) $("findRecsBtn").addEventListener("click", () => {
      const fp = $("recFilterPromptInput");
      if (!fp) return;
      const base = fp.value.replace(/\[(HQ_ONLY|TR_HE)\]/gi, "").trim();
      const tags = [];
      if ($("recHighQualityOnlyToggle") && $("recHighQualityOnlyToggle").checked) tags.push("[HQ_ONLY]");
      if ($("recTranslateTitlesToggle") && $("recTranslateTitlesToggle").checked) tags.push("[TR_HE]");
      if (tags.length) { fp.value = base + " " + tags.join(" "); setTimeout(() => { fp.value = base; }, 400); }
    }, true);

    if ($("translateVisibleRecsBtn")) $("translateVisibleRecsBtn").addEventListener("click", async () => {
      const recList = $("recList");
      if (!recList) return;
      const els = Array.from(recList.querySelectorAll("a, div, span")).filter((el) => /^#\d+\s*•/.test((el.textContent || "").trim()) && el.children.length === 0);
      if (!els.length) return showStatus("אין תוצאות מוצגות לתרגום", true);
      showStatus(`⏳ מתרגם ומנקה ${els.length} כותרות לעברית...`);
      await Promise.all(els.map(async (el) => {
        const pfx = (el.textContent.match(/^#\d+\s*•\s*/) || [""])[0];
        const raw = el.textContent.replace(/^#\d+\s*•\s*/, "").trim();
        el.title = raw;
        const he = await translateSingleToHebrew(raw);
        if (he) el.textContent = pfx + he;
      }));
      showStatus("✅ כל הכותרות תורגמו לעברית נקייה!");
    });

    if ($("translateHistAllBtn")) $("translateHistAllBtn").addEventListener("click", async () => {
      showStatus("⏳ מתרגם שמות בהיסטוריה לעברית...");
      const res = await chrome.runtime.sendMessage({ type: "TRANSLATE_HISTORY_HE" });
      if (res && res.ok) { showStatus(`✅ תורגמו ${res.count || 0} שמות בהיסטוריה!`); setTimeout(() => location.reload(), 500); }
    });
  }

  function enhanceCards() {
    for (const cid of ["recList", "historyList"]) {
      const box = $(cid);
      if (!box) continue;
      for (const card of box.children) {
        if (card.dataset.v15Done) continue;
        // ניקוי סוגריים באנגלית ששוברים RTL בכותרת
        const titleEl = Array.from(card.querySelectorAll("a, div, span")).find((el) => /^#\d+\s*•/.test((el.textContent || "").trim()) && el.children.length === 0);
        if (titleEl) {
          const pfx = (titleEl.textContent.match(/^#\d+\s*•\s*/) || [""])[0];
          const raw = titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim();
          titleEl.title = raw;
          titleEl.textContent = pfx + cleanSportsTermsHe(raw);
        }
        const mId = (card.innerHTML || "").match(/(?:watch\?v=|\[|vi\/)([a-zA-Z0-9_-]{11})(?:["'&\]\s.\/]|$)/);
        if (mId && mId[1]) {
          card.dataset.v15Done = "1";
          const vid11 = mId[1];
          const btns = card.querySelectorAll("button");
          const lastBtn = btns[btns.length - 1];
          if (lastBtn && lastBtn.parentElement) {
            const parent = lastBtn.parentElement;
            // 1. כפתור הורדה עם כתוביות בעברית
            if (cid === "recList") {
              const subDlBtn = document.createElement("button");
              subDlBtn.type = "button";
              subDlBtn.className = "btn small";
              subDlBtn.style.cssText = "padding:4px 8px;font-size:11.5px;border-color:var(--ok);color:var(--ok);";
              subDlBtn.textContent = "🎬+📝 עם כתוביות";
              subDlBtn.title = "הורד וידאו זה יחד עם כתוביות מתורגמות לעברית";
              subDlBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                lockCardScroll(card);
                const cleanT = titleEl ? titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim() : vid11;
                chrome.runtime.sendMessage({
                  type: "START_DOWNLOAD",
                  payload: { url: "https://www.youtube.com/watch?v=" + vid11, title: cleanT, quality: ($("formatSelect") && $("formatSelect").value) || "best", mode: "video", subtitles: "embed" }
                });
                showStatus(`🚀 נשלחה הורדה עם כתוביות בעברית: ${cleanT}`);
              });
              parent.insertBefore(subDlBtn, lastBtn);
            }
            // 2. כפתור חיפוש סרטונים דומים
            const simBtn = document.createElement("button");
            simBtn.type = "button";
            simBtn.className = "btn small";
            simBtn.style.cssText = "padding:4px 8px;font-size:11.5px;border-color:var(--accent);color:var(--accent);";
            simBtn.textContent = "🔍 דומים";
            simBtn.title = "חפש סרטונים דומים לסרטון זה";
            simBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              const cleanT = titleEl ? titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim() : vid11;
              triggerSimilarSearch(vid11, cleanT);
            });
            parent.insertBefore(simBtn, lastBtn);

            // 3. כפתור העתקת מזהה 11 תווים
            if (!card.textContent.includes("🆔 " + vid11)) {
              const idBtn = document.createElement("button");
              idBtn.type = "button";
              idBtn.className = "btn small";
              idBtn.style.cssText = "padding:4px 8px;font-size:11.5px;";
              idBtn.textContent = `🆔 ${vid11}`;
              idBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                await navigator.clipboard.writeText(vid11);
                idBtn.textContent = "✅ הועתק!";
                setTimeout(() => { idBtn.textContent = `🆔 ${vid11}`; }, 1400);
              });
              parent.insertBefore(idBtn, lastBtn);
            }
          }
        }
      }
    }
  }

  function init() {
    injectV15Controls();
    wireV15Events();
    const obs = new MutationObserver(enhanceCards);
    if ($("recList")) obs.observe($("recList"), { childList: true, subtree: true });
    if ($("historyList")) obs.observe($("historyList"), { childList: true, subtree: true });
    enhanceCards();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
