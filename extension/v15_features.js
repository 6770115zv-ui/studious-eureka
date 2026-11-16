"use strict";
(() => {
  const $ = (id) => document.getElementById(id);

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
      const id11 = extract11Id(u);
      if (id11) return id11;
      return origExtract ? origExtract(u) : "";
    };
  }

  async function translateBatchToHebrew(texts) {
    if (!texts.length) return [];
    const joined = texts.join("\n ||| \n");
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=iw&dt=t&q=" + encodeURIComponent(joined);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const full = (data[0] || []).map((x) => (x && x[0]) || "").join("");
    return full.split(/\s*\|\|\|\s*/);
  }

  function showBannerStatus(msg, isError = false) {
    const hint = $("hint") || $("recStatusText");
    if (hint) {
      hint.textContent = msg;
      hint.style.color = isError ? "var(--fail)" : "var(--ok)";
    }
  }

  function injectV15Controls() {
    // 1. סרגל כלים עליון: מחיקת כל הריצות והשחרורים + העתקת טוקן ועוגיות
    const hd = document.querySelector("header.hd");
    if (hd && !$("v15QuickBar")) {
      const bar = document.createElement("div");
      bar.id = "v15QuickBar";
      bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;background:var(--surface);padding:10px 14px;border-radius:14px;border:1px solid var(--border);align-items:center;";
      bar.innerHTML = `
        <span class="small muted" style="font-weight:600;margin-inline-end:4px;">⚡ כלים מהירים:</span>
        <button class="btn btn--danger small" id="purgeAllRepoBtn" type="button" title="מוחק לחלוטין את כל ה-Workflow Runs וכל ה-Releases מהמאגר ב-GitHub">🗑️ מחק כל הריצות והשחרורים</button>
        <button class="btn small" id="copyGhTokenBtn" type="button" title="העתק את ה-GitHub Token הפעיל ללוח">🔑 העתק טוקן</button>
        <button class="btn small" id="copyYtCookiesBtn" type="button" title="העתק עוגיות YouTube בפורמט Netscape תקני">🍪 העתק עוגיות</button>
        <button class="btn small" id="copyYtCookiesEncBtn" type="button" title="העתק עוגיות מוצפנות AES-256-GCM">🔐 העתק עוגיות מוצפנות</button>
        <span id="v15QuickStatus" class="small" style="margin-inline-start:auto;font-weight:600;color:var(--accent);"></span>
      `;
      hd.insertAdjacentElement("afterend", bar);
    }

    // 2. תיבת סימון לתרגום שם הקובץ לעברית בהורדה + רמז למזהה 11 תווים
    const urlInput = $("urlInput");
    if (urlInput) {
      urlInput.placeholder = "https://www.youtube.com/watch?v=... או מזהה 11 תווים בלבד (למשל BwSMOsc_J3A)";
      const prevLabel = urlInput.previousElementSibling;
      if (prevLabel && prevLabel.tagName === "LABEL") {
        prevLabel.textContent = "קישור למדיה, מזהה 11 תווים בלבד (כגון BwSMOsc_J3A), אוסף או רשימת קישורים/מזהים:";
      }
      urlInput.addEventListener("input", () => {
        const norm = normalizeYtInputValue(urlInput.value);
        if (norm !== urlInput.value && norm.startsWith("https://www.youtube.com/watch?v=")) {
          urlInput.value = norm;
          urlInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }

    const emailToggle = $("emailToggle");
    if (emailToggle && !$("translateTitleDlToggle")) {
      const gridWrap = emailToggle.closest("div");
      if (gridWrap) {
        const lbl = document.createElement("label");
        lbl.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
        lbl.className = "small";
        lbl.innerHTML = `<input type="checkbox" id="translateTitleDlToggle" class="switch"/><span>🔤 תרגם שם לעברית</span>`;
        gridWrap.appendChild(lbl);
      }
    }

    // 3. אופציות חדשות בכרטיס החיפוש: "איכותיים מאוד בלבד" + "תרגום שמות לעברית"
    const recSortSelect = $("recSortBySelect");
    if (recSortSelect && !recSortSelect.querySelector('option[value="quality_score"]')) {
      const opt = document.createElement("option");
      opt.value = "quality_score";
      opt.textContent = "💎 איכות ודירוג משוקלל (Full HD 1080p/4K + לייקים + צפיות)";
      recSortSelect.appendChild(opt);
    }

    const recChannelInput = $("recChannelInput");
    if (recChannelInput) {
      recChannelInput.placeholder = "למשל: @ChannelName, שם ערוץ, או מזהה סרטון 11 תווים (BwSMOsc_J3A)...";
    }
    const recQueryInput = $("recQueryInput");
    if (recQueryInput) {
      recQueryInput.placeholder = "נושא לחיפוש או מזהה סרטון בן 11 תווים (למשל BwSMOsc_J3A)...";
    }

    const recFilterInput = $("recFilterPromptInput");
    if (recFilterInput && !$("v15SearchToggles")) {
      const wrap = document.createElement("div");
      wrap.id = "v15SearchToggles";
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:8px 10px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:10px;";
      wrap.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;" class="small">
          <input type="checkbox" id="recHighQualityOnlyToggle" class="switch"/>
          <span>💎 רק איכותיים מאוד (Full HD 1080p/4K • אורך מלא • יחס לייקים גבוה • ללא Shorts)</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;" class="small">
          <input type="checkbox" id="recTranslateTitlesToggle" class="switch"/>
          <span>🔤 תרגם שמות תוצאות לעברית</span>
        </label>
        <button class="btn small" id="translateVisibleRecsBtn" type="button" style="margin-inline-start:auto;padding:4px 10px;">🔤 תרגם תוצאות מוצגות לעברית</button>
      `;
      recFilterInput.parentElement.insertAdjacentElement("afterend", wrap);
    }

    // 4. כפתור תרגום כל ההיסטוריה לעברית
    const clearHistBtn = $("clearHistBtn");
    if (clearHistBtn && !$("translateHistAllBtn")) {
      const btn = document.createElement("button");
      btn.id = "translateHistAllBtn";
      btn.type = "button";
      btn.className = "btn small";
      btn.textContent = "🔤 תרגם שמות לעברית";
      btn.title = "מתרגם את כל שמות הקבצים באנגלית בארכיון ההיסטוריה לעברית";
      clearHistBtn.insertAdjacentElement("beforebegin", btn);
    }
  }

  function wireV15Events() {
    const qStatus = (txt, isErr = false) => {
      const el = $("v15QuickStatus");
      if (el) {
        el.textContent = txt;
        el.style.color = isErr ? "var(--fail)" : "var(--ok)";
      }
      showBannerStatus(txt, isErr);
    };

    // א. מחיקת כל הריצות והשחרורים מהמאגר
    const purgeHandler = async () => {
      const btn = $("purgeAllRepoBtn");
      if (btn) btn.disabled = true;
      qStatus("⏳ מוחק את כל הריצות והשחרורים מהמאגר...");
      try {
        const res = await chrome.runtime.sendMessage({ type: "PURGE_ALL_CLOUD" });
        if (res && res.ok) {
          qStatus(`✅ נמחקו בהצלחה ${res.deletedReleases || 0} שחרורים/תגיות ו-${res.deletedRuns || 0} ריצות מהמאגר!`);
        } else {
          qStatus("❌ שגיאה במחיקה: " + ((res && res.error) || "נכשל"), true);
        }
      } catch (e) {
        qStatus("❌ שגיאה: " + e.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    if ($("purgeAllRepoBtn")) $("purgeAllRepoBtn").addEventListener("click", purgeHandler);
    if ($("cleanCloudBtn")) $("cleanCloudBtn").addEventListener("click", purgeHandler);

    // ב. העתקת טוקן
    if ($("copyGhTokenBtn")) {
      $("copyGhTokenBtn").addEventListener("click", async () => {
        const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
        const tk = cfg && cfg.token ? cfg.token.trim() : "";
        if (!tk) {
          qStatus("❌ לא נמצא טוקן מוגדר", true);
          return;
        }
        await navigator.clipboard.writeText(tk);
        qStatus(`✅ ה-GitHub Token הועתק ללוח (${tk.slice(0, 10)}...)`);
      });
    }

    // ג. העתקת עוגיות (Netscape + מוצפנות)
    if ($("copyYtCookiesBtn")) {
      $("copyYtCookiesBtn").addEventListener("click", async () => {
        qStatus("⏳ מייצא עוגיות YouTube...");
        const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
        if (res && res.ok && res.raw) {
          await navigator.clipboard.writeText(res.raw);
          qStatus(`✅ הועתקו ${res.count || ""} עוגיות YouTube ללוח (פורמט Netscape)!`);
        } else {
          qStatus("❌ לא נמצאו עוגיות YouTube פעילות בדפדפן", true);
        }
      });
    }

    if ($("copyYtCookiesEncBtn")) {
      $("copyYtCookiesEncBtn").addEventListener("click", async () => {
        qStatus("⏳ מצפין עוגיות YouTube...");
        const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
        if (res && res.ok && res.encrypted) {
          await navigator.clipboard.writeText(res.encrypted);
          qStatus(`✅ העוגיות המוצפנות (COOKIES_ENC) הועתקו ללוח!`);
        } else {
          qStatus("❌ שגיאה בייצוא/הצפנת עוגיות", true);
        }
      });
    }

    // ד. הזרקת דגלי איכות ותרגום לפני שיגור חיפוש
    const findRecsBtn = $("findRecsBtn");
    if (findRecsBtn) {
      findRecsBtn.addEventListener("click", () => {
        const fpInput = $("recFilterPromptInput");
        if (!fpInput) return;
        let base = fpInput.value.replace(/\[(HQ_ONLY|TR_HE)\]/gi, "").trim();
        const hq = $("recHighQualityOnlyToggle") && $("recHighQualityOnlyToggle").checked;
        const tr = $("recTranslateTitlesToggle") && $("recTranslateTitlesToggle").checked;
        const tags = [];
        if (hq) tags.push("[HQ_ONLY]");
        if (tr) tags.push("[TR_HE]");
        if (tags.length) {
          fpInput.value = base + " " + tags.join(" ");
          setTimeout(() => { fpInput.value = base; }, 400);
        }
      }, true);
    }

    // ה. תרגום שם קובץ לעברית לפני הורדה + נרמול מזהה 11 תווים
    for (const btnId of ["downloadBtn", "subsOnlyBtn"]) {
      const b = $(btnId);
      if (b) {
        b.addEventListener("click", () => {
          const uIn = $("urlInput");
          if (uIn && uIn.value.trim()) {
            uIn.value = normalizeYtInputValue(uIn.value);
          }
          const trToggle = $("translateTitleDlToggle");
          const prevTitle = $("previewTitle");
          if (trToggle && trToggle.checked && prevTitle && prevTitle.textContent) {
            translateBatchToHebrew([prevTitle.textContent.trim()]).then(([tr]) => {
              if (tr) prevTitle.textContent = tr;
            }).catch(() => {});
          }
        }, true);
      }
    }

    // ו. תרגום חי של תוצאות החיפוש המוצגות על המסך
    if ($("translateVisibleRecsBtn")) {
      $("translateVisibleRecsBtn").addEventListener("click", async () => {
        const recList = $("recList");
        if (!recList) return;
        const titleEls = Array.from(recList.querySelectorAll("a, div, span")).filter((el) => /^#\d+\s*•/.test((el.textContent || "").trim()) && el.children.length === 0);
        if (!titleEls.length) {
          qStatus("אין תוצאות מוצגות לתרגום כרגע", true);
          return;
        }
        qStatus(`⏳ מתרגם ${titleEls.length} כותרות לעברית...`);
        const rawList = titleEls.map((el) => el.textContent.replace(/^#(\d+)\s*•\s*/, "").trim());
        const prefixes = titleEls.map((el) => (el.textContent.match(/^#\d+\s*•\s*/) || [""])[0]);
        const batchSize = 25;
        for (let i = 0; i < rawList.length; i += batchSize) {
          const chunk = rawList.slice(i, i + batchSize);
          try {
            const trChunk = await translateBatchToHebrew(chunk);
            for (let j = 0; j < chunk.length; j++) {
              const idx = i + j;
              if (trChunk[j] && trChunk[j] !== chunk[j]) {
                titleEls[idx].textContent = `${prefixes[idx]}${trChunk[j]} (${chunk[j]})`;
              }
            }
          } catch {}
        }
        qStatus("✅ כל כותרות החיפוש תורגמו לעברית!");
      });
    }

    // ז. תרגום כל שמות הקבצים בארכיון ההיסטוריה לעברית
    if ($("translateHistAllBtn")) {
      $("translateHistAllBtn").addEventListener("click", async () => {
        const histList = $("historyList");
        if (!histList) return;
        qStatus("⏳ מתרגם שמות בהיסטוריה לעברית...");
        const res = await chrome.runtime.sendMessage({ type: "TRANSLATE_HISTORY_HE" });
        if (res && res.ok) {
          qStatus(`✅ תורגמו ${res.count || 0} שמות בהיסטוריה לעברית! רענן או הקלד בתיבת הסינון לעדכון.`);
          const histInput = $("histSearchInput");
          if (histInput) histInput.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          qStatus("❌ שגיאה בתרגום ההיסטוריה", true);
        }
      });
    }
  }

  // הוספת כפתור העתקת מזהה 11 תווים על פריטי חיפוש והיסטוריה
  function observeAndEnhanceItems() {
    const enhanceContainer = (containerId) => {
      const box = $(containerId);
      if (!box) return;
      const cards = box.children;
      for (const card of cards) {
        if (card.dataset.v15Enhanced) continue;
        const txt = card.innerHTML || "";
        const mId = txt.match(/(?:watch\?v=|\[)([a-zA-Z0-9_-]{11})(?:["'&\]\s]|$)/);
        if (mId && mId[1]) {
          card.dataset.v15Enhanced = "1";
          const vid11 = mId[1];
          const btns = card.querySelectorAll("button");
          const lastBtn = btns[btns.length - 1];
          if (lastBtn && lastBtn.parentElement) {
            const idBtn = document.createElement("button");
            idBtn.type = "button";
            idBtn.className = "btn small";
            idBtn.style.cssText = "padding:4px 8px;font-size:11.5px;";
            idBtn.textContent = `🆔 ${vid11}`;
            idBtn.title = "העתק מזהה סרטון בן 11 תווים ללוח";
            idBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              await navigator.clipboard.writeText(vid11);
              idBtn.textContent = "✅ הועתק!";
              setTimeout(() => { idBtn.textContent = `🆔 ${vid11}`; }, 1500);
            });
            lastBtn.parentElement.insertBefore(idBtn, lastBtn);
          }
        }
      }
    };

    const obs = new MutationObserver(() => {
      enhanceContainer("recList");
      enhanceContainer("historyList");
    });
    const rList = $("recList");
    const hList = $("historyList");
    if (rList) obs.observe(rList, { childList: true, subtree: true });
    if (hList) obs.observe(hList, { childList: true, subtree: true });
    enhanceContainer("recList");
    enhanceContainer("historyList");
  }

  function init() {
    injectV15Controls();
    wireV15Events();
    observeAndEnhanceItems();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
