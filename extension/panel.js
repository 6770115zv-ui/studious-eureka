"use strict";
(() => {
  const el = (id) => document.getElementById(id);
  const H = self.YTUltra || {};

  const STORAGE_KEYS = {
    aiPrompt: "ytproxy_ai_filter_prompt",
    autoEmail: "ytproxy_send_email_enabled",
    activeTab: "ytproxy_active_tab",
    netfreeNoThumbs: "ytproxy_netfree_no_thumbs"
  };

  let currentPreview = null;
  let lastPreviewVid = "";
  let previewDebounce = null;
  const selectedRecUrls = new Set();
  let activeSessionId = "";
  let lastSessionsMap = {};
  let lastHistory = [];
  let lastRecRenderSig = "";
  let lastHistRenderSig = "";
  let lastJobsRenderSig = "";
  let toastTimer = null;

  function showToast(msg, isErr = false) {
    const t = el("v15QuickStatus");
    if (!t) return;
    clearTimeout(toastTimer);
    t.textContent = msg;
    t.className = "toast-bar" + (isErr ? " is-err" : "");
    if (msg) {
      toastTimer = setTimeout(() => {
        t.textContent = "";
        t.className = "toast-bar";
      }, 4200);
    }
  }

  // --------------------------------------------------------------------------
  // טאבים ראשיים
  // --------------------------------------------------------------------------
  function switchTab(tabName) {
    document.querySelectorAll(".nav-tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-pane").forEach((p) => {
      p.classList.toggle("is-active", p.id === "pane-" + tabName);
    });
    chrome.storage.local.set({ [STORAGE_KEYS.activeTab]: tabName }).catch(() => {});
  }

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  if (el("goToQueueBtn")) el("goToQueueBtn").onclick = () => switchTab("queue");

  // מילוי פורמטים
  const formatSelect = el("formatSelect");
  for (const p of self.YTPROXY_PRESETS || []) {
    const opt = document.createElement("option");
    opt.value = p.quality;
    opt.textContent = p.label;
    formatSelect.append(opt);
  }

  // טעינת העדפות שמורות
  chrome.storage.local.get(Object.values(STORAGE_KEYS)).then((d) => {
    if (!d) return;
    if (d[STORAGE_KEYS.activeTab]) switchTab(d[STORAGE_KEYS.activeTab]);
    if (d[STORAGE_KEYS.aiPrompt] && el("recFilterPromptInput")) {
      el("recFilterPromptInput").value = d[STORAGE_KEYS.aiPrompt];
    }
    if (d[STORAGE_KEYS.autoEmail] !== undefined && el("emailToggle")) {
      el("emailToggle").checked = Boolean(d[STORAGE_KEYS.autoEmail]);
      el("emailInputWrap").style.display = el("emailToggle").checked ? "block" : "none";
    }
    if (d[STORAGE_KEYS.netfreeNoThumbs] !== undefined && el("netfreeNoThumbsToggle")) {
      el("netfreeNoThumbsToggle").checked = Boolean(d[STORAGE_KEYS.netfreeNoThumbs]);
      document.body.classList.toggle("netfree-no-thumbs", el("netfreeNoThumbsToggle").checked);
    }
  }).catch(() => {});

  if (el("netfreeNoThumbsToggle")) {
    el("netfreeNoThumbsToggle").addEventListener("change", () => {
      const on = el("netfreeNoThumbsToggle").checked;
      document.body.classList.toggle("netfree-no-thumbs", on);
      chrome.storage.local.set({ [STORAGE_KEYS.netfreeNoThumbs]: on }).catch(() => {});
      showToast(on ? "🖼️ מצב נטפרי מהיר הופעל (תמונות מוסתרות)" : "🖼️ תמונות ממוזערות הוחזרו");
    });
  }

  if (el("recUseAiFilterToggle") && el("aiFilterWrap")) {
    el("recUseAiFilterToggle").addEventListener("change", () => {
      el("aiFilterWrap").style.display = el("recUseAiFilterToggle").checked ? "flex" : "none";
    });
  }

  if (el("recFilterPromptInput")) {
    el("recFilterPromptInput").addEventListener("change", () => {
      const val = el("recFilterPromptInput").value.trim();
      if (val) chrome.storage.local.set({ [STORAGE_KEYS.aiPrompt]: val }).catch(() => {});
    });
  }

  if (el("emailToggle")) {
    el("emailToggle").addEventListener("change", () => {
      el("emailInputWrap").style.display = el("emailToggle").checked ? "block" : "none";
      chrome.storage.local.set({ [STORAGE_KEYS.autoEmail]: el("emailToggle").checked }).catch(() => {});
    });
  }

  // --------------------------------------------------------------------------
  // כפתורי כותרת עליונה (כלים / ניקוי / הגדרות)
  // --------------------------------------------------------------------------
  el("settingsBtn").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });

  el("cleanCloudBtn").onclick = async () => {
    el("cleanCloudBtn").disabled = true;
    showToast("⏳ מוחק את כל הריצות וה-Releases מהמאגר...");
    try {
      const res = await chrome.runtime.sendMessage({ type: "PURGE_ALL_CLOUD" });
      if (res && res.ok) showToast(`✅ נמחקו ${res.deletedReleases || 0} Releases ו-${res.deletedRuns || 0} ריצות!`);
      else showToast("❌ שגיאה במחיקה", true);
    } catch (e) {
      showToast("❌ שגיאה: " + e.message, true);
    } finally {
      el("cleanCloudBtn").disabled = false;
    }
  };

  el("copyGhTokenBtn").onclick = async () => {
    const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!cfg || !cfg.token) return showToast("❌ לא נמצא טוקן", true);
    await navigator.clipboard.writeText(cfg.token.trim());
    showToast("✅ ה-GitHub Token הועתק ללוח!");
  };

  el("copyYtCookiesEncBtn").onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
    if (res && res.ok && res.encrypted) {
      await navigator.clipboard.writeText(res.encrypted);
      showToast("✅ העוגיות המוצפנות הועתקו ללוח!");
    } else {
      showToast("❌ שגיאה בהצפנת עוגיות (בדוק COOKIE_KEY בהגדרות)", true);
    }
  };

  // --------------------------------------------------------------------------
  // אינדקס 65 ערוצי ספורט ופודקאסטים
  // --------------------------------------------------------------------------
  function initSportsHub() {
    const catSel = el("v15HubCatSelect");
    const chSel = el("v15HubChannelSelect");
    const quickBar = el("v15QuickChannelsBar");
    const allCh = H.ALL_CHANNELS || [];
    if (!catSel || !chSel || !quickBar) return;

    const populate = () => {
      const list = catSel.value === "all" ? allCh : allCh.filter((x) => x.cat === catSel.value);
      chSel.replaceChildren();
      const defOpt = document.createElement("option");
      defOpt.value = "";
      defOpt.textContent = `-- בחר ערוץ מהרשימה (${list.length}) --`;
      chSel.append(defOpt);
      for (const x of list) {
        const o = document.createElement("option");
        o.value = x.handle;
        o.textContent = `${x.label} (${x.handle})`;
        chSel.append(o);
      }

      quickBar.replaceChildren();
      const lbl = document.createElement("span");
      lbl.className = "small muted";
      lbl.style.fontWeight = "700";
      lbl.textContent = "⚡ בחירה מהירה:";
      quickBar.append(lbl);

      for (const x of list.slice(0, 14)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn small";
        b.style.cssText = "padding:3px 10px;font-size:11.5px;border-radius:999px;";
        b.textContent = x.label.replace(/^[^\s]+\s*/, "").replace(/\s*\([^)]*\)/g, "").trim();
        b.onclick = () => {
          chSel.value = x.handle;
          el("recChannelInput").value = x.handle;
          showToast(`📺 נבחר הערוץ ${x.handle}`);
        };
        quickBar.append(b);
      }
    };

    catSel.addEventListener("change", populate);
    chSel.addEventListener("change", () => {
      if (chSel.value) el("recChannelInput").value = chSel.value;
    });
    populate();

    el("v15LoadChannelPlaylistBtn").onclick = () => {
      const h = chSel.value || el("recChannelInput").value.trim();
      if (!h) return showToast("❌ בחר ערוץ מהרשימה תחילה", true);
      el("recChannelInput").value = h;
      el("findRecsBtn").click();
    };

    el("v15SendChannelToTopBtn").onclick = () => {
      const h = chSel.value || el("recChannelInput").value.trim();
      if (!h) return showToast("❌ בחר ערוץ תחילה", true);
      const plMode = el("v15HubPlaylistMode").value || "auto";
      const sfx = plMode === "streams" ? "/streams" : "/videos";
      const cleanH = h.startsWith("http") ? h : ("https://www.youtube.com/" + h + sfx);
      el("urlInput").value = cleanH;
      el("collectionToggle").checked = true;
      switchTab("download");
      showToast(`📥 הועבר להורדה הישירה: ${cleanH}`);
    };
  }
  initSportsHub();

  el("clearChannelBtn").onclick = () => {
    el("recChannelInput").value = "";
    if (el("v15HubChannelSelect")) el("v15HubChannelSelect").value = "";
  };
  el("clearQueryBtn").onclick = () => { el("recQueryInput").value = ""; };

  el("resetSearchFiltersBtn").onclick = () => {
    el("recChannelInput").value = "";
    el("recQueryInput").value = "";
    if (el("v15HubChannelSelect")) el("v15HubChannelSelect").value = "";
    el("recSortBySelect").value = "views";
    el("recDurationSelect").value = "all";
    el("recSeasonSelect").value = "all";
    el("v15HubPlaylistMode").value = "auto";
    el("recMinViewsSelect").value = "0";
    el("recMaxResultsSelect").value = "60";
    el("recHighQualityOnlyToggle").checked = false;
    el("liveRecSearchInput").value = "";
    applyLiveClientFilters();
    showToast("🔄 כל שדות החיפוש והסינון אופסו");
  };

  // --------------------------------------------------------------------------
  // תצוגה מקדימה והורדה ישירה
  // --------------------------------------------------------------------------
  async function updateInstantPreview(rawVal) {
    const vid = H.extract11Id ? H.extract11Id(rawVal) : "";
    const box = el("videoPreview");
    const thumb = el("previewThumb");
    const titleEl = el("previewTitle");
    const authorEl = el("previewAuthor");
    if (!vid) {
      box.style.display = "none";
      currentPreview = null;
      lastPreviewVid = "";
      return;
    }
    if (vid === lastPreviewVid && box.style.display !== "none") return;
    lastPreviewVid = vid;
    box.style.display = "flex";
    titleEl.textContent = "⏳ טוען פרטי סרטון (" + vid + ")...";
    authorEl.textContent = "מזהה: " + vid;
    thumb.onerror = () => {
      if (self.NETFREE_SAFE_THUMB_SVG && thumb.src !== self.NETFREE_SAFE_THUMB_SVG) thumb.src = self.NETFREE_SAFE_THUMB_SVG;
    };
    thumb.src = "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg";

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
        const mf = (data.microformat && data.microformat.playerMicroformatRenderer) || {};
        if (vd.title) {
          let titleTxt = vd.title;
          if (el("translateTitleDlToggle") && el("translateTitleDlToggle").checked && H.translateSingleToHebrew) {
            titleTxt = await H.translateSingleToHebrew(titleTxt);
          }
          currentPreview = { title: titleTxt, author: vd.author || "", thumbnail: thumb.src };
          titleEl.textContent = titleTxt;
          const dur = vd.lengthSeconds ? formatDuration(vd.lengthSeconds) : "";
          const views = vd.viewCount ? formatNumber(vd.viewCount) : "";
          const pub = (mf.publishDate || "").split("T")[0];
          authorEl.textContent = [vd.author, pub ? "📅 " + pub : "", views ? "👁 " + views : "", dur ? "⏱ " + dur : "", "🆔 " + vid].filter(Boolean).join(" • ");
        }
      }
    } catch {}
  }

  const urlInput = el("urlInput");
  const handleUrlChange = () => {
    clearTimeout(previewDebounce);
    const raw = urlInput.value.trim();
    const vid = H.extract11Id ? H.extract11Id(raw) : "";
    if (vid && !raw.startsWith("http") && raw.split(/[\s,]+/).length === 1) {
      urlInput.value = "https://www.youtube.com/watch?v=" + vid;
    }
    previewDebounce = setTimeout(() => updateInstantPreview(urlInput.value.trim()), 260);
  };
  urlInput.addEventListener("input", handleUrlChange);
  urlInput.addEventListener("paste", () => setTimeout(handleUrlChange, 30));

  function getActiveDownloadOptions(forceSubsOnly = false, fromRecList = false) {
    let qVal = forceSubsOnly ? "subs_only" : formatSelect.value;
    let sVal = (forceSubsOnly || qVal === "subs_only") ? "only" : el("subsSelect").value;
    if (fromRecList && !forceSubsOnly) {
      const listSub = el("v15ListSubsSelect") ? el("v15ListSubsSelect").value : "default";
      if (listSub !== "default") {
        sVal = listSub;
        if (listSub === "only") qVal = "subs_only";
      }
    }
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

  async function dispatchDownload(payload) {
    if (payload.url && H.normalizeYtInputValue) payload.url = H.normalizeYtInputValue(payload.url);
    if (payload.title && H.cleanSportsTermsHe) payload.title = H.cleanSportsTermsHe(payload.title);
    return chrome.runtime.sendMessage({ type: "START_DOWNLOAD", payload });
  }

  async function triggerDownloadFromInput(forceSubsOnly = false) {
    const raw = urlInput.value.trim();
    if (!raw) { el("hint").textContent = "נא להדביק קישור תחילה"; return; }
    const norm = H.normalizeYtInputValue ? H.normalizeYtInputValue(raw) : raw;
    const urls = norm.split(/[\s,]+/).filter((u) => u.startsWith("http"));
    if (!urls.length) { el("hint").textContent = "נא להזין קישור תקין או מזהה 11 תווים"; return; }

    const baseOpts = {
      ...getActiveDownloadOptions(forceSubsOnly, false),
      title: (currentPreview && currentPreview.title) || urls[0],
      thumbnail: (currentPreview && currentPreview.thumbnail) || ""
    };
    const payload = urls.length > 1
      ? { ...baseOpts, urls, mode: "list" }
      : { ...baseOpts, url: urls[0], mode: el("collectionToggle").checked ? "collection" : "video" };

    el("hint").textContent = "שולח בקשה ל-GitHub Actions...";
    const res = await dispatchDownload(payload);
    if (res && res.ok) {
      urlInput.value = "";
      el("videoPreview").style.display = "none";
      currentPreview = null;
      lastPreviewVid = "";
      el("hint").textContent = "✓ נשלח! ניתן לעקוב בפס ההורדות למעלה.";
      showToast("🚀 ההורדה נשלחה לענן GitHub!");
      void refresh();
    } else {
      el("hint").textContent = (res && res.error) || "שגיאה בשליחה";
    }
  }

  el("downloadBtn").onclick = () => triggerDownloadFromInput(false);
  el("subsOnlyBtn").onclick = () => triggerDownloadFromInput(true);

  el("v15TopSimilarBtn").onclick = () => {
    const vid = H.extract11Id ? H.extract11Id(urlInput.value) : "";
    if (!vid) return showToast("❌ הזן קישור או מזהה 11 תווים תחילה", true);
    triggerSimilarSearch(vid, (currentPreview && currentPreview.title) || vid);
  };

  function triggerSimilarSearch(vid11, label) {
    if (!vid11) return;
    switchTab("search");
    el("recChannelInput").value = "";
    el("recQueryInput").value = "SIMILAR:" + vid11;
    showToast(`🔍 מחפש סרטונים דומים עבור: ${label || vid11}...`);
    el("findRecsBtn").click();
    setTimeout(() => {
      if (el("recQueryInput").value.startsWith("SIMILAR:")) el("recQueryInput").value = "";
    }, 350);
  }

  // --------------------------------------------------------------------------
  // פורמטרים וכלי עזר
  // --------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasHebrew = (s) => /[\u0590-\u05FF]/.test(String(s || ""));
  const formatNumber = (n) => Number(n || 0).toLocaleString("he-IL");

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    if (!s) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function formatUploadDate(ymd) {
    const str = String(ymd || "").trim();
    if (/^\d{8}$/.test(str)) return `${str.slice(6, 8)}/${str.slice(4, 6)}/${str.slice(0, 4)}`;
    return "";
  }

  function extractTopicsFromHistory(historyList) {
    const seen = new Set();
    const topics = [];
    const extRx = /\.(mp4|mp3|mkv|flac|wav|m4a|opus|srt)$/i;
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
      if (!seen.has(key)) { seen.add(key); topics.push(words); }
      if (topics.length >= 6) break;
    }
    return topics;
  }

  // --------------------------------------------------------------------------
  // חיפוש וסינון תוצאות
  // --------------------------------------------------------------------------
  function getVisibleRecItems() {
    const cards = Array.from(el("recList").children);
    return cards.filter((c) => c.style.display !== "none");
  }

  function updateBatchButtons(totalItemsCount) {
    const hasItems = totalItemsCount > 0;
    el("batchBar").style.display = hasItems ? "flex" : "none";
    el("translateVisibleRecsBtn").style.display = hasItems ? "inline-flex" : "none";
    el("selectTop30RecsBtn").style.display = totalItemsCount > 10 ? "inline-flex" : "none";
    el("selectTop100RecsBtn").style.display = totalItemsCount > 40 ? "inline-flex" : "none";
    el("batchRecsBtn").textContent = `📦 הורד מסומנים (${selectedRecUrls.size})`;
    el("batchRecsBtn").disabled = selectedRecUrls.size === 0;
  }

  function applyLiveClientFilters() {
    const recList = el("recList");
    const cards = Array.from(recList.children);
    if (!cards.length) return;

    const durMode = el("recDurationSelect").value || "all";
    const minViews = Number(el("recMinViewsSelect").value || 0);
    const hqOnly = Boolean(el("recHighQualityOnlyToggle").checked);
    const liveSearch = (el("liveRecSearchInput").value || "").trim().toLowerCase();

    const activeRec = activeSessionId ? lastSessionsMap[activeSessionId] : null;
    const expectedCh = (activeRec && activeRec.channel && !String(activeRec.channel).startsWith("http") && !String(activeRec.channel).startsWith("@"))
      ? String(activeRec.channel).trim().toLowerCase()
      : "";

    let visibleCount = 0;
    for (const card of cards) {
      const totalSec = Number(card.dataset.duration || 0);
      const mins = totalSec / 60;
      const views = Number(card.dataset.views || 0);
      const cardCh = (card.dataset.channel || "").toLowerCase();
      const searchText = (card.dataset.search || "").toLowerCase();

      let show = true;
      if (durMode === "no_shorts" && totalSec > 0 && totalSec <= 60) show = false;
      else if (durMode === "clips" && totalSec > 0 && (totalSec < 60 || mins > 20)) show = false;
      else if (durMode === "long" && totalSec > 0 && mins < 20) show = false;
      else if (durMode === "short5" && totalSec > 0 && mins > 5) show = false;

      if (show && expectedCh && cardCh && !cardCh.includes(expectedCh) && !expectedCh.includes(cardCh)) {
        show = false;
      }
      if (show && hqOnly && totalSec > 0 && totalSec < 65) show = false;
      if (show && minViews > 0 && views < minViews) show = false;
      if (show && liveSearch && !searchText.includes(liveSearch)) show = false;

      card.style.display = show ? "flex" : "none";
      if (show) visibleCount++;
    }

    const st = el("recStatusText");
    const base = st.dataset.baseText || "";
    if (base) {
      st.textContent = visibleCount < cards.length
        ? `${base} — מוצגות ${visibleCount} מתוך ${cards.length}`
        : base;
    }
  }

  for (const id of ["recDurationSelect", "recMinViewsSelect", "recHighQualityOnlyToggle", "liveRecSearchInput"]) {
    const node = el(id);
    if (node) {
      node.addEventListener("change", applyLiveClientFilters);
      node.addEventListener("input", applyLiveClientFilters);
    }
  }

  el("findRecsBtn").onclick = async () => {
    const channel = el("recChannelInput").value.trim();
    const query = el("recQueryInput").value.trim();
    if (!channel && !query) {
      showToast("❌ נא להזין נושא לחיפוש או לבחור ערוץ", true);
      return;
    }

    const useAi = el("recUseAiFilterToggle").checked;
    const rawPrompt = el("recFilterPromptInput").value.trim();
    if (rawPrompt) chrome.storage.local.set({ [STORAGE_KEYS.aiPrompt]: rawPrompt }).catch(() => {});

    const tags = [];
    if (el("recHighQualityOnlyToggle").checked) tags.push("[HQ_ONLY]");
    if (el("recTranslateTitlesToggle").checked) tags.push("[TR_HE]");
    const plMode = el("v15HubPlaylistMode").value || "auto";
    if (plMode === "uu_all") tags.push("[PL_UU]");
    else if (plMode === "streams") tags.push("[PL_STREAMS]");
    else if (plMode === "uulp") tags.push("[PL_UULP]");

    const durMode = el("recDurationSelect").value || "all";
    if (durMode !== "all") tags.push("[DUR:" + durMode.toUpperCase() + "]");

    const isSim = query.toUpperCase().startsWith("SIMILAR:");
    const seasonMode = el("recSeasonSelect").value || "all";
    if (seasonMode !== "all" && !isSim) tags.push("[SEASON:" + seasonMode.toUpperCase() + "]");

    const btn = el("findRecsBtn");
    btn.disabled = true;
    selectedRecUrls.clear();
    el("recStatusText").dataset.baseText = "";

    try {
      if (H.harvestLocalIsraeliIds && !isSim) {
        el("recStatusText").textContent = "🌐 אוסף מזהים מקומיים מישראל לפני השליחה לענן...";
        const ilIds = await H.harvestLocalIsraeliIds(channel, query, seasonMode);
        if (ilIds.length > 0) tags.push("[IL_IDS:" + ilIds.slice(0, 180).join(",") + "]");
      }
      const cleanPrompt = useAi ? rawPrompt.replace(/\[[A-Z0-9_,:]+\]/gi, "").trim() : "";
      const finalFilterPrompt = (cleanPrompt + " " + tags.join(" ")).trim();

      el("recStatusText").textContent = "🚀 משגר חיפוש ל-GitHub Actions...";
      const res = await chrome.runtime.sendMessage({
        type: "START_RECOMMEND",
        payload: {
          query,
          channel,
          sortBy: el("recSortBySelect").value || "views",
          maxResults: el("recMaxResultsSelect").value || "60",
          minViews: el("recMinViewsSelect").value || "0",
          filterPrompt: finalFilterPrompt
        }
      });

      if (!res || !res.ok) {
        el("recStatusText").textContent = (res && res.error) || "שגיאה בהפעלת החיפוש";
        showToast("❌ שגיאה בשיגור החיפוש", true);
      } else {
        activeSessionId = res.requestId;
        lastRecRenderSig = "";
        showToast("🔍 החיפוש שוגר לענן!");
        void refresh();
      }
    } finally {
      btn.disabled = false;
    }
  };

  el("clearDoneRecsBtn").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_DONE_REC_SESSIONS" });
    lastRecRenderSig = "";
    void refresh();
  };

  el("copyRecLogBtn").onclick = (ev) => {
    ev.stopPropagation();
    const txt = el("recDebugLog").textContent || "";
    if (!txt) return;
    navigator.clipboard.writeText(txt).catch(() => {});
    el("copyRecLogBtn").textContent = "✓ הועתק";
    setTimeout(() => { el("copyRecLogBtn").textContent = "📋 העתק"; }, 1600);
  };

  el("translateVisibleRecsBtn").onclick = async () => {
    const visibleCards = getVisibleRecItems();
    if (!visibleCards.length) return;
    showToast(`⏳ מתרגם ${visibleCards.length} כותרות מוצגות לעברית...`);
    await Promise.all(visibleCards.map(async (card) => {
      const titleNode = card.querySelector(".vid-card__title");
      if (!titleNode) return;
      const orig = titleNode.title || titleNode.textContent;
      if (H.translateSingleToHebrew) {
        const he = await H.translateSingleToHebrew(orig);
        if (he && titleNode.isConnected) {
          titleNode.textContent = he;
          card.dataset.search = (he + " " + orig + " " + (card.dataset.channel || "")).toLowerCase();
        }
      }
    }));
    showToast("✅ כל הכותרות המוצגות תורגמו לעברית!");
  };

  function renderRecommendations(sessionsMap, historyList, forceRender = false) {
    lastSessionsMap = sessionsMap || {};
    const sessions = Object.values(lastSessionsMap).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (!activeSessionId || !lastSessionsMap[activeSessionId]) {
      activeSessionId = sessions.length ? sessions[0].requestId : "";
    }
    const activeRec = activeSessionId ? lastSessionsMap[activeSessionId] : null;

    const sig = JSON.stringify({
      activeSessionId,
      selCount: selectedRecUrls.size,
      histLen: (historyList || []).length,
      tabs: sessions.map((s) => [s.requestId, s.status, s.detail, (s.items || []).length, (s.logs || []).length])
    });
    if (!forceRender && sig === lastRecRenderSig) return;
    lastRecRenderSig = sig;

    // כפתור ניקוי לשוניות
    const hasDone = sessions.some((s) => s.status === "completed" || s.status === "failed");
    el("clearDoneRecsBtn").style.display = hasDone ? "inline-flex" : "none";

    // לשוניות חיפושים מקבילים
    const tabsWrap = el("recSessionsTabs");
    tabsWrap.replaceChildren();
    if (sessions.length > 0) {
      tabsWrap.style.display = "flex";
      for (const sess of sessions) {
        const pill = document.createElement("div");
        pill.className = "sess-pill" + (sess.requestId === activeSessionId ? " is-active" : "");
        const icon = sess.status === "completed" ? `✓ (${(sess.items || []).length})`
          : sess.status === "failed" ? "✕" : "⏳";

        const lbl = document.createElement("span");
        lbl.textContent = `${icon} ${sess.tabTitle || sess.channel || sess.query || "חיפוש"}`;
        lbl.onclick = () => {
          activeSessionId = sess.requestId;
          selectedRecUrls.clear();
          renderRecommendations(lastSessionsMap, historyList, true);
        };

        const closeBtn = document.createElement("span");
        closeBtn.className = "sess-pill__x";
        closeBtn.textContent = "×";
        closeBtn.title = "סגור לשונית";
        closeBtn.onclick = async (ev) => {
          ev.stopPropagation();
          await chrome.runtime.sendMessage({ type: "REMOVE_REC_SESSION", requestId: sess.requestId });
          if (activeSessionId === sess.requestId) activeSessionId = "";
          lastRecRenderSig = "";
          void refresh();
        };
        pill.append(lbl, closeBtn);
        tabsWrap.append(pill);
      }
    } else {
      tabsWrap.style.display = "none";
    }

    // נושאים אחרונים מההיסטוריה
    const chipsWrap = el("topicChips");
    const topics = extractTopicsFromHistory(historyList);
    chipsWrap.replaceChildren();
    if (topics.length) {
      const lbl = document.createElement("span");
      lbl.className = "small muted";
      lbl.textContent = "נושאים אחרונים:";
      chipsWrap.append(lbl);
      for (const t of topics) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "btn small";
        chip.style.cssText = "padding:3px 10px;font-size:11.5px;border-radius:999px;";
        chip.textContent = t;
        chip.onclick = () => { el("recQueryInput").value = t; };
        chipsWrap.append(chip);
      }
    }

    // שורת סטטוס
    const statusEl = el("recStatusText");
    const nextDetail = (activeRec && activeRec.detail) || "הזן נושא או ערוץ למעלה ולחץ על \"הפעל סריקה וחיפוש בענן\".";
    statusEl.dataset.baseText = nextDetail;
    statusEl.textContent = nextDetail;
    statusEl.style.color = activeRec && activeRec.status === "failed"
      ? "var(--fail)"
      : (activeRec && activeRec.status === "completed" ? "var(--ok)" : "");

    // יומן טכני מתקפל (נפתח אוטומטית רק במקרה שגיאה)
    const logWrap = el("recLogWrap");
    const logPre = el("recDebugLog");
    const openRunBtn = el("openRecRunBtn");
    const logs = (activeRec && Array.isArray(activeRec.logs)) ? activeRec.logs : [];
    if (logs.length > 0) {
      logWrap.style.display = "block";
      logPre.textContent = logs.join("\n");
      logPre.scrollTop = logPre.scrollHeight;
      if (activeRec && activeRec.status === "failed") logWrap.open = true;
    } else {
      logWrap.style.display = "none";
    }
    if (activeRec && activeRec.runId) {
      openRunBtn.style.display = "inline-flex";
      openRunBtn.onclick = (ev) => {
        ev.stopPropagation();
        chrome.runtime.sendMessage({ type: "OPEN_REC_RUN", runId: activeRec.runId });
      };
    } else {
      openRunBtn.style.display = "none";
    }

    // רשימת סרטונים (כרטיסים מרווחים ב-2 שורות!)
    const recList = el("recList");
    recList.replaceChildren();
    const items = (activeRec && activeRec.items) || [];
    updateBatchButtons(items.length);

    const selectVisibleN = (limit) => {
      selectedRecUrls.clear();
      const vis = getVisibleRecItems().slice(0, limit);
      for (const c of vis) {
        if (c.dataset.url) selectedRecUrls.add(c.dataset.url);
        const chk = c.querySelector(".vid-card__chk");
        if (chk) chk.checked = true;
      }
      for (const c of Array.from(recList.children)) {
        const chk = c.querySelector(".vid-card__chk");
        if (chk) chk.checked = selectedRecUrls.has(c.dataset.url);
      }
      updateBatchButtons(items.length);
    };

    el("selectTop30RecsBtn").onclick = () => selectVisibleN(30);
    el("selectTop100RecsBtn").onclick = () => selectVisibleN(100);
    el("selectAllRecsBtn").onclick = () => {
      const vis = getVisibleRecItems();
      if (selectedRecUrls.size >= vis.length && vis.length > 0) {
        selectedRecUrls.clear();
        for (const c of Array.from(recList.children)) {
          const chk = c.querySelector(".vid-card__chk");
          if (chk) chk.checked = false;
        }
        updateBatchButtons(items.length);
      } else {
        selectVisibleN(vis.length);
      }
    };

    el("batchRecsBtn").onclick = async () => {
      if (!selectedRecUrls.size) return;
      const urls = Array.from(selectedRecUrls);
      showToast(`📦 שולח ${urls.length} קבצים להורדה מרוכזת בענן...`);
      const res = await dispatchDownload({
        ...getActiveDownloadOptions(false, true),
        urls,
        title: `חבילת סרטונים (${urls.length} קבצים)`,
        mode: "list"
      });
      if (res && res.ok) {
        selectedRecUrls.clear();
        lastRecRenderSig = "";
        showToast(`✅ נשלחו ${urls.length} סרטונים להורדה מרוכזת!`);
        void refresh();
      }
    };

    const autoTrClient = el("recTranslateTitlesToggle").checked;

    items.forEach((item, idx) => {
      const vid11 = item.id || (H.extract11Id ? H.extract11Id(item.url) : "");
      const cleanTitle = H.cleanSportsTermsHe ? H.cleanSportsTermsHe(item.title) : String(item.title || "");
      const cleanCh = String(item.channel || "").replace(/\s*•\s*📅\s*[^•]+/g, "").trim();
      const chNameOnly = cleanCh.split("•")[0].trim();
      const durStr = formatDuration(item.duration);
      const dateStr = formatUploadDate(item.upload_date) || item.date_formatted || "";

      const card = document.createElement("div");
      card.className = "vid-card";
      card.dataset.url = item.url || "";
      card.dataset.duration = String(item.duration || 0);
      card.dataset.views = String(item.views || 0);
      card.dataset.channel = chNameOnly;
      card.dataset.search = `${cleanTitle} ${item.orig_title || ""} ${cleanCh} ${vid11}`.toLowerCase();

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "vid-card__chk";
      chk.checked = selectedRecUrls.has(item.url);
      chk.onchange = () => {
        if (chk.checked) selectedRecUrls.add(item.url);
        else selectedRecUrls.delete(item.url);
        updateBatchButtons(items.length);
      };
      card.append(chk);

      // תמונה ממוזערת עם תג משך זמן + גיבוי נטפרי
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "vid-card__thumb-wrap";
      const img = document.createElement("img");
      img.className = "vid-card__thumb";
      img.loading = "lazy";
      img.alt = "";
      img.onerror = () => {
        if (self.NETFREE_SAFE_THUMB_SVG && img.src !== self.NETFREE_SAFE_THUMB_SVG) img.src = self.NETFREE_SAFE_THUMB_SVG;
      };
      img.src = item.thumbnail || (vid11 ? `https://i.ytimg.com/vi/${vid11}/mqdefault.jpg` : self.NETFREE_SAFE_THUMB_SVG);
      thumbWrap.append(img);
      if (durStr) {
        const durBadge = document.createElement("span");
        durBadge.className = "vid-card__dur";
        durBadge.textContent = durStr;
        thumbWrap.append(durBadge);
      }
      card.append(thumbWrap);

      // גוף הכרטיס (כותרת רחבה + מטא-דאטה + שורת פעולות נקייה)
      const body = document.createElement("div");
      body.className = "vid-card__body";

      const titleRow = document.createElement("div");
      titleRow.className = "vid-card__title-row";
      const rank = document.createElement("span");
      rank.className = "vid-card__rank";
      rank.textContent = "#" + (idx + 1);
      const tEl = document.createElement("div");
      tEl.className = "vid-card__title";
      tEl.textContent = cleanTitle;
      tEl.title = item.orig_title || item.title || "";
      titleRow.append(rank, tEl);

      // השלמת תרגום לקוח רק אם עדיין נותרה שפה זרה (ערבית/ספרדית/אנגלית)
      if (autoTrClient && H.needsHebrewTranslation && H.needsHebrewTranslation(cleanTitle) && H.translateSingleToHebrew) {
        H.translateSingleToHebrew(cleanTitle).then((he) => {
          if (he && tEl.isConnected) {
            tEl.textContent = he;
            card.dataset.search = `${he} ${item.orig_title || ""} ${cleanCh} ${vid11}`.toLowerCase();
          }
        }).catch(() => {});
      }

      const meta = document.createElement("div");
      meta.className = "vid-card__meta";
      const metaParts = [];
      if (cleanCh) metaParts.push("📺 " + cleanCh);
      metaParts.push("👁 " + formatNumber(item.views));
      if (item.likes) metaParts.push("👍 " + formatNumber(item.likes));
      if (dateStr) metaParts.push("📅 " + dateStr);
      if (durStr) metaParts.push("⏱ " + durStr);
      meta.textContent = metaParts.join("  •  ");

      const actions = document.createElement("div");
      actions.className = "vid-card__actions";

      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "btn btn--primary";
      dlBtn.textContent = "⬇ הורד";
      dlBtn.onclick = async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "שולח...";
        const r = await dispatchDownload({
          ...getActiveDownloadOptions(false, true),
          url: item.url,
          title: tEl.textContent,
          mode: "video"
        });
        dlBtn.textContent = r && r.ok ? "✓ נשלח" : "✕ שגיאה";
        void refresh();
      };
      actions.append(dlBtn);

      const subDlBtn = document.createElement("button");
      subDlBtn.type = "button";
      subDlBtn.className = "btn btn--ok";
      subDlBtn.textContent = "🎬+📝 עם כתוביות";
      subDlBtn.onclick = async () => {
        subDlBtn.disabled = true;
        subDlBtn.textContent = "שולח...";
        const r = await dispatchDownload({
          ...getActiveDownloadOptions(false, false),
          url: item.url,
          title: tEl.textContent,
          subtitles: "embed",
          mode: "video"
        });
        subDlBtn.textContent = r && r.ok ? "✓ נשלח" : "✕ שגיאה";
        void refresh();
      };
      actions.append(subDlBtn);

      if (vid11) {
        const simBtn = document.createElement("button");
        simBtn.type = "button";
        simBtn.className = "btn btn--accent-outline";
        simBtn.textContent = "🔍 דומים";
        simBtn.onclick = () => triggerSimilarSearch(vid11, tEl.textContent);
        actions.append(simBtn);

        const idBtn = document.createElement("button");
        idBtn.type = "button";
        idBtn.className = "btn";
        idBtn.textContent = "🆔 " + vid11;
        idBtn.title = "העתק מזהה סרטון";
        idBtn.onclick = async () => {
          await navigator.clipboard.writeText(vid11);
          idBtn.textContent = "✅ הועתק!";
          setTimeout(() => { idBtn.textContent = "🆔 " + vid11; }, 1400);
        };
        actions.append(idBtn);
      }

      body.append(titleRow, meta, actions);
      card.append(body);
      recList.append(card);
    });

    applyLiveClientFilters();
  }

  // --------------------------------------------------------------------------
  // תור הורדות (גם בטאב התור וגם בפס הצף העליון)
  // --------------------------------------------------------------------------
  function buildJobCard(j) {
    const isTerminal = ["completed", "failed", "cancelled"].includes(j.status);
    const elapsedSec = j.startedAt ? Math.max(0, Math.floor((Date.now() - j.startedAt) / 1000)) : 0;
    const elapsedLabel = (!isTerminal && elapsedSec > 0) ? (" • ⏱ " + formatDuration(elapsedSec)) : "";

    const card = document.createElement("div");
    card.className = "job-card";

    const topRow = document.createElement("div");
    topRow.className = "job-card__top";
    const title = document.createElement("div");
    title.className = "job-card__title";
    title.textContent = String((j.files && j.files[0]) || j.title || j.url)
      .replace(/[\u2066-\u2069]/g, "")
      .replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]{2,5}$)/i, "");

    const badge = document.createElement("span");
    badge.className = "small muted";
    const localPctStr = typeof j.localDlPct === "number" ? (" • הורדה למחשב: " + j.localDlPct + "%") : "";
    if (j.actualQuality) {
      badge.style.color = "var(--ok)";
      badge.style.fontWeight = "700";
      badge.textContent = "✓ " + j.actualQuality + localPctStr + " • " + (j.percent || 0) + "%";
    } else {
      badge.textContent = "יעד: " + (j.quality === "subs_only" ? "כתוביות בעברית" : j.quality) + localPctStr + " • " + (j.percent || 0) + "%" + elapsedLabel;
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
      pathBox.className = "job-card__path";
      pathBox.dir = "ltr";
      const cleanSaved = String(j.finalDiskPath || "").replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]+$)/i, "");
      pathBox.textContent = cleanSaved ? ("📁 " + cleanSaved) : ("⚙ " + j.tempPath);
      pathBox.title = cleanSaved || j.tempPath;
      card.append(pathBox);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    if (j.runId) {
      const b = document.createElement("button");
      b.className = "btn small";
      b.textContent = "🔗 צפה בריצה ב-GitHub";
      b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_RUN", jobId: j.id });
      actions.append(b);
    }
    if (j.status === "completed") {
      const b = document.createElement("button");
      b.className = "btn btn--primary small";
      b.textContent = "📂 פתח תיקיית הורדות";
      b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_DOWNLOADS" });
      actions.append(b);
    } else if (j.status === "failed" || j.status === "cancelled") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn--primary small";
      retryBtn.textContent = "🔄 נסה שוב";
      retryBtn.onclick = async () => {
        await chrome.runtime.sendMessage({ type: "RETRY_JOB", jobId: j.id });
        void refresh();
      };
      actions.append(retryBtn);
    } else {
      const b = document.createElement("button");
      b.className = "btn btn--danger small";
      b.textContent = "✕ בטל";
      b.onclick = () => chrome.runtime.sendMessage({ type: "CANCEL_JOB", jobId: j.id });
      actions.append(b);
    }
    card.append(actions);
    return card;
  }

  function renderJobs(jobsObj) {
    const ids = Object.keys(jobsObj || {}).sort((a, b) => (jobsObj[b].startedAt || 0) - (jobsObj[a].startedAt || 0));
    const activeJobs = ids.map((id) => jobsObj[id]).filter((j) => !["completed", "failed", "cancelled"].includes(j.status));

    // תג מונה בטאב תור והיסטוריה
    const badge = el("queueTabBadge");
    if (badge) {
      badge.style.display = activeJobs.length > 0 ? "inline-block" : "none";
      badge.textContent = String(activeJobs.length);
    }

    const sig = JSON.stringify(ids.map((id) => [id, jobsObj[id].status, jobsObj[id].percent, jobsObj[id].localDlPct, jobsObj[id].detail]));
    if (!activeJobs.length && sig === lastJobsRenderSig) return;
    lastJobsRenderSig = sig;

    // פס פעילות עליון צף
    const pinnedWrap = el("pinnedJobsWrap");
    const pinnedList = el("pinnedJobsList");
    pinnedList.replaceChildren();
    if (activeJobs.length > 0) {
      pinnedWrap.style.display = "flex";
      for (const aj of activeJobs.slice(0, 3)) pinnedList.append(buildJobCard(aj));
    } else {
      pinnedWrap.style.display = "none";
    }

    // רשימה מלאה בטאב תור והיסטוריה
    const list = el("jobList");
    list.replaceChildren();
    if (!ids.length) {
      const empty = document.createElement("div");
      empty.className = "small muted";
      empty.textContent = "אין הורדות פעילות או אחרונות כרגע.";
      list.append(empty);
      return;
    }
    for (const id of ids) list.append(buildJobCard(jobsObj[id]));
  }

  el("clearJobsBtn").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_COMPLETED_JOBS" });
    lastJobsRenderSig = "";
    void refresh();
  };

  // --------------------------------------------------------------------------
  // היסטוריית הורדות (ב-2 שורות מרווחות כדי שהכותרות לא יחתכו!)
  // --------------------------------------------------------------------------
  function renderHistoryArchive(historyList) {
    const filter = el("histSearchInput").value.trim().toLowerCase();
    const sig = filter + "|" + (historyList || []).length + "|" + ((historyList && historyList[0] && historyList[0].timestamp) || 0);
    if (sig === lastHistRenderSig) return;
    lastHistRenderSig = sig;

    const wrap = el("historyList");
    wrap.replaceChildren();
    const filtered = (historyList || []).filter((h) => !filter || String(h.title || "").toLowerCase().includes(filter));
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "small muted";
      empty.textContent = "אין פריטים תואמים בהיסטוריה.";
      wrap.append(empty);
      return;
    }

    for (const h of filtered.slice(0, 35)) {
      const vid11 = h.videoId || (H.extract11Id ? H.extract11Id(h.url) : "");
      const cleanHT = String(h.title || "")
        .replace(/[\u2066-\u2069]/g, "")
        .replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]{2,5}$)/i, "");

      const row = document.createElement("div");
      row.className = "hist-card";

      const top = document.createElement("div");
      top.className = "hist-card__top";
      const title = document.createElement("div");
      title.className = "hist-card__title";
      title.textContent = cleanHT;
      top.append(title);

      if (h.actualQuality && h.actualQuality !== "תקין") {
        const qBadge = document.createElement("span");
        qBadge.className = "hist-card__qual";
        qBadge.textContent = h.actualQuality;
        top.append(qBadge);
      }

      const btns = document.createElement("div");
      btns.className = "hist-card__btns";

      if (h.url) {
        const redlBtn = document.createElement("button");
        redlBtn.className = "btn btn--primary";
        redlBtn.textContent = "⬇ הורד שוב";
        redlBtn.onclick = async () => {
          await dispatchDownload({ ...getActiveDownloadOptions(false, false), url: h.url, title: cleanHT, mode: "video" });
          showToast("🚀 ההורדה שוגרה שוב!");
          void refresh();
        };

        const subBtn = document.createElement("button");
        subBtn.className = "btn btn--ok";
        subBtn.textContent = "📝 כתוביות בעברית";
        subBtn.onclick = async () => {
          await dispatchDownload({ ...getActiveDownloadOptions(true, false), url: h.url, title: cleanHT, mode: "video" });
          showToast("📝 בקשת כתוביות שוגרה!");
          void refresh();
        };

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn";
        copyBtn.textContent = "📋 העתק קישור";
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(h.url).catch(() => {});
          copyBtn.textContent = "✓ הועתק";
          setTimeout(() => { copyBtn.textContent = "📋 העתק קישור"; }, 1400);
        };

        btns.append(redlBtn, subBtn, copyBtn);

        if (vid11) {
          const simBtn = document.createElement("button");
          simBtn.className = "btn btn--accent-outline";
          simBtn.textContent = "🔍 דומים";
          simBtn.onclick = () => triggerSimilarSearch(vid11, cleanHT);

          const idBtn = document.createElement("button");
          idBtn.className = "btn";
          idBtn.textContent = "🆔 " + vid11;
          idBtn.onclick = async () => {
            await navigator.clipboard.writeText(vid11);
            idBtn.textContent = "✅ הועתק";
            setTimeout(() => { idBtn.textContent = "🆔 " + vid11; }, 1400);
          };
          btns.append(simBtn, idBtn);
        }
      }

      row.append(top, btns);
      wrap.append(row);
    }
  }

  el("histSearchInput").addEventListener("input", () => {
    lastHistRenderSig = "";
    renderHistoryArchive(lastHistory);
  });

  el("clearHistBtn").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    lastHistRenderSig = "";
    void refresh();
  };

  el("translateHistAllBtn").onclick = async () => {
    showToast("⏳ מתרגם את כל כותרות ההיסטוריה לעברית...");
    const res = await chrome.runtime.sendMessage({ type: "TRANSLATE_HISTORY_HE" });
    if (res && res.ok) {
      showToast(`✅ תורגמו ${res.count || 0} כותרות בהיסטוריה!`);
      lastHistRenderSig = "";
      void refresh();
    }
  };

  // --------------------------------------------------------------------------
  // מתרגם קובצי כתוביות מקומיים (עם זיהוי שפה אוטומטי sl=auto!)
  // --------------------------------------------------------------------------
  const TRAILING_SPLIT_RX = new RegExp(
    "^(.*?)\\s+(" +
    "with a couple of|a couple of|a lot of|kind of|sort of|out of|instead of|because of|in front of|" +
    "going to|trying to|want to|have to|has to|had to|used to|able to|ready to|" +
    "a|an|the|and|or|but|to|of|in|on|at|for|with|from|by|about|as|into|onto|upon|" +
    "is|are|was|were|be|been|has|have|had|will|would|can|could|should|may|might|must|" +
    "he|she|it|we|they|you|i|he's|she's|it's|we're|they're|you're|i'm|that's|there's|what's|who's|" +
    "his|her|its|our|their|my|your|this|that|these|those|which|who|whom|whose|when|where|while|if|because|since|until|than" +
    ")$", "i"
  );
  const ADJ_PULL_RX = new RegExp(
    "\\b(such a|a|an|the|very|really|pretty|quite|so|too|his|her|their|our|my|your|its)\\s+" +
    "(good|great|big|small|new|old|first|last|next|other|another|right|wrong|best|worst|whole|same|nice|bad|high|low|long|short|full|hard|easy)$", "i"
  );

  function tsToMs(tsStr) {
    try {
      const clean = String(tsStr || "").trim().replace(".", ",");
      const [hms, msPart] = clean.split(",");
      const parts = hms.split(":").map(Number);
      const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] || 0, parts[1] || 0];
      const ms = Number(String(msPart || "0").slice(0, 3).padEnd(3, "0"));
      return ((h * 3600 + m * 60 + s) * 1000) + ms;
    } catch { return 0; }
  }

  function msToTs(ms) {
    let rem = Math.max(0, Math.floor(ms));
    const h = Math.floor(rem / 3600000); rem %= 3600000;
    const m = Math.floor(rem / 60000); rem %= 60000;
    const s = Math.floor(rem / 1000);
    const milli = rem % 1000;
    return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") + "," + String(milli).padStart(3, "0");
  }

  function parseAndReconstructSrt(rawText) {
    const blocks = String(rawText || "").replace(/^\uFEFF/, "").trim().split(/\r?\n\r?\n+/);
    const parsed = [];
    for (const b of blocks) {
      const lines = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      let tsIdx = -1;
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        if (lines[i].includes("-->")) { tsIdx = i; break; }
      }
      if (tsIdx < 0) continue;
      const tsParts = lines[tsIdx].split("-->");
      if (tsParts.length < 2) continue;
      const startMs = tsToMs(tsParts[0]);
      const endMs = tsToMs(tsParts[1].trim().split(/\s+/)[0]);
      if (endMs - startMs < 140) continue;

      const textLines = [];
      for (let i = tsIdx + 1; i < lines.length; i++) {
        const txtArea = document.createElement("textarea");
        txtArea.innerHTML = lines[i].replace(/<[^>]+>/g, " ").replace(/\{\\[^}]+\}/g, " ");
        const cl = txtArea.value.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
        if (cl && !/^(WEBVTT|Kind:|Language:)/i.test(cl)) {
          if (!textLines.length || textLines[textLines.length - 1] !== cl) textLines.push(cl);
        }
      }
      if (textLines.length) parsed.push([startMs, endMs, textLines]);
    }

    const deduped = [];
    const recent = [];
    for (const [startMs, endMs, tLines] of parsed) {
      const newLines = [];
      for (const ln of tLines) {
        const norm = ln.replace(/\s+/g, " ").trim().toLowerCase();
        if (!recent.includes(norm)) {
          newLines.push(ln);
          recent.push(norm);
          if (recent.length > 6) recent.shift();
        }
      }
      if (!newLines.length) {
        if (deduped.length && startMs - deduped[deduped.length - 1][1] <= 500) {
          deduped[deduped.length - 1][1] = Math.max(deduped[deduped.length - 1][1], endMs);
        }
        continue;
      }
      const joined = newLines.join(" ").trim();
      if (deduped.length && deduped[deduped.length - 1][2].toLowerCase() === joined.toLowerCase()) {
        deduped[deduped.length - 1][1] = Math.max(deduped[deduped.length - 1][1], endMs);
      } else {
        deduped.push([startMs, endMs, joined]);
      }
    }

    for (let i = 0; i < deduped.length - 1; i++) {
      const [, curE, curTxt] = deduped[i];
      const [nxtS, , nxtTxt] = deduped[i + 1];
      if (nxtS - curE > 2000 || /[.!?:;]$/.test(curTxt)) continue;
      if (ADJ_PULL_RX.test(curTxt)) {
        const nxtWords = nxtTxt.split(/\s+/);
        if (nxtWords.length >= 2) {
          deduped[i][2] = (curTxt + " " + nxtWords[0]).trim();
          deduped[i + 1][2] = nxtWords.slice(1).join(" ").trim();
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const m = deduped[i][2].match(TRAILING_SPLIT_RX);
        if (m && m[1].trim().length >= 6) {
          deduped[i][2] = m[1].trim();
          deduped[i + 1][2] = (m[2].trim() + " " + deduped[i + 1][2]).trim();
        } else break;
      }
    }

    const merged = [];
    let i = 0;
    while (i < deduped.length) {
      let [curS, curE, curTxt] = deduped[i];
      if (!curTxt.trim()) { i++; continue; }
      while (i + 1 < deduped.length) {
        const [nxtS, nxtE, nxtTxt] = deduped[i + 1];
        const comb = (curTxt + " " + nxtTxt).trim();
        if (nxtS - curE <= 450 && nxtE - curS <= 6500 && comb.length <= 88) {
          curE = nxtE; curTxt = comb; i++;
        } else break;
      }
      merged.push([curS, curE, curTxt]);
      i++;
    }
    return merged;
  }

  async function translateSingleCueJS(text) {
    for (const clientName of ["gtx", "dict-chrome-ex"]) {
      try {
        const res = await fetch(
          "https://translate.googleapis.com/translate_a/single?client=" + clientName + "&sl=auto&tl=iw&dt=t&dj=1",
          { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ q: text }).toString() }
        );
        if (res.ok) {
          const data = await res.json();
          const tr = ((data && data.sentences) || []).map((s) => (s && s.trans) || "").join(" ").trim();
          if (tr && hasHebrew(tr)) return tr;
        }
      } catch {}
    }
    return text;
  }

  async function translateBatchGuaranteedJS(batchCues) {
    const joined = batchCues.map((c) => c[2].replace(/\r?\n/g, " ").trim()).join("\n");
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const clientName of ["gtx", "dict-chrome-ex"]) {
        try {
          const res = await fetch(
            "https://translate.googleapis.com/translate_a/single?client=" + clientName + "&sl=auto&tl=iw&dt=t&dj=1",
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ q: joined }).toString() }
          );
          if (res.ok) {
            const data = await res.json();
            const fullTrans = ((data && data.sentences) || []).map((s) => (s && s.trans) || "").join("").trim();
            const trLines = fullTrans.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            if (trLines.length === batchCues.length && hasHebrew(fullTrans)) {
              return batchCues.map((c, idx) => [c[0], c[1], trLines[idx]]);
            }
          } else if (res.status === 429) {
            await sleep(1400 * (attempt + 1));
          }
        } catch {}
      }
      await sleep(400);
    }
    const out = [];
    for (const c of batchCues) {
      out.push([c[0], c[1], await translateSingleCueJS(c[2])]);
      await sleep(70);
    }
    return out;
  }

  el("translateLocalSrtBtn").onclick = async () => {
    const files = el("localSrtInput").files ? Array.from(el("localSrtInput").files) : [];
    if (!files.length) {
      el("srtTransProgWrap").style.display = "flex";
      el("srtTransStatus").textContent = "נא לבחור קובץ כתוביות (.srt או .vtt) תחילה.";
      return;
    }
    const btn = el("translateLocalSrtBtn");
    btn.disabled = true;
    el("srtTransProgWrap").style.display = "flex";
    try {
      for (const file of files) {
        el("srtTransProgBar").style.width = "5%";
        el("srtTransStatus").textContent = "מאחד משפטים: " + file.name;
        const cleanCues = parseAndReconstructSrt(await file.text());
        if (!cleanCues.length) {
          el("srtTransStatus").textContent = "לא נמצאו כתוביות תקינות בקובץ.";
          continue;
        }
        const batchSize = 35;
        const batches = [];
        for (let i = 0; i < cleanCues.length; i += batchSize) batches.push(cleanCues.slice(i, i + batchSize));
        const translatedCues = new Array(batches.length);
        let done = 0;
        const worker = async (wId) => {
          for (let bIdx = wId; bIdx < batches.length; bIdx += 2) {
            translatedCues[bIdx] = await translateBatchGuaranteedJS(batches[bIdx]);
            done++;
            const pct = Math.round((done / batches.length) * 100);
            el("srtTransProgBar").style.width = pct + "%";
            el("srtTransStatus").textContent = `מתרגם לעברית: ${pct}% (${Math.min(cleanCues.length, done * batchSize)} / ${cleanCues.length})`;
            await sleep(200);
          }
        };
        await Promise.all([worker(0), worker(1)]);
        const flatCues = translatedCues.flat();
        const formatRtlCue = (rawStr) => {
          const ta = document.createElement("textarea");
          ta.innerHTML = String(rawStr || "");
          const clean = ta.value.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
          if (!hasHebrew(clean)) return clean;
          if (clean.length > 46 && clean.includes(" ")) {
            const words = clean.split(" ");
            const mid = Math.floor(clean.length / 2);
            let cur = 0, splitIdx = 1;
            for (let w = 0; w < words.length; w++) {
              cur += words[w].length + 1;
              if (cur >= mid) { splitIdx = Math.max(1, w + 1); break; }
            }
            if (splitIdx < words.length) {
              return "\u202B\u200F" + words.slice(0, splitIdx).join(" ") + "\u200F\u202C\r\n\u202B\u200F" + words.slice(splitIdx).join(" ") + "\u200F\u202C";
            }
          }
          return "\u202B\u200F" + clean + "\u200F\u202C";
        };
        const outSrt = "\uFEFF" + flatCues.map((c, idx) => `${idx + 1}\r\n${msToTs(c[0])} --> ${msToTs(c[1])}\r\n${formatRtlCue(c[2])}`).join("\r\n\r\n") + "\r\n";
        const blobUrl = URL.createObjectURL(new Blob([outSrt], { type: "text/plain;charset=utf-8" }));
        const outName = file.name.replace(/\.(en-orig|en|iw|he)?\.(srt|vtt|txt)$/i, "") + ".he.srt";
        const a = document.createElement("a");
        a.href = blobUrl; a.download = outName; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        el("srtTransProgBar").style.width = "100%";
        el("srtTransStatus").textContent = `✓ הושלם ונשמר: ${outName} (${flatCues.length} משפטים)`;
      }
    } catch (err) {
      el("srtTransStatus").textContent = "שגיאה בתרגום: " + err.message;
    } finally {
      btn.disabled = false;
    }
  };

  // --------------------------------------------------------------------------
  // רענון תקופתי
  // --------------------------------------------------------------------------
  async function refresh() {
    const prefs = await chrome.runtime.sendMessage({ type: "GET_PREFS" });
    el("conn-dot").className = "dot " + (prefs && prefs.configured ? "is-ok" : "is-fail");
    el("conn-text").textContent = prefs && prefs.configured ? ("מחובר אל " + prefs.owner + "/" + prefs.repo) : "לא מוגדר — לחץ על הגדרות";
    if (prefs && prefs.emailTo && !el("emailToInput").value) el("emailToInput").value = prefs.emailTo;

    const res = await chrome.runtime.sendMessage({ type: "LIST_JOBS" });
    if (res && res.jobs) renderJobs(res.jobs);

    const recRes = await chrome.runtime.sendMessage({ type: "GET_RECOMMENDATIONS" });
    if (recRes && recRes.ok) {
      lastHistory = recRes.history || [];
      renderRecommendations(recRes.sessions || {}, lastHistory, false);
      renderHistoryArchive(lastHistory);
    }
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "JOBS_CHANGED") renderJobs(m.jobs);
    if (m && m.type === "RECS_CHANGED") void refresh();
  });
  setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  void refresh();
})();
