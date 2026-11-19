"use strict";
(() => {
  const el = (id) => document.getElementById(id);
  const H = self.YTUltra || {};
  const STORAGE_KEYS = {
    aiPrompt: "ytproxy_ai_filter_prompt",
    autoEmail: "ytproxy_send_email_enabled",
    autoDrive: "ytproxy_upload_drive_enabled",
    autoDriveOnly: "ytproxy_drive_only_enabled",
    activeTab: "ytproxy_active_tab",
    netfreeNoThumbs: "ytproxy_netfree_no_thumbs",
    searchLangs: "ytproxy_search_langs"
  };

  let currentPreview = null, lastPreviewVid = "", previewDebounce = null;
  const selectedRecUrls = new Set();
  let activeSessionId = "", lastSessionsMap = {}, lastHistory = [];
  let lastRecRenderSig = "", lastHistRenderSig = "", lastJobsRenderSig = "";
  let toastTimer = null, bgTranslateRunId = 0;

  function showToast(msg, isErr = false) {
    const t = el("v15QuickStatus");
    if (!t) return;
    clearTimeout(toastTimer);
    t.textContent = msg;
    t.className = "toast-bar" + (isErr ? " is-err" : "");
    if (msg) toastTimer = setTimeout(() => { t.textContent = ""; t.className = "toast-bar"; }, 4200);
  }

  function switchTab(tabName) {
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tabName));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("is-active", p.id === "pane-" + tabName));
    chrome.storage.local.set({ [STORAGE_KEYS.activeTab]: tabName }).catch(() => {});
  }
  document.querySelectorAll(".nav-tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  if (el("goToQueueBtn")) el("goToQueueBtn").onclick = () => switchTab("queue");

  const formatSelect = el("formatSelect");
  for (const p of self.YTPROXY_PRESETS || []) {
    const o = document.createElement("option");
    o.value = p.quality; o.textContent = p.label; formatSelect.append(o);
  }

  function getSelectedSearchLangs() {
    const wrap = el("searchLangsWrap");
    if (!wrap) return ["he", "en", "es"];
    const checked = Array.from(wrap.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.value);
    return checked.length ? checked : ["he", "en", "es"];
  }
  if (el("searchLangsWrap")) el("searchLangsWrap").addEventListener("change", () => chrome.storage.local.set({ [STORAGE_KEYS.searchLangs]: getSelectedSearchLangs() }).catch(() => {}));

  function syncDriveEmailUi() {
    const drv = el("driveToggle").checked, em = el("emailToggle").checked;
    el("driveOnlyWrap").style.display = drv ? "inline-flex" : "none";
    if (!drv) el("driveOnlyToggle").checked = false;
    el("emailInputWrap").style.display = (drv || em) ? "block" : "none";
  }

  // טעינת העדפות — מתג סינון ה-AI תמיד מופעל כברירת מחדל!
  chrome.storage.local.get(Object.values(STORAGE_KEYS)).then((d) => {
    if (!d) return;
    if (d[STORAGE_KEYS.activeTab]) switchTab(d[STORAGE_KEYS.activeTab]);
    if (d[STORAGE_KEYS.aiPrompt] && el("recFilterPromptInput")) el("recFilterPromptInput").value = d[STORAGE_KEYS.aiPrompt];
    el("recUseAiFilterToggle").checked = true;
    el("aiFilterWrap").style.display = "flex";
    if (d[STORAGE_KEYS.autoEmail] !== undefined) el("emailToggle").checked = Boolean(d[STORAGE_KEYS.autoEmail]);
    if (d[STORAGE_KEYS.autoDrive] !== undefined) el("driveToggle").checked = Boolean(d[STORAGE_KEYS.autoDrive]);
    if (d[STORAGE_KEYS.autoDriveOnly] !== undefined) el("driveOnlyToggle").checked = Boolean(d[STORAGE_KEYS.autoDriveOnly]);
    syncDriveEmailUi();
    if (d[STORAGE_KEYS.netfreeNoThumbs] !== undefined) {
      el("netfreeNoThumbsToggle").checked = Boolean(d[STORAGE_KEYS.netfreeNoThumbs]);
      document.body.classList.toggle("netfree-no-thumbs", el("netfreeNoThumbsToggle").checked);
    }
    if (Array.isArray(d[STORAGE_KEYS.searchLangs]) && d[STORAGE_KEYS.searchLangs].length) {
      const s = new Set(d[STORAGE_KEYS.searchLangs]);
      el("searchLangsWrap").querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = s.has(cb.value); });
    }
  }).catch(() => {});

  el("netfreeNoThumbsToggle").addEventListener("change", () => {
    const on = el("netfreeNoThumbsToggle").checked;
    document.body.classList.toggle("netfree-no-thumbs", on);
    chrome.storage.local.set({ [STORAGE_KEYS.netfreeNoThumbs]: on }).catch(() => {});
  });
  el("recUseAiFilterToggle").addEventListener("change", () => {
    el("aiFilterWrap").style.display = el("recUseAiFilterToggle").checked ? "flex" : "none";
  });
  el("recFilterPromptInput").addEventListener("change", () => {
    const v = el("recFilterPromptInput").value.trim();
    if (v) chrome.storage.local.set({ [STORAGE_KEYS.aiPrompt]: v }).catch(() => {});
  });
  for (const [id, key] of [["emailToggle", STORAGE_KEYS.autoEmail], ["driveToggle", STORAGE_KEYS.autoDrive], ["driveOnlyToggle", STORAGE_KEYS.autoDriveOnly]]) {
    el(id).addEventListener("change", () => {
      syncDriveEmailUi();
      chrome.storage.local.set({ [key]: el(id).checked }).catch(() => {});
    });
  }

  el("settingsBtn").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  el("cleanCloudBtn").onclick = async () => {
    el("cleanCloudBtn").disabled = true;
    showToast("⏳ מוחק את כל הריצות וה-Releases מהמאגר...");
    try {
      const res = await chrome.runtime.sendMessage({ type: "PURGE_ALL_CLOUD" });
      showToast(res && res.ok ? `✅ נמחקו ${res.deletedReleases || 0} Releases ו-${res.deletedRuns || 0} ריצות!` : "❌ שגיאה במחיקה", !(res && res.ok));
    } catch (e) { showToast("❌ שגיאה: " + e.message, true); }
    finally { el("cleanCloudBtn").disabled = false; }
  };
  el("copyGhTokenBtn").onclick = async () => {
    const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!cfg || !cfg.token) return showToast("❌ לא נמצא טוקן", true);
    await navigator.clipboard.writeText(cfg.token.trim()); showToast("✅ ה-GitHub Token הועתק!");
  };
  el("copyYtCookiesEncBtn").onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
    if (res && res.ok && res.encrypted) { await navigator.clipboard.writeText(res.encrypted); showToast("✅ העוגיות המוצפנות הועתקו!"); }
    else showToast("❌ שגיאה בהצפנת עוגיות", true);
  };

  function initSportsHub() {
    const catSel = el("v15HubCatSelect"), chSel = el("v15HubChannelSelect"), quickBar = el("v15QuickChannelsBar");
    const allCh = H.ALL_CHANNELS || [];
    const populate = () => {
      const list = catSel.value === "all" ? allCh : allCh.filter((x) => x.cat === catSel.value);
      chSel.replaceChildren();
      const d = document.createElement("option"); d.value = ""; d.textContent = `-- בחר ערוץ (${list.length}) --`; chSel.append(d);
      for (const x of list) { const o = document.createElement("option"); o.value = x.handle; o.textContent = `${x.label} (${x.handle})`; chSel.append(o); }
      quickBar.replaceChildren();
      const lbl = document.createElement("span"); lbl.className = "small muted"; lbl.style.fontWeight = "700"; lbl.textContent = "⚡ בחירה מהירה:"; quickBar.append(lbl);
      for (const x of list.slice(0, 14)) {
        const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.style.cssText = "padding:3px 10px;font-size:11.5px;border-radius:999px;";
        b.textContent = x.label.replace(/^[^\s]+\s*/, "").replace(/\s*\([^)]*\)/g, "").trim();
        b.onclick = () => { chSel.value = x.handle; el("recChannelInput").value = x.handle; showToast(`📺 נבחר הערוץ ${x.handle}`); };
        quickBar.append(b);
      }
    };
    catSel.addEventListener("change", populate);
    chSel.addEventListener("change", () => { if (chSel.value) el("recChannelInput").value = chSel.value; });
    populate();
    el("v15LoadChannelPlaylistBtn").onclick = () => { const h = chSel.value || el("recChannelInput").value.trim(); if (!h) return showToast("❌ בחר ערוץ תחילה", true); el("recChannelInput").value = h; el("findRecsBtn").click(); };
    el("v15SendChannelToTopBtn").onclick = () => { const h = chSel.value || el("recChannelInput").value.trim(); if (!h) return showToast("❌ בחר ערוץ תחילה", true); const sfx = el("v15HubPlaylistMode").value === "streams" ? "/streams" : "/videos"; el("urlInput").value = h.startsWith("http") ? h : ("https://www.youtube.com/" + h + sfx); el("collectionToggle").checked = true; switchTab("download"); };
  }
  initSportsHub();

  el("clearChannelBtn").onclick = () => { el("recChannelInput").value = ""; el("v15HubChannelSelect").value = ""; };
  el("clearQueryBtn").onclick = () => { el("recQueryInput").value = ""; };
  el("resetSearchFiltersBtn").onclick = () => {
    el("recChannelInput").value = ""; el("recQueryInput").value = ""; el("v15HubChannelSelect").value = "";
    el("recSortBySelect").value = "relevance"; el("recContentTypeSelect").value = "all"; el("recDurationSelect").value = "all";
    el("recSeasonSelect").value = "all"; el("v15HubPlaylistMode").value = "auto"; el("recMinViewsSelect").value = "0";
    el("recMaxResultsSelect").value = "60"; el("recExcludeWordsInput").value = ""; el("recHighQualityOnlyToggle").checked = false;
    el("recExpandQueriesToggle").checked = true; el("recNoGamingToggle").checked = true; el("recUseAiFilterToggle").checked = true;
    el("aiFilterWrap").style.display = "flex"; el("liveRecSearchInput").value = ""; applyLiveClientFilters();
    showToast("🔄 כל השדות אופסו (AI פעיל)");
  };

  async function updateInstantPreview(rawVal) {
    const vid = H.extract11Id ? H.extract11Id(rawVal) : "";
    const box = el("videoPreview"), thumb = el("previewThumb"), titleEl = el("previewTitle"), authorEl = el("previewAuthor");
    if (!vid) { box.style.display = "none"; currentPreview = null; lastPreviewVid = ""; return; }
    if (vid === lastPreviewVid && box.style.display !== "none") return;
    lastPreviewVid = vid; box.style.display = "flex";
    titleEl.textContent = "⏳ טוען פרטי סרטון (" + vid + ")..."; authorEl.textContent = "מזהה: " + vid;
    thumb.onerror = () => { if (self.NETFREE_SAFE_THUMB_SVG && thumb.src !== self.NETFREE_SAFE_THUMB_SVG) thumb.src = self.NETFREE_SAFE_THUMB_SVG; };
    thumb.src = "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg";
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ context:{client:{clientName:"WEB",clientVersion:"2.20261101.00.00",hl:"he",gl:"IL"}}, videoId:vid }) });
      if (res.ok) {
        const data = await res.json(), vd = data.videoDetails || {}, mf = (data.microformat && data.microformat.playerMicroformatRenderer) || {};
        if (vd.title) {
          let titleTxt = vd.title;
          if (el("translateTitleDlToggle").checked && H.translateSingleToHebrew) titleTxt = await H.translateSingleToHebrew(titleTxt);
          currentPreview = { title: titleTxt, author: vd.author || "", thumbnail: thumb.src };
          titleEl.textContent = titleTxt;
          authorEl.textContent = [vd.author, (mf.publishDate||"").split("T")[0] ? "📅 "+(mf.publishDate||"").split("T")[0] : "", vd.viewCount ? "👁 "+formatNumber(vd.viewCount) : "", vd.lengthSeconds ? "⏱ "+formatDuration(vd.lengthSeconds) : "", "🆔 "+vid].filter(Boolean).join(" • ");
        }
      }
    } catch {}
  }

  const urlInput = el("urlInput");
  const handleUrlChange = () => {
    clearTimeout(previewDebounce);
    const raw = urlInput.value.trim(), vid = H.extract11Id ? H.extract11Id(raw) : "";
    if (vid && !raw.startsWith("http") && raw.split(/[\s,]+/).length === 1) urlInput.value = "https://www.youtube.com/watch?v=" + vid;
    previewDebounce = setTimeout(() => updateInstantPreview(urlInput.value.trim()), 260);
  };
  urlInput.addEventListener("input", handleUrlChange);
  urlInput.addEventListener("paste", () => setTimeout(handleUrlChange, 30));

  function getActiveDownloadOptions(forceSubsOnly = false, fromRecList = false) {
    let qVal = forceSubsOnly ? "subs_only" : formatSelect.value;
    let sVal = (forceSubsOnly || qVal === "subs_only") ? "only" : el("subsSelect").value;
    if (fromRecList && !forceSubsOnly) {
      const listSub = el("v15ListSubsSelect").value;
      if (listSub !== "default") { sVal = listSub; if (listSub === "only") qVal = "subs_only"; }
    }
    const useDrive = fromRecList ? (el("listDriveToggle").checked || el("driveToggle").checked) : el("driveToggle").checked;
    return {
      quality: sVal === "only" ? "subs_only" : qVal, subtitles: sVal,
      clipStart: el("clipStart").value.trim(), clipEnd: el("clipEnd").value.trim(),
      geoCountry: el("geoSelect").value, speedFactor: el("speedSelect").value,
      sponsorblock: el("sponsorToggle").checked, splitChapters: el("chaptersToggle").checked,
      normalizeAudio: el("normToggle").checked,
      sendEmail: el("emailToggle").checked, emailTo: el("emailToInput").value.trim(),
      uploadDrive: useDrive, driveOnly: useDrive && el("driveOnlyToggle").checked
    };
  }

  async function dispatchDownload(payload) {
    if (payload.url && H.normalizeYtInputValue) payload.url = H.normalizeYtInputValue(payload.url);
    if (payload.title && H.polishSportsHebrew) payload.title = H.polishSportsHebrew(payload.title);
    return chrome.runtime.sendMessage({ type: "START_DOWNLOAD", payload });
  }

  async function triggerDownloadFromInput(forceSubsOnly = false) {
    const raw = urlInput.value.trim();
    if (!raw) { el("hint").textContent = "נא להדביק קישור תחילה"; return; }
    const norm = H.normalizeYtInputValue ? H.normalizeYtInputValue(raw) : raw;
    const urls = norm.split(/[\s,]+/).filter((u) => u.startsWith("http"));
    if (!urls.length) { el("hint").textContent = "נא להזין קישור תקין או מזהה 11 תווים"; return; }
    const baseOpts = { ...getActiveDownloadOptions(forceSubsOnly, false), title: (currentPreview && currentPreview.title) || urls[0], thumbnail: (currentPreview && currentPreview.thumbnail) || "" };
    const payload = urls.length > 1 ? { ...baseOpts, urls, mode: "list" } : { ...baseOpts, url: urls[0], mode: el("collectionToggle").checked ? "collection" : "video" };
    el("hint").textContent = "שולח בקשה ל-GitHub Actions...";
    const res = await dispatchDownload(payload);
    if (res && res.ok) {
      urlInput.value = ""; el("videoPreview").style.display = "none"; currentPreview = null; lastPreviewVid = "";
      el("hint").textContent = baseOpts.driveOnly ? "✓ נשלח להעלאה ישירה ל-Google Drive!" : "✓ נשלח! ניתן לעקוב בפס ההורדות למעלה.";
      showToast(baseOpts.uploadDrive ? "☁️ נשלח להעלאה ל-Google Drive!" : "🚀 ההורדה נשלחה לענן!");
      void refresh();
    } else el("hint").textContent = (res && res.error) || "שגיאה בשליחה";
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
    switchTab("search"); el("recChannelInput").value = ""; el("recQueryInput").value = "SIMILAR:" + vid11;
    showToast(`🔍 מחפש סרטונים דומים עבור: ${label || vid11}...`);
    el("findRecsBtn").click();
    setTimeout(() => { if (el("recQueryInput").value.startsWith("SIMILAR:")) el("recQueryInput").value = ""; }, 350);
  }

  function runSuggestedSearch(term) {
    switchTab("search");
    el("recChannelInput").value = "";
    el("recQueryInput").value = term;
    el("findRecsBtn").click();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasHebrew = (s) => /[\u0590-\u05FF]/.test(String(s || ""));
  const formatNumber = (n) => Number(n || 0).toLocaleString("he-IL");
  function formatDuration(sec) { const s = Math.max(0, Math.floor(Number(sec || 0))); if (!s) return ""; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}` : `${m}:${String(r).padStart(2,"0")}`; }
  function formatUploadDate(ymd) { const str = String(ymd || "").trim(); return /^\d{8}$/.test(str) ? `${str.slice(6,8)}/${str.slice(4,6)}/${str.slice(0,4)}` : ""; }
  function extractTopicsFromHistory(historyList) {
    const seen = new Set(), topics = [];
    for (const item of historyList || []) {
      const cleaned = String(item.title || "").replace(/\[[a-zA-Z0-9_-]{11}\]/g, "").replace(/\.(mp4|mp3|mkv|flac|wav|m4a|opus|srt)$/i, "").replace(/[|•\-–—_()\[\]]+/g, " ").replace(/\s+/g, " ").trim();
      if (!cleaned || cleaned.length < 4) continue;
      const words = cleaned.split(" ").slice(0, 4).join(" "), key = words.toLowerCase();
      if (!seen.has(key)) { seen.add(key); topics.push(words); }
      if (topics.length >= 6) break;
    }
    return topics;
  }

  function getVisibleRecItems() { return Array.from(el("recList").children).filter((c) => c.style.display !== "none"); }
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
    const cards = Array.from(el("recList").children);
    if (!cards.length) return;
    const durMode = el("recDurationSelect").value || "all", minViews = Number(el("recMinViewsSelect").value || 0);
    const hqOnly = Boolean(el("recHighQualityOnlyToggle").checked), liveSearch = (el("liveRecSearchInput").value || "").trim().toLowerCase();
    const excludeWords = (el("recExcludeWordsInput").value || "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    const activeRec = activeSessionId ? lastSessionsMap[activeSessionId] : null;
    const expectedCh = (activeRec && activeRec.channel && !String(activeRec.channel).startsWith("http") && !String(activeRec.channel).startsWith("@")) ? String(activeRec.channel).trim().toLowerCase() : "";
    let visibleCount = 0;
    for (const card of cards) {
      const totalSec = Number(card.dataset.duration || 0), mins = totalSec / 60, views = Number(card.dataset.views || 0);
      const cardCh = (card.dataset.channel || "").toLowerCase(), searchText = (card.dataset.search || "").toLowerCase();
      let show = true;
      if (durMode === "no_shorts" && totalSec > 0 && totalSec <= 60) show = false;
      else if (durMode === "clips" && totalSec > 0 && (totalSec < 60 || mins > 20)) show = false;
      else if (durMode === "long" && totalSec > 0 && mins < 20) show = false;
      else if (durMode === "short5" && totalSec > 0 && mins > 5) show = false;
      if (show && expectedCh && cardCh && !cardCh.includes(expectedCh) && !expectedCh.includes(cardCh)) show = false;
      if (show && hqOnly && totalSec > 0 && totalSec < 65) show = false;
      if (show && minViews > 0 && views < minViews) show = false;
      if (show && liveSearch && !searchText.includes(liveSearch)) show = false;
      if (show && excludeWords.length && excludeWords.some((w) => searchText.includes(w))) show = false;
      card.style.display = show ? "flex" : "none";
      if (show) visibleCount++;
    }
    const st = el("recStatusText"), base = st.dataset.baseText || "";
    if (base) st.textContent = visibleCount < cards.length ? `${base} — מוצגות ${visibleCount} מתוך ${cards.length}` : base;
  }

  for (const id of ["recDurationSelect","recMinViewsSelect","recHighQualityOnlyToggle","liveRecSearchInput","recExcludeWordsInput"]) {
    el(id).addEventListener("change", applyLiveClientFilters); el(id).addEventListener("input", applyLiveClientFilters);
  }

  el("findRecsBtn").onclick = async () => {
    const channel = el("recChannelInput").value.trim(), query = el("recQueryInput").value.trim();
    if (!channel && !query) return showToast("❌ נא להזין נושא לחיפוש או לבחור ערוץ", true);
    const useAi = el("recUseAiFilterToggle").checked, rawPrompt = el("recFilterPromptInput").value.trim();
    if (rawPrompt) chrome.storage.local.set({ [STORAGE_KEYS.aiPrompt]: rawPrompt }).catch(() => {});

    const tags = ["[LANGS:" + getSelectedSearchLangs().join(",") + "]"];
    if (el("recExpandQueriesToggle").checked) tags.push("[EXPAND]");
    if (el("recNoGamingToggle").checked) tags.push("[NO_GAMING]");
    const cType = el("recContentTypeSelect").value || "all";
    if (cType !== "all") tags.push("[CTYPE:" + cType.toUpperCase() + "]");
    const exclRaw = (el("recExcludeWordsInput").value || "").trim();
    if (exclRaw) { const enc = exclRaw.split(",").map((w) => encodeURIComponent(w.trim())).filter(Boolean).join(","); if (enc) tags.push("[EXCL:" + enc + "]"); }
    if (el("recHighQualityOnlyToggle").checked) tags.push("[HQ_ONLY]");
    if (el("recTranslateTitlesToggle").checked) tags.push("[TR_HE]");
    const plMode = el("v15HubPlaylistMode").value || "auto";
    if (plMode === "uu_all") tags.push("[PL_UU]"); else if (plMode === "streams") tags.push("[PL_STREAMS]"); else if (plMode === "uulp") tags.push("[PL_UULP]");
    const durMode = el("recDurationSelect").value || "all"; if (durMode !== "all") tags.push("[DUR:" + durMode.toUpperCase() + "]");
    const isSim = query.toUpperCase().startsWith("SIMILAR:"), seasonMode = el("recSeasonSelect").value || "all";
    if (seasonMode !== "all" && !isSim) tags.push("[SEASON:" + seasonMode.toUpperCase() + "]");

    const btn = el("findRecsBtn"); btn.disabled = true; selectedRecUrls.clear(); el("recStatusText").dataset.baseText = "";
    try {
      if (H.harvestLocalIsraeliIds && !isSim) {
        el("recStatusText").textContent = "🌐 אוסף מזהים מקומיים מישראל לפני השליחה לענן...";
        const ilIds = await H.harvestLocalIsraeliIds(channel, query, seasonMode);
        if (ilIds.length > 0) tags.push("[IL_IDS:" + ilIds.slice(0, 180).join(",") + "]");
      }
      const cleanPrompt = useAi ? (rawPrompt.replace(/\[[A-Z0-9_,:%-]+\]/gi, "").trim() || "הבא רק תוצאות איכותיות ורלוונטיות ישירות לחיפוש") : "";
      el("recStatusText").textContent = "🚀 משגר חיפוש רב-לשוני + Gemini 3.5 Flash-Lite ל-GitHub Actions...";
      const res = await chrome.runtime.sendMessage({
        type: "START_RECOMMEND",
        payload: { query, channel, sortBy: el("recSortBySelect").value || "relevance", maxResults: el("recMaxResultsSelect").value || "60", minViews: el("recMinViewsSelect").value || "0", filterPrompt: (cleanPrompt + " " + tags.join(" ")).trim() }
      });
      if (!res || !res.ok) { el("recStatusText").textContent = (res && res.error) || "שגיאה בהפעלת החיפוש"; showToast("❌ שגיאה בשיגור החיפוש", true); }
      else { activeSessionId = res.requestId; lastRecRenderSig = ""; showToast("🔍 החיפוש החכם שוגר לענן!"); void refresh(); }
    } finally { btn.disabled = false; }
  };

  el("clearDoneRecsBtn").onclick = async () => { await chrome.runtime.sendMessage({ type: "CLEAR_DONE_REC_SESSIONS" }); lastRecRenderSig = ""; void refresh(); };
  el("copyRecLogBtn").onclick = (ev) => { ev.stopPropagation(); navigator.clipboard.writeText(el("recDebugLog").textContent || "").catch(() => {}); el("copyRecLogBtn").textContent = "✓ הועתק"; setTimeout(() => { el("copyRecLogBtn").textContent = "📋 העתק"; }, 1500); };

  async function runBatchedClientTranslation(cardsToTranslate, notify = false) {
    if (!cardsToTranslate.length || !H.translateTitlesBatchToHebrew) return;
    const myRunId = ++bgTranslateRunId;
    if (notify) showToast(`⏳ מתרגם ${cardsToTranslate.length} כותרות ל-100% עברית...`);
    const sources = cardsToTranslate.map((c) => c.dataset.origTitle || c.querySelector(".vid-card__title").textContent);
    const translated = await H.translateTitlesBatchToHebrew(sources);
    if (myRunId !== bgTranslateRunId && !notify) return;
    cardsToTranslate.forEach((card, idx) => {
      const he = translated[idx], titleNode = card.querySelector(".vid-card__title");
      if (he && titleNode && titleNode.isConnected) {
        titleNode.textContent = he;
        card.dataset.search = `${he} ${card.dataset.origTitle || ""} ${card.dataset.channel || ""}`.toLowerCase();
      }
    });
    if (notify) showToast("✅ כל הכותרות תורגמו לעברית מלאה!");
  }
  el("translateVisibleRecsBtn").onclick = () => runBatchedClientTranslation(getVisibleRecItems(), true);

  function renderSuggestedSearches(activeRec) {
    const wrap = el("suggestedSearchesWrap"), chips = el("suggestedSearchesChips");
    const defaultSuggestions = ["לה מאסיה 2026", "ברצלונה נוער 2026/27", "אוריין גורן לה מאסיה", "תקצירי ברצלונה לה ליגה", "ליגת האלופות לנוער ברצלונה", "דני אבדיה NBA 2026", "משחקי קלאסיקו מלאים", "פודקאסט הפודיום 2026"];
    let suggs = (activeRec && Array.isArray(activeRec.suggestedSearches) && activeRec.suggestedSearches.length) ? [...activeRec.suggestedSearches] : (!activeRec ? [...defaultSuggestions] : []);
    const baseQ = (activeRec && activeRec.query && !String(activeRec.query).toUpperCase().startsWith("SIMILAR:")) ? String(activeRec.query).trim() : "";
    if (baseQ && !baseQ.includes("2026")) {
      const q26 = baseQ + " 2026";
      if (!suggs.some((x) => x.trim() === q26)) suggs.unshift(q26);
    }
    chips.replaceChildren();
    if (!suggs.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "flex";
    for (const s of suggs.slice(0, 16)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn suggest-chip"; b.textContent = "✨ " + s;
      b.onclick = () => runSuggestedSearch(s);
      chips.append(b);
    }
  }

  function renderRecommendations(sessionsMap, historyList, forceRender = false) {
    lastSessionsMap = sessionsMap || {};
    const sessions = Object.values(lastSessionsMap).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (!activeSessionId || !lastSessionsMap[activeSessionId]) activeSessionId = sessions.length ? sessions[0].requestId : "";
    const activeRec = activeSessionId ? lastSessionsMap[activeSessionId] : null;
    const sig = JSON.stringify({ activeSessionId, selCount: selectedRecUrls.size, histLen: (historyList || []).length, tabs: sessions.map((s) => [s.requestId, s.status, s.detail, (s.items || []).length, (s.logs || []).length]) });
    if (!forceRender && sig === lastRecRenderSig) return;
    lastRecRenderSig = sig;

    el("clearDoneRecsBtn").style.display = sessions.some((s) => s.status === "completed" || s.status === "failed") ? "inline-flex" : "none";
    const tabsWrap = el("recSessionsTabs"); tabsWrap.replaceChildren();
    if (sessions.length) {
      tabsWrap.style.display = "flex";
      for (const sess of sessions) {
        const pill = document.createElement("div"); pill.className = "sess-pill" + (sess.requestId === activeSessionId ? " is-active" : "");
        const icon = sess.status === "completed" ? `✓ (${(sess.items || []).length})` : sess.status === "failed" ? "✕" : "⏳";
        const lbl = document.createElement("span"); lbl.textContent = `${icon} ${sess.tabTitle || sess.channel || sess.query || "חיפוש"}`;
        lbl.onclick = () => { activeSessionId = sess.requestId; selectedRecUrls.clear(); renderRecommendations(lastSessionsMap, historyList, true); };
        const closeBtn = document.createElement("span"); closeBtn.className = "sess-pill__x"; closeBtn.textContent = "×";
        closeBtn.onclick = async (ev) => { ev.stopPropagation(); await chrome.runtime.sendMessage({ type: "REMOVE_REC_SESSION", requestId: sess.requestId }); if (activeSessionId === sess.requestId) activeSessionId = ""; lastRecRenderSig = ""; void refresh(); };
        pill.append(lbl, closeBtn); tabsWrap.append(pill);
      }
    } else tabsWrap.style.display = "none";

    renderSuggestedSearches(activeRec);

    const chipsWrap = el("topicChips"), topics = extractTopicsFromHistory(historyList); chipsWrap.replaceChildren();
    if (topics.length) {
      const lbl = document.createElement("span"); lbl.className = "small muted"; lbl.textContent = "נושאים אחרונים:"; chipsWrap.append(lbl);
      for (const t of topics) { const c = document.createElement("button"); c.type = "button"; c.className = "btn small"; c.style.cssText = "padding:3px 10px;font-size:11.5px;border-radius:999px;"; c.textContent = t; c.onclick = () => { el("recQueryInput").value = t; }; chipsWrap.append(c); }
    }

    const statusEl = el("recStatusText"), nextDetail = (activeRec && activeRec.detail) || "הזן נושא או ערוץ למעלה ולחץ על \"הפעל חיפוש חכם רב-לשוני בענן\".";
    statusEl.dataset.baseText = nextDetail; statusEl.textContent = nextDetail;
    statusEl.style.color = activeRec && activeRec.status === "failed" ? "var(--fail)" : (activeRec && activeRec.status === "completed" ? "var(--ok)" : "");

    const logWrap = el("recLogWrap"), logPre = el("recDebugLog"), openRunBtn = el("openRecRunBtn");
    const logs = (activeRec && Array.isArray(activeRec.logs)) ? activeRec.logs : [];
    if (logs.length) { logWrap.style.display = "block"; logPre.textContent = logs.join("\n"); logPre.scrollTop = logPre.scrollHeight; if (activeRec && activeRec.status === "failed") logWrap.open = true; }
    else logWrap.style.display = "none";
    if (activeRec && activeRec.runId) { openRunBtn.style.display = "inline-flex"; openRunBtn.onclick = (ev) => { ev.stopPropagation(); chrome.runtime.sendMessage({ type: "OPEN_REC_RUN", runId: activeRec.runId }); }; }
    else openRunBtn.style.display = "none";

    const recList = el("recList"); recList.replaceChildren();
    const items = (activeRec && activeRec.items) || [];
    updateBatchButtons(items.length);

    const selectVisibleN = (limit) => {
      selectedRecUrls.clear();
      for (const c of getVisibleRecItems().slice(0, limit)) if (c.dataset.url) selectedRecUrls.add(c.dataset.url);
      for (const c of Array.from(recList.children)) { const chk = c.querySelector(".vid-card__chk"); if (chk) chk.checked = selectedRecUrls.has(c.dataset.url); }
      updateBatchButtons(items.length);
    };
    el("selectTop30RecsBtn").onclick = () => selectVisibleN(30);
    el("selectTop100RecsBtn").onclick = () => selectVisibleN(100);
    el("selectAllRecsBtn").onclick = () => { const vis = getVisibleRecItems(); if (selectedRecUrls.size >= vis.length && vis.length) { selectedRecUrls.clear(); Array.from(recList.children).forEach((c) => { const k = c.querySelector(".vid-card__chk"); if (k) k.checked = false; }); updateBatchButtons(items.length); } else selectVisibleN(vis.length); };
    el("batchRecsBtn").onclick = async () => {
      if (!selectedRecUrls.size) return;
      const urls = Array.from(selectedRecUrls);
      const res = await dispatchDownload({ ...getActiveDownloadOptions(false, true), urls, title: `חבילת סרטונים (${urls.length})`, mode: "list" });
      if (res && res.ok) { selectedRecUrls.clear(); lastRecRenderSig = ""; showToast(`✅ נשלחו ${urls.length} סרטונים!`); void refresh(); }
    };

    const autoTrClient = el("recTranslateTitlesToggle").checked, cardsNeedingTr = [];
    items.forEach((item, idx) => {
      const vid11 = item.id || (H.extract11Id ? H.extract11Id(item.url) : "");
      const displayTitle = H.stripNoiseBeforeTranslate ? H.stripNoiseBeforeTranslate(item.title) : String(item.title || "");
      const origSource = item.orig_title || item.title || "";
      const cleanCh = String(item.channel || "").replace(/\s*•\s*📅\s*[^•]+/g, "").trim();
      const chNameOnly = cleanCh.split("•")[0].trim(), durStr = formatDuration(item.duration), dateStr = formatUploadDate(item.upload_date) || item.date_formatted || "";

      const card = document.createElement("div"); card.className = "vid-card";
      card.dataset.url = item.url || ""; card.dataset.duration = String(item.duration || 0); card.dataset.views = String(item.views || 0);
      card.dataset.channel = chNameOnly; card.dataset.origTitle = origSource;
      card.dataset.search = `${displayTitle} ${origSource} ${cleanCh} ${vid11}`.toLowerCase();

      const chk = document.createElement("input"); chk.type = "checkbox"; chk.className = "vid-card__chk"; chk.checked = selectedRecUrls.has(item.url);
      chk.onchange = () => { if (chk.checked) selectedRecUrls.add(item.url); else selectedRecUrls.delete(item.url); updateBatchButtons(items.length); };
      card.append(chk);

      const thumbWrap = document.createElement("div"); thumbWrap.className = "vid-card__thumb-wrap";
      const img = document.createElement("img"); img.className = "vid-card__thumb"; img.loading = "lazy"; img.alt = "";
      img.onerror = () => { if (self.NETFREE_SAFE_THUMB_SVG && img.src !== self.NETFREE_SAFE_THUMB_SVG) img.src = self.NETFREE_SAFE_THUMB_SVG; };
      img.src = item.thumbnail || (vid11 ? `https://i.ytimg.com/vi/${vid11}/hqdefault.jpg` : self.NETFREE_SAFE_THUMB_SVG);
      thumbWrap.append(img);
      if (durStr) { const db = document.createElement("span"); db.className = "vid-card__dur"; db.textContent = durStr; thumbWrap.append(db); }
      card.append(thumbWrap);

      const body = document.createElement("div"); body.className = "vid-card__body";
      const titleRow = document.createElement("div"); titleRow.className = "vid-card__title-row";
      const rank = document.createElement("span"); rank.className = "vid-card__rank"; rank.textContent = "#" + (idx + 1); titleRow.append(rank);
      if (item.ai_score) { const ab = document.createElement("span"); ab.className = "vid-card__ai-score"; ab.textContent = `⭐ ${item.ai_score}/10`; titleRow.append(ab); }
      const tEl = document.createElement("div"); tEl.className = "vid-card__title"; tEl.textContent = displayTitle; tEl.title = origSource; titleRow.append(tEl);
      if (autoTrClient && H.needsHebrewTranslation && H.needsHebrewTranslation(displayTitle)) cardsNeedingTr.push(card);

      const meta = document.createElement("div"); meta.className = "vid-card__meta";
      meta.textContent = [cleanCh ? "📺 "+cleanCh : "", "👁 "+formatNumber(item.views), item.likes ? "👍 "+formatNumber(item.likes) : "", dateStr ? "📅 "+dateStr : "", durStr ? "⏱ "+durStr : ""].filter(Boolean).join("  •  ");

      const actions = document.createElement("div"); actions.className = "vid-card__actions";
      const dlBtn = document.createElement("button"); dlBtn.type = "button"; dlBtn.className = "btn btn--primary"; dlBtn.textContent = "⬇ הורד";
      dlBtn.onclick = async () => { dlBtn.disabled = true; dlBtn.textContent = "שולח..."; const r = await dispatchDownload({ ...getActiveDownloadOptions(false, true), url: item.url, title: tEl.textContent, mode: "video" }); dlBtn.textContent = r && r.ok ? "✓ נשלח" : "✕ שגיאה"; void refresh(); };
      const drvBtn = document.createElement("button"); drvBtn.type = "button"; drvBtn.className = "btn btn--drive"; drvBtn.textContent = "☁️ ל-Drive";
      drvBtn.title = "העלה ישירות ל-Google Drive בלי להוריד למחשב";
      drvBtn.onclick = async () => { drvBtn.disabled = true; drvBtn.textContent = "מעלה..."; const r = await dispatchDownload({ ...getActiveDownloadOptions(false, true), url: item.url, title: tEl.textContent, uploadDrive: true, driveOnly: true, mode: "video" }); drvBtn.textContent = r && r.ok ? "✓ בדרך ל-Drive" : "✕ שגיאה"; void refresh(); };
      const subDlBtn = document.createElement("button"); subDlBtn.type = "button"; subDlBtn.className = "btn btn--ok"; subDlBtn.textContent = "🎬+📝 כתוביות";
      subDlBtn.onclick = async () => { subDlBtn.disabled = true; subDlBtn.textContent = "שולח..."; const r = await dispatchDownload({ ...getActiveDownloadOptions(false, false), url: item.url, title: tEl.textContent, subtitles: "embed", mode: "video" }); subDlBtn.textContent = r && r.ok ? "✓ נשלח" : "✕ שגיאה"; void refresh(); };
      actions.append(dlBtn, drvBtn, subDlBtn);

      if (vid11) {
        const simBtn = document.createElement("button"); simBtn.type = "button"; simBtn.className = "btn btn--accent-outline"; simBtn.textContent = "🔍 דומים"; simBtn.onclick = () => triggerSimilarSearch(vid11, tEl.textContent);
        const idBtn = document.createElement("button"); idBtn.type = "button"; idBtn.className = "btn"; idBtn.textContent = "🆔 " + vid11; idBtn.onclick = async () => { await navigator.clipboard.writeText(vid11); idBtn.textContent = "✅ הועתק"; setTimeout(() => { idBtn.textContent = "🆔 " + vid11; }, 1400); };
        actions.append(simBtn, idBtn);
      }
      body.append(titleRow, meta, actions); card.append(body); recList.append(card);
    });

    applyLiveClientFilters();
    if (cardsNeedingTr.length) void runBatchedClientTranslation(cardsNeedingTr, false);
  }

  function buildJobCard(j) {
    const isTerminal = ["completed","failed","cancelled"].includes(j.status);
    const elapsedSec = j.startedAt ? Math.max(0, Math.floor((Date.now() - j.startedAt) / 1000)) : 0;
    const elapsedLabel = (!isTerminal && elapsedSec > 0) ? (" • ⏱ " + formatDuration(elapsedSec)) : "";
    const card = document.createElement("div"); card.className = "job-card";
    const topRow = document.createElement("div"); topRow.className = "job-card__top";
    const title = document.createElement("div"); title.className = "job-card__title";
    title.textContent = String((j.files && j.files[0]) || j.title || j.url).replace(/[\u2066-\u2069]/g, "").replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]{2,5}$)/i, "");
    const badge = document.createElement("span"); badge.className = "small muted";
    const localPctStr = typeof j.localDlPct === "number" ? (" • למחשב: " + j.localDlPct + "%") : "";
    badge.textContent = j.actualQuality ? (`✓ ${j.actualQuality}${localPctStr} • ${j.percent || 0}%`) : (`יעד: ${j.quality === "subs_only" ? "כתוביות" : j.quality}${localPctStr} • ${j.percent || 0}%${elapsedLabel}`);
    if (j.actualQuality) { badge.style.color = "var(--ok)"; badge.style.fontWeight = "700"; }
    topRow.append(title, badge);
    const progTrack = document.createElement("div"); progTrack.className = "progress-track";
    const progBar = document.createElement("div"); progBar.className = "progress-bar"; if (j.status === "failed") progBar.style.background = "var(--fail)"; progBar.style.width = (j.percent || 5) + "%"; progTrack.append(progBar);
    const info = document.createElement("div"); info.className = "small muted"; info.textContent = j.detail || j.status;
    card.append(topRow, progTrack, info);

    if (j.tempPath || j.finalDiskPath) {
      const pathBox = document.createElement("div"); pathBox.className = "job-card__path"; pathBox.dir = "ltr";
      const cleanSaved = String(j.finalDiskPath || "").replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]+$)/i, "");
      pathBox.textContent = cleanSaved ? ("📁 " + cleanSaved) : ("⚙ " + j.tempPath); card.append(pathBox);
    }

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    if (j.driveUrl) {
      const db = document.createElement("button"); db.className = "btn btn--ok small"; db.textContent = "☁️ פתח ב-Google Drive";
      db.onclick = () => window.open(j.driveUrl, "_blank");
      const dc = document.createElement("button"); dc.className = "btn small"; dc.textContent = "📋 העתק קישור Drive";
      dc.onclick = () => { navigator.clipboard.writeText(j.driveUrl).catch(() => {}); dc.textContent = "✓ הועתק"; setTimeout(() => { dc.textContent = "📋 העתק קישור Drive"; }, 1400); };
      actions.append(db, dc);
    }
    if (j.runId) { const b = document.createElement("button"); b.className = "btn small"; b.textContent = "🔗 ריצה ב-GitHub"; b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_RUN", jobId: j.id }); actions.append(b); }
    if (j.status === "completed" && !j.driveOnly) { const b = document.createElement("button"); b.className = "btn btn--primary small"; b.textContent = "📂 תיקיית הורדות"; b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_DOWNLOADS" }); actions.append(b); }
    else if (j.status === "failed" || j.status === "cancelled") { const r = document.createElement("button"); r.className = "btn btn--primary small"; r.textContent = "🔄 נסה שוב"; r.onclick = async () => { await chrome.runtime.sendMessage({ type: "RETRY_JOB", jobId: j.id }); void refresh(); }; actions.append(r); }
    else if (!isTerminal) { const c = document.createElement("button"); c.className = "btn btn--danger small"; c.textContent = "✕ בטל"; c.onclick = () => chrome.runtime.sendMessage({ type: "CANCEL_JOB", jobId: j.id }); actions.append(c); }
    card.append(actions);
    return card;
  }

  function renderJobs(jobsObj) {
    const ids = Object.keys(jobsObj || {}).sort((a, b) => (jobsObj[b].startedAt || 0) - (jobsObj[a].startedAt || 0));
    const activeJobs = ids.map((id) => jobsObj[id]).filter((j) => !["completed","failed","cancelled"].includes(j.status));
    el("queueTabBadge").style.display = activeJobs.length ? "inline-block" : "none";
    el("queueTabBadge").textContent = String(activeJobs.length);
    const sig = JSON.stringify(ids.map((id) => [id, jobsObj[id].status, jobsObj[id].percent, jobsObj[id].localDlPct, jobsObj[id].detail, jobsObj[id].driveUrl]));
    if (!activeJobs.length && sig === lastJobsRenderSig) return;
    lastJobsRenderSig = sig;
    const pinnedList = el("pinnedJobsList"); pinnedList.replaceChildren();
    el("pinnedJobsWrap").style.display = activeJobs.length ? "flex" : "none";
    for (const aj of activeJobs.slice(0, 3)) pinnedList.append(buildJobCard(aj));
    const list = el("jobList"); list.replaceChildren();
    if (!ids.length) { const e = document.createElement("div"); e.className = "small muted"; e.textContent = "אין הורדות פעילות או אחרונות."; list.append(e); return; }
    for (const id of ids) list.append(buildJobCard(jobsObj[id]));
  }
  el("clearJobsBtn").onclick = async () => { await chrome.runtime.sendMessage({ type: "CLEAR_COMPLETED_JOBS" }); lastJobsRenderSig = ""; void refresh(); };

  function renderHistoryArchive(historyList) {
    const filter = el("histSearchInput").value.trim().toLowerCase();
    const sig = filter + "|" + (historyList || []).length + "|" + ((historyList && historyList[0] && historyList[0].timestamp) || 0);
    if (sig === lastHistRenderSig) return;
    lastHistRenderSig = sig;
    const wrap = el("historyList"); wrap.replaceChildren();
    const filtered = (historyList || []).filter((h) => !filter || String(h.title || "").toLowerCase().includes(filter));
    if (!filtered.length) { const e = document.createElement("div"); e.className = "small muted"; e.textContent = "אין פריטים תואמים בהיסטוריה."; wrap.append(e); return; }
    for (const h of filtered.slice(0, 35)) {
      const vid11 = h.videoId || (H.extract11Id ? H.extract11Id(h.url) : "");
      const cleanHT = String(h.title || "").replace(/[\u2066-\u2069]/g, "").replace(/\.f\d+(?:-\d+)?(?=\.[a-z0-9]{2,5}$)/i, "");
      const row = document.createElement("div"); row.className = "hist-card";
      const top = document.createElement("div"); top.className = "hist-card__top";
      const title = document.createElement("div"); title.className = "hist-card__title"; title.textContent = cleanHT; top.append(title);
      if (h.actualQuality && h.actualQuality !== "תקין") { const qb = document.createElement("span"); qb.className = "hist-card__qual"; qb.textContent = h.actualQuality; top.append(qb); }
      const btns = document.createElement("div"); btns.className = "hist-card__btns";
      if (h.driveUrl) { const db = document.createElement("button"); db.className = "btn btn--ok"; db.textContent = "☁️ פתח ב-Drive"; db.onclick = () => window.open(h.driveUrl, "_blank"); btns.append(db); }
      if (h.url) {
        const rd = document.createElement("button"); rd.className = "btn btn--primary"; rd.textContent = "⬇ הורד שוב"; rd.onclick = async () => { await dispatchDownload({ ...getActiveDownloadOptions(false, false), url: h.url, title: cleanHT, mode: "video" }); showToast("🚀 נשלח!"); void refresh(); };
        const dr = document.createElement("button"); dr.className = "btn btn--drive"; dr.textContent = "☁️ ל-Drive"; dr.onclick = async () => { await dispatchDownload({ ...getActiveDownloadOptions(false, false), url: h.url, title: cleanHT, uploadDrive: true, driveOnly: true, mode: "video" }); showToast("☁️ נשלח ל-Drive!"); void refresh(); };
        const sb = document.createElement("button"); sb.className = "btn btn--ok"; sb.textContent = "📝 כתוביות"; sb.onclick = async () => { await dispatchDownload({ ...getActiveDownloadOptions(true, false), url: h.url, title: cleanHT, mode: "video" }); void refresh(); };
        const cp = document.createElement("button"); cp.className = "btn"; cp.textContent = "📋 העתק"; cp.onclick = () => { navigator.clipboard.writeText(h.url).catch(() => {}); cp.textContent = "✓"; setTimeout(() => { cp.textContent = "📋 העתק"; }, 1200); };
        btns.append(rd, dr, sb, cp);
        if (vid11) { const sm = document.createElement("button"); sm.className = "btn btn--accent-outline"; sm.textContent = "🔍 דומים"; sm.onclick = () => triggerSimilarSearch(vid11, cleanHT); btns.append(sm); }
      }
      row.append(top, btns); wrap.append(row);
    }
  }
  el("histSearchInput").addEventListener("input", () => { lastHistRenderSig = ""; renderHistoryArchive(lastHistory); });
  el("clearHistBtn").onclick = async () => { await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" }); lastHistRenderSig = ""; void refresh(); };
  el("translateHistAllBtn").onclick = async () => { showToast("⏳ מתרגם היסטוריה..."); const r = await chrome.runtime.sendMessage({ type: "TRANSLATE_HISTORY_HE" }); if (r && r.ok) { showToast(`✅ תורגמו ${r.count || 0} שמות!`); lastHistRenderSig = ""; void refresh(); } };

  // מתרגם כתוביות מקומי (sl=auto)
  function tsToMs(s) { try { const [hms, ms] = String(s||"").trim().replace(".",",").split(","), p = hms.split(":").map(Number), [h,m,sc] = p.length===3?p:[0,p[0]||0,p[1]||0]; return (h*3600+m*60+sc)*1000+Number(String(ms||"0").slice(0,3).padEnd(3,"0")); } catch { return 0; } }
  function msToTs(ms) { let r = Math.max(0, Math.floor(ms)); const h = Math.floor(r/3600000); r%=3600000; const m = Math.floor(r/60000); r%=60000; const s = Math.floor(r/1000); return [h,m,s].map((v)=>String(v).padStart(2,"0")).join(":")+","+String(r%1000).padStart(3,"0"); }
  function parseSrt(raw) {
    const blocks = String(raw||"").replace(/^\uFEFF/,"").trim().split(/\r?\n\r?\n+/), out = [], recent = [];
    for (const b of blocks) {
      const lines = b.split(/\r?\n/).map((l)=>l.trim()).filter(Boolean);
      const ti = lines.findIndex((l,i)=>i<3 && l.includes("-->")); if (ti<0) continue;
      const [a,c] = lines[ti].split("-->"), sMs = tsToMs(a), eMs = tsToMs((c||"").trim().split(/\s+/)[0]); if (eMs-sMs<140) continue;
      const tLines = [];
      for (let i=ti+1;i<lines.length;i++) { const ta=document.createElement("textarea"); ta.innerHTML=lines[i].replace(/<[^>]+>/g," ").replace(/\{\\[^}]+\}/g," "); const cl=ta.value.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,"").replace(/\s+/g," ").trim(); if (cl && !/^(WEBVTT|Kind:|Language:)/i.test(cl) && !recent.includes(cl.toLowerCase())) { tLines.push(cl); recent.push(cl.toLowerCase()); if (recent.length>6) recent.shift(); } }
      if (tLines.length) out.push([sMs, eMs, tLines.join(" ")]);
    }
    return out;
  }
  el("translateLocalSrtBtn").onclick = async () => {
    const files = el("localSrtInput").files ? Array.from(el("localSrtInput").files) : [];
    if (!files.length) { el("srtTransProgWrap").style.display = "flex"; el("srtTransStatus").textContent = "נא לבחור קובץ תחילה."; return; }
    el("translateLocalSrtBtn").disabled = true; el("srtTransProgWrap").style.display = "flex";
    try {
      for (const file of files) {
        const cues = parseSrt(await file.text()); if (!cues.length) { el("srtTransStatus").textContent = "לא נמצאו כתוביות."; continue; }
        const bs = 30, out = [];
        for (let i=0;i<cues.length;i+=bs) {
          const sl = cues.slice(i, i+bs);
          const trArr = await H.translateTitlesBatchToHebrew(sl.map((c)=>c[2]));
          sl.forEach((c,j) => out.push([c[0], c[1], trArr[j] || c[2]]));
          const pct = Math.round((Math.min(cues.length, i+bs)/cues.length)*100);
          el("srtTransProgBar").style.width = pct + "%"; el("srtTransStatus").textContent = `מתרגם: ${pct}% (${out.length}/${cues.length})`;
        }
        const fmt = (s) => hasHebrew(s) ? ("\u202B\u200F" + s + "\u200F\u202C") : s;
        const srt = "\uFEFF" + out.map((c,i) => `${i+1}\r\n${msToTs(c[0])} --> ${msToTs(c[1])}\r\n${fmt(c[2])}`).join("\r\n\r\n") + "\r\n";
        const u = URL.createObjectURL(new Blob([srt], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a"); a.href = u; a.download = file.name.replace(/\.(en-orig|en|iw|he)?\.(srt|vtt|txt)$/i, "") + ".he.srt"; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 4000);
        el("srtTransStatus").textContent = `✓ הושלם ונשמר (${out.length} משפטים)`;
      }
    } catch (e) { el("srtTransStatus").textContent = "שגיאה: " + e.message; }
    finally { el("translateLocalSrtBtn").disabled = false; }
  };

  async function refresh() {
    const prefs = await chrome.runtime.sendMessage({ type: "GET_PREFS" });
    el("conn-dot").className = "dot " + (prefs && prefs.configured ? "is-ok" : "is-fail");
    el("conn-text").textContent = prefs && prefs.configured ? ("מחובר אל " + prefs.owner + "/" + prefs.repo) : "לא מוגדר — לחץ על הגדרות";
    if (prefs && prefs.emailTo && !el("emailToInput").value) el("emailToInput").value = prefs.emailTo;
    const res = await chrome.runtime.sendMessage({ type: "LIST_JOBS" }); if (res && res.jobs) renderJobs(res.jobs);
    const recRes = await chrome.runtime.sendMessage({ type: "GET_RECOMMENDATIONS" });
    if (recRes && recRes.ok) { lastHistory = recRes.history || []; renderRecommendations(recRes.sessions || {}, lastHistory, false); renderHistoryArchive(lastHistory); }
  }
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "JOBS_CHANGED") renderJobs(m.jobs); if (m && m.type === "RECS_CHANGED") void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  void refresh();
})();
