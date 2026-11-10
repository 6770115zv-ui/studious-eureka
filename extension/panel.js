"use strict";
(() => {
  const el = (id) => document.getElementById(id);
  const formatSelect = el("formatSelect");
  for (const p of self.YTPROXY_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.quality;
    opt.textContent = p.label;
    formatSelect.append(opt);
  }

  let currentPreview = null;
  let previewDebounce = null;
  const selectedRecUrls = new Set();
  let lastHistory = [];
  let cachedCookieKey = "";
  const FILTER_STORAGE_KEY = "ytproxy_ai_filter_prompt";
  const AUTO_EMAIL_TOGGLE_KEY = "ytproxy_send_email_enabled";

  chrome.storage.local.get([FILTER_STORAGE_KEY, AUTO_EMAIL_TOGGLE_KEY]).then((d) => {
    if (d && d[FILTER_STORAGE_KEY] && el("recFilterPromptInput")) {
      el("recFilterPromptInput").value = d[FILTER_STORAGE_KEY];
    }
    if (d && d[AUTO_EMAIL_TOGGLE_KEY] !== undefined && el("emailToggle")) {
      el("emailToggle").checked = Boolean(d[AUTO_EMAIL_TOGGLE_KEY]);
      el("emailInputWrap").style.display = el("emailToggle").checked ? "block" : "none";
    }
  }).catch(() => {});

  if (el("recFilterPromptInput")) {
    el("recFilterPromptInput").addEventListener("change", () => {
      const val = el("recFilterPromptInput").value.trim();
      if (val) chrome.storage.local.set({ [FILTER_STORAGE_KEY]: val }).catch(() => {});
    });
  }

  el("emailToggle").addEventListener("change", () => {
    el("emailInputWrap").style.display = el("emailToggle").checked ? "block" : "none";
    chrome.storage.local.set({ [AUTO_EMAIL_TOGGLE_KEY]: el("emailToggle").checked }).catch(() => {});
  });

  async function copyActiveCookieKey(btnEl) {
    const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    const ck = (cfg && cfg.cookieKey) || cachedCookieKey || "";
    if (!ck) return;
    await navigator.clipboard.writeText(ck).catch(() => {});
    const orig = btnEl.textContent;
    btnEl.textContent = "✓ הועתק! הדבק ב-GitHub Secrets תחת COOKIE_KEY";
    setTimeout(() => { btnEl.textContent = orig; }, 3000);
  }

  if (el("copyCkBtn")) el("copyCkBtn").onclick = () => copyActiveCookieKey(el("copyCkBtn"));
  if (el("copyCkWarnBtn")) el("copyCkWarnBtn").onclick = () => copyActiveCookieKey(el("copyCkWarnBtn"));

  el("urlInput").addEventListener("input", () => {
    clearTimeout(previewDebounce);
    const val = el("urlInput").value.trim();
    if (!val.startsWith("http")) {
      el("videoPreview").style.display = "none";
      currentPreview = null;
      return;
    }
    previewDebounce = setTimeout(async () => {
      const firstUrl = val.split(/[\s,]+/)[0];
      const meta = await self.fetchYoutubeOembed(firstUrl);
      if (meta) {
        currentPreview = meta;
        el("previewThumb").src = meta.thumbnail;
        el("previewTitle").textContent = meta.title;
        el("previewAuthor").textContent = meta.author ? ("ערוץ: " + meta.author) : "";
        el("videoPreview").style.display = "flex";
      } else {
        el("videoPreview").style.display = "none";
      }
    }, 350);
  });

  el("settingsBtn").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });

  el("cleanCloudBtn").onclick = async () => {
    el("hint").textContent = "מפעיל ניקוי ענן ב-GitHub...";
    const res = await chrome.runtime.sendMessage({ type: "RUN_CLEANUP" });
    el("hint").textContent = res && res.ok ? "ניקוי הענן הופעל בהצלחה!" : ((res && res.error) || "שגיאה בניקוי");
  };

  el("clearJobsBtn").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_COMPLETED_JOBS" });
    void refresh();
  };

  el("clearHistBtn").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    void refresh();
  };

  el("histSearchInput").addEventListener("input", () => {
    renderHistoryArchive(lastHistory);
  });

  function getActiveDownloadOptions(forceSubsOnly = false) {
    const qVal = forceSubsOnly ? "subs_only" : formatSelect.value;
    const sVal = (forceSubsOnly || qVal === "subs_only") ? "only" : el("subsSelect").value;
    return {
      quality: sVal === "only" ? "subs_only" : qVal,
      subtitles: sVal,
      clipStart: el("clipStart").value.trim(),
      clipEnd: el("clipEnd").value.trim(),
      geoCountry: el("geoSelect").value,
      speedFactor: el("speedSelect").value,
      sponsorblock: el("sponsorToggle").checked,
      splitChapters: el("chaptersToggle").checked,
      normalizeAudio: el("normToggle").checked,
      sendEmail: el("emailToggle").checked,
      emailTo: el("emailToInput").value.trim()
    };
  }

  async function triggerDownloadFromInput(forceSubsOnly = false) {
    const raw = el("urlInput").value.trim();
    if (!raw) {
      el("hint").textContent = "נא להדביק קישור תחילה";
      return;
    }
    const urls = raw.split(/[\s,]+/).filter((u) => u.startsWith("http"));
    if (!urls.length) {
      el("hint").textContent = "נא להזין קישור תקין המתחיל ב-http";
      return;
    }
    const baseOpts = {
      ...getActiveDownloadOptions(forceSubsOnly),
      title: (currentPreview && currentPreview.title) || urls[0],
      thumbnail: (currentPreview && currentPreview.thumbnail) || ""
    };
    const payload = urls.length > 1
      ? { ...baseOpts, urls, mode: "list" }
      : { ...baseOpts, url: urls[0], mode: el("collectionToggle").checked ? "collection" : "video" };

    el("hint").textContent = forceSubsOnly ? "שולח בקשה להורדת כתוביות נקיות (SRT)..." : "שולח בקשה ל-GitHub Actions...";
    const res = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", payload });
    if (res && res.ok) {
      el("urlInput").value = "";
      el("videoPreview").style.display = "none";
      currentPreview = null;
      el("hint").textContent = forceSubsOnly
        ? "נשלח! קובץ הכתוביות הנקי יישמר אוטומטית."
        : "נשלח ל-GitHub Actions! ההורדה תישמר אוטומטית בסיום.";
      void refresh();
    } else {
      el("hint").textContent = (res && res.error) || "שגיאה בשליחה";
    }
  }

  el("downloadBtn").onclick = () => triggerDownloadFromInput(false);
  if (el("subsOnlyBtn")) {
    el("subsOnlyBtn").onclick = () => triggerDownloadFromInput(true);
  }

  function extractTopicsFromHistory(historyList) {
    const seen = new Set();
    const topics = [];
    const extRx = new RegExp("\\.(mp4|mp3|mkv|flac|wav|m4a|opus|srt)\\x24", "i");
    for (const item of historyList || []) {
      const cleaned = String(item.title || "")
        .replace(/\[[a-zA-Z0-9_-]{11}\]/g, "")
        .replace(extRx, "")
        .replace(/[|•\-–—_()\[\]]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!cleaned || cleaned.length < 4) continue;
      const words = cleaned.split(" ").slice(0, 4).join(" ");
      const key = words.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        topics.push(words);
      }
      if (topics.length >= 6) break;
    }
    return topics;
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString("he-IL");
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    if (!s) return "";
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function updateBatchButtons(items) {
    const hasItems = items && items.length > 0;
    el("selectAllRecsBtn").style.display = hasItems ? "inline-flex" : "none";
    el("batchRecsBtn").style.display = hasItems ? "inline-flex" : "none";
    el("batchRecsBtn").textContent = "📦 הורד מסומנים בריצה אחת (" + selectedRecUrls.size + ")";
    el("batchRecsBtn").disabled = selectedRecUrls.size === 0;
  }

  function renderRecommendations(recState, historyList) {
    const chipsWrap = el("topicChips");
    const topics = extractTopicsFromHistory(historyList);
    chipsWrap.replaceChildren();
    if (topics.length) {
      const lbl = document.createElement("span");
      lbl.className = "small muted";
      lbl.textContent = "נושאים אחרונים:";
      lbl.style.alignSelf = "center";
      chipsWrap.append(lbl);
      for (const t of topics) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "btn small";
        chip.style.padding = "4px 10px";
        chip.textContent = t;
        chip.onclick = () => {
          el("recQueryInput").value = t;
        };
        chipsWrap.append(chip);
      }
      if (!el("recQueryInput").value) {
        el("recQueryInput").value = topics[0];
      }
    }

    const statusEl = el("recStatusText");
    statusEl.textContent = (recState && recState.detail) || "";

    const recList = el("recList");
    recList.replaceChildren();
    const items = (recState && recState.items) || [];
    updateBatchButtons(items);

    el("selectAllRecsBtn").onclick = () => {
      if (selectedRecUrls.size === items.length) {
        selectedRecUrls.clear();
      } else {
        for (const it of items) selectedRecUrls.add(it.url);
      }
      renderRecommendations(recState, historyList);
    };

    el("batchRecsBtn").onclick = async () => {
      if (!selectedRecUrls.size) return;
      const urls = Array.from(selectedRecUrls);
      el("recStatusText").textContent = "שולח " + urls.length + " קבצים מסוננים להורדה מרוכזת בריצה אחת...";
      const res = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        payload: {
          ...getActiveDownloadOptions(false),
          urls,
          title: "חבילת המלצות מסוננת (" + urls.length + " קבצים)",
          mode: "list"
        }
      });
      if (res && res.ok) {
        selectedRecUrls.clear();
        el("recStatusText").textContent = "החבילה נשלחה להורדה מרוכזת בענן!";
        void refresh();
      }
    };

    for (const item of items) {
      const row = document.createElement("div");
      row.style.cssText = "background:var(--surface-2);padding:10px;border-radius:12px;border:1px solid var(--border);display:flex;gap:10px;align-items:center;";

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = selectedRecUrls.has(item.url);
      chk.style.cssText = "width:18px;height:18px;cursor:pointer;accent-color:var(--accent);";
      chk.onchange = () => {
        if (chk.checked) selectedRecUrls.add(item.url);
        else selectedRecUrls.delete(item.url);
        updateBatchButtons(items);
      };
      row.append(chk);

      if (item.thumbnail) {
        const img = document.createElement("img");
        img.src = item.thumbnail;
        img.style.cssText = "width:106px;height:60px;object-fit:cover;border-radius:8px;flex-shrink:0;";
        row.append(img);
      }
      const meta = document.createElement("div");
      meta.style.cssText = "flex:1;overflow:hidden;display:flex;flex-direction:column;gap:4px;";
      const tEl = document.createElement("div");
      tEl.style.cssText = "font-weight:600;font-size:13.5px;";
      tEl.textContent = item.title;
      const subEl = document.createElement("div");
      subEl.className = "small muted";
      subEl.textContent = item.channel + " • 👁 " + formatNumber(item.views) + " צפיות" + (item.duration ? (" • ⏱ " + formatDuration(item.duration)) : "");
      meta.append(tEl, subEl);

      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "btn btn--primary small";
      dlBtn.textContent = "⬇ הורד";
      dlBtn.onclick = async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "שולח...";
        await chrome.runtime.sendMessage({
          type: "START_DOWNLOAD",
          payload: {
            ...getActiveDownloadOptions(false),
            url: item.url,
            title: item.title,
            mode: "video"
          }
        });
        dlBtn.textContent = "✓ נשלח";
        void refresh();
      };
      row.append(meta, dlBtn);
      recList.append(row);
    }
  }

  function renderHistoryArchive(historyList) {
    const wrap = el("historyList");
    wrap.replaceChildren();
    const filter = el("histSearchInput").value.trim().toLowerCase();
    const filtered = (historyList || []).filter((h) => !filter || String(h.title || "").toLowerCase().includes(filter));
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "small muted";
      empty.textContent = "אין פריטים תואמים בהיסטוריה";
      wrap.append(empty);
      return;
    }
    for (const h of filtered.slice(0, 25)) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:var(--surface-2);border-radius:8px;border:1px solid var(--border);";
      const title = document.createElement("div");
      title.className = "small";
      title.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;";
      title.textContent = h.title + (h.actualQuality ? (" — [" + h.actualQuality + "]") : "");

      const btns = document.createElement("div");
      btns.style.cssText = "display:flex;gap:6px;";

      if (h.url) {
        const subOnlyHistBtn = document.createElement("button");
        subOnlyHistBtn.className = "btn small";
        subOnlyHistBtn.style.padding = "3px 8px";
        subOnlyHistBtn.title = "הורד כתוביות בלבד (עברית נקייה) עבור קישור זה";
        subOnlyHistBtn.textContent = "📝 כתוביות";
        subOnlyHistBtn.onclick = async () => {
          await chrome.runtime.sendMessage({
            type: "START_DOWNLOAD",
            payload: { ...getActiveDownloadOptions(true), url: h.url, title: h.title, mode: "video" }
          });
          void refresh();
        };

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn small";
        copyBtn.style.padding = "3px 8px";
        copyBtn.textContent = "📋 העתק";
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(h.url).catch(() => {});
          copyBtn.textContent = "✓ הועתק";
          setTimeout(() => { copyBtn.textContent = "📋 העתק"; }, 1500);
        };
        const redlBtn = document.createElement("button");
        redlBtn.className = "btn btn--primary small";
        redlBtn.style.padding = "3px 8px";
        redlBtn.textContent = "⬇ הורד שוב";
        redlBtn.onclick = async () => {
          await chrome.runtime.sendMessage({
            type: "START_DOWNLOAD",
            payload: { ...getActiveDownloadOptions(false), url: h.url, title: h.title, mode: "video" }
          });
          void refresh();
        };
        btns.append(subOnlyHistBtn, copyBtn, redlBtn);
      }
      row.append(title, btns);
      wrap.append(row);
    }
  }

  el("findRecsBtn").onclick = async () => {
    const query = el("recQueryInput").value.trim();
    if (!query) {
      el("recStatusText").textContent = "נא להקליד נושא לחיפוש";
      return;
    }
    const filterPrompt = el("recFilterPromptInput") ? el("recFilterPromptInput").value.trim() : "";
    if (filterPrompt) {
      chrome.storage.local.set({ [FILTER_STORAGE_KEY]: filterPrompt }).catch(() => {});
    }
    selectedRecUrls.clear();
    el("recStatusText").textContent = "משגר חיפוש רב-לשוני וסינון AI ל-GitHub Actions...";
    const res = await chrome.runtime.sendMessage({
      type: "START_RECOMMEND",
      payload: {
        query,
        minViews: el("recMinViewsSelect").value,
        filterPrompt
      }
    });
    if (!res || !res.ok) {
      el("recStatusText").textContent = (res && res.error) || "שגיאה בהפעלת מנוע ההמלצות";
    }
  };

  function renderJobs(jobsObj) {
    const list = el("jobList");
    list.replaceChildren();
    const ids = Object.keys(jobsObj || {}).sort((a, b) => (jobsObj[b].startedAt || 0) - (jobsObj[a].startedAt || 0));
    if (!ids.length) {
      list.textContent = "אין הורדות פעילות כרגע";
      return;
    }
    for (const id of ids) {
      const j = jobsObj[id];
      const elapsedSec = j.startedAt ? Math.max(0, Math.floor((Date.now() - j.startedAt) / 1000)) : 0;
      const elapsedLabel = (j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled" && elapsedSec > 0)
        ? (" • ⏱ " + formatDuration(elapsedSec))
        : "";

      const card = document.createElement("div");
      card.style.cssText = "background:var(--surface-2);padding:12px;border-radius:12px;border:1px solid var(--border);display:flex;flex-direction:column;gap:8px;";
      
      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = (j.files && j.files[0]) || j.title || j.url;
      const badge = document.createElement("span");
      badge.className = "small muted";
      const localPctStr = typeof j.localDlPct === "number" ? (" • הורדה למחשב: " + j.localDlPct + "%") : "";
      if (j.actualQuality) {
        badge.style.color = "var(--ok)";
        badge.style.fontWeight = "600";
        badge.textContent = "✓ " + j.actualQuality + localPctStr + " • כללי: " + (j.percent || 0) + "%";
      } else {
        badge.textContent = "יעד: " + (j.quality === "subs_only" ? "כתוביות בלבד" : j.quality) + localPctStr + " • " + (j.percent || 0) + "%" + elapsedLabel;
      }
      topRow.append(title, badge);

      const progTrack = document.createElement("div");
      progTrack.className = "progress-track";
      const progBar = document.createElement("div");
      progBar.className = "progress-bar";
      if (j.status === "failed") progBar.style.background = "var(--fail)";
      progBar.style.width = (j.percent || 5) + "%";
      progTrack.append(progBar);

      const info = document.createElement("div");
      info.className = "small muted";
      info.textContent = j.detail || j.status;

      card.append(topRow, progTrack, info);

      if (j.tempPath || j.finalDiskPath) {
        const pathBox = document.createElement("div");
        pathBox.className = "small";
        pathBox.dir = "ltr";
        pathBox.style.cssText = "background:rgba(0,0,0,0.25);padding:6px 9px;border-radius:8px;border:1px dashed var(--border);font-family:Consolas,monospace;font-size:11.5px;color:var(--accent);word-break:break-all;";
        pathBox.textContent = j.finalDiskPath
          ? ("📁 Saved Path: " + j.finalDiskPath + (j.tempPath ? ("  (Built via: " + j.tempPath + ")") : ""))
          : ("⚙ Temp / Build Path: " + j.tempPath);
        card.append(pathBox);
      }

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      if (j.runId) {
        const b = document.createElement("button");
        b.className = "btn";
        b.textContent = "צפה בריצה ב-GitHub";
        b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_RUN", jobId: j.id });
        actions.append(b);
      }
      if (j.status === "completed") {
        const b = document.createElement("button");
        b.className = "btn btn--primary";
        b.textContent = "פתח תיקיית הורדות";
        b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_DOWNLOADS" });
        actions.append(b);
      } else if (j.status === "failed" || j.status === "cancelled") {
        const retryBtn = document.createElement("button");
        retryBtn.className = "btn btn--primary";
        retryBtn.textContent = "🔄 נסה שוב";
        retryBtn.onclick = async () => {
          await chrome.runtime.sendMessage({ type: "RETRY_JOB", jobId: j.id });
          void refresh();
        };
        actions.append(retryBtn);
      } else {
        const b = document.createElement("button");
        b.className = "btn btn--danger";
        b.textContent = "בטל";
        b.onclick = () => chrome.runtime.sendMessage({ type: "CANCEL_JOB", jobId: j.id });
        actions.append(b);
      }
      card.append(actions);
      list.append(card);
    }
  }

  function updateCookieKeyStatusUI(prefs) {
    if (!prefs) return;
    cachedCookieKey = prefs.cookieKey || "";
    const badge = el("ck-status-badge");
    const warnBox = el("ckWarningBox");
    const warnTxt = el("ckWarningText");
    if (!badge || !warnBox) return;

    const st = prefs.cookieKeyStatus || "unknown";
    const shortKey = cachedCookieKey ? (cachedCookieKey.slice(0, 6) + "..." + cachedCookieKey.slice(-6)) : "לא מוגדר";

    if (st === "ok") {
      badge.textContent = "🔐 מפתח עוגיות תואם ל-GitHub (" + shortKey + ")";
      badge.style.color = "var(--ok)";
      warnBox.style.display = "none";
    } else if (st === "missing_in_github_secrets" || st === "mismatch_with_github_secrets" || st === "decrypt_failed_mismatch") {
      badge.textContent = "⚠️ אי-התאמה ב-COOKIE_KEY מול GitHub (" + shortKey + ")";
      badge.style.color = "var(--warn)";
      warnBox.style.display = "block";
      warnTxt.textContent = st === "missing_in_github_secrets"
        ? "שים לב: הסוד COOKIE_KEY טרם הוגדר ב-GitHub Secrets שלך (המערכת משתמשת כעת בגיבוי האוטומטי). מומלץ להעתיק ולהדביק אותו ב-GitHub Secrets."
        : "שים לב: הסוד COOKIE_KEY שמוגדר ב-GitHub Secrets שונה מהמפתח הקבוע שבתוסף (" + shortKey + ")! לחץ כאן להעתקת המפתח והחלף אותו ב-GitHub Secrets.";
    } else {
      badge.textContent = "🔐 מפתח עוגיות קבוע: " + shortKey;
      badge.style.color = "var(--text)";
      warnBox.style.display = "none";
    }
  }

  async function refresh() {
    const prefs = await chrome.runtime.sendMessage({ type: "GET_PREFS" });
    el("conn-dot").className = "dot " + (prefs && prefs.configured ? "is-ok" : "is-fail");
    el("conn-text").textContent = prefs && prefs.configured ? ("מחובר אל " + prefs.owner + "/" + prefs.repo) : "לא מוגדר — לחץ על הגדרות";
    updateCookieKeyStatusUI(prefs);
    if (prefs && prefs.emailTo && !el("emailToInput").value) {
      el("emailToInput").value = prefs.emailTo;
    }
    const res = await chrome.runtime.sendMessage({ type: "LIST_JOBS" });
    if (res && res.jobs) renderJobs(res.jobs);
    const recRes = await chrome.runtime.sendMessage({ type: "GET_RECOMMENDATIONS" });
    if (recRes && recRes.ok) {
      lastHistory = recRes.history || [];
      renderRecommendations(recRes.state, lastHistory);
      renderHistoryArchive(lastHistory);
    }
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "JOBS_CHANGED") renderJobs(m.jobs);
    if (m && m.type === "RECS_CHANGED") void refresh();
  });
  setInterval(refresh, 2000);
  void refresh();
})();
