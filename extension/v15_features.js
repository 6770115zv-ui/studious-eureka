"use strict";
(() => {
  const $ = (id) => document.getElementById(id);

  const HUB_GROUPS = {
    il_media: [
      ["🇮🇱 ערוץ הספורט (ספורט 5)", "@SPORT5_IL"], ["🇮🇱 ספורט 1 / צ'רלטון", "@sport1sport2"], ["🇮🇱 ONE ראשי", "@one-1004"],
      ["🇮🇱 ONE כתבות", "@one4576"], ["🇮🇱 ONE שידורים", "@one5353"], ["🇮🇱 מנהלת הכדורגל IPFL", "@Ipflofficial"],
      ["🇮🇱 מנהלת ליגת העל בכדורסל", "@WInnerleague"], ["🇮🇱 ההתאחדות לכדורגל", "@israel_football_association"],
      ["🇮🇱 רדיו חיפה ספורט", "@sport107.5fm"], ["🇮🇱 וואלה ספורט", "@walla"], ["🇮🇱 ישראל היום ספורט", "@IsraelHayomOfficial"], ["🇮🇱 מעריב ספורט", "@Maarivonline"]
    ],
    il_pod: [
      ["🎙️ הפודיום (אורן יוסיפוביץ)", "@hapodium_podcast"], ["🎙️ בית הפודיום", "@hapodium_sport"], ["🎙️ האנליסטים", "@haanalistimTV"],
      ["🎙️ All•in קיקטוק", "@getallin"], ["🎙️ ONE פודקאסטים", "@onepodcasts3641"], ["🎙️ פוד-און", "@podonmedia"],
      ["🏀 פיני בראל", "@PiniBarel"], ["🏀 עושים NBA", "@OsimNBA"], ["🎙️ FootPod פרמיירליג", "@FootPodPL"],
      ["🎙️ אני מכבי", "@im_maccabi_podcast"], ["🎙️ Playmaker", "@PlaymakerIL"], ["🎙️ שער 10", "@Aviel-10"],
      ["🎙️ בצהוב שחור", "@beitarpodcast"], ["🎙️ וסרמיליה", "@Vasermilya"]
    ],
    il_clubs: [
      ["🟢 מכבי חיפה", "@mhfootballclub"], ["🟡 מכבי תל אביב (כדורגל)", "@MaccabiTLVFC"], ["🏀 מכבי תל אביב (כדורסל)", "@maccabitelaviv"],
      ["🔴 הפועל תל אביב (כדורגל)", "@HapoelTelAvivFC"], ["🏀 הפועל תל אביב (כדורסל)", "@HapoelTLVBC"], ["🟡⚫ בית\"ר ירושלים", "@fcbj1936"],
      ["🔴 הפועל באר שבע", "@officehb7"], ["🏀 הפועל ירושלים", "@HapoelJerusalem"]
    ],
    world_leagues: [
      ["🏀 NBA", "@NBA"], ["🏀 EuroLeague", "@euroleague"], ["🏆 UEFA", "@UEFA"], ["🌍 FIFA", "@fifa"], ["🦁 Premier League", "@premierleague"],
      ["⚽ LaLiga", "@LaLiga"], ["🇮🇹 Serie A", "@seriea"], ["🇩🇪 Bundesliga", "@bundesliga"], ["🏈 NFL", "@NFL"], ["🏎️ Formula 1", "@Formula1"],
      ["🥊 UFC", "@ufc"], ["🎾 ATP Tour", "@ATPTour"], ["🎾 Wimbledon", "@Wimbledon"], ["🏅 Olympics", "@Olympics"], ["🐂 Red Bull", "@redbull"]
    ],
    world_media: [
      ["📺 CBS Sports Golazo", "@cbssportsgolazo"], ["📺 ESPN", "@espn"], ["📺 ESPN FC", "@ESPNFC"], ["📺 Sky Sports PL", "@SkySportsPL"],
      ["📺 TNT Sports", "@tntsports"], ["📺 DAZN Football", "@DAZNFootball"], ["🥊 DAZN Boxing", "@DAZNBoxing"], ["📺 Bleacher Report", "@bleacherreport"],
      ["🎙️ The Overlap", "@TheOverlap"], ["🧠 Tifo Football", "@TifoFootball"], ["🎙️ The Athletic FC", "@TheAthleticFC"], ["🚨 Fabrizio Romano", "@FabrizioRomano"],
      ["🏀 Thinking Basketball", "@ThinkingBasketball"], ["🎙️ Bill Simmons", "@billsimmons"], ["🏀 Podcast P", "@PodcastPwithPaulGeorge"], ["📚 HITC Sevens", "@HITCSevens"]
    ],
    world_clubs: [
      ["🔵🔴 FC Barcelona", "@FCBarcelona"], ["👑 Real Madrid", "@realmadrid"], ["🩵 Man City", "@mancity"], ["🔴 Liverpool FC", "@LiverpoolFC"],
      ["🔴⚪ Arsenal", "@arsenal"], ["🔴⚫ Man Utd", "@manutd"], ["🔴⚪ FC Bayern", "@fcbayern"]
    ]
  };
  const ALL_CHANNELS = Object.entries(HUB_GROUPS).flatMap(([cat, arr]) => arr.map(([label, handle]) => ({ cat, label, handle })));

  function extract11Id(raw) {
    const s = String(raw || "").trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:\[|v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|vi\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : "";
  }

  function normalizeYtInputValue(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return "https://www.youtube.com/watch?v=" + s;
    const mBr = s.match(/\[([a-zA-Z0-9_-]{11})\]/);
    if (mBr && !s.startsWith("http")) return "https://www.youtube.com/watch?v=" + mBr[1];
    return s;
  }

  function cleanSportsTermsHe(t) {
    return String(t || "").replace(/[\u2066-\u2069]/g, "").replace(/\\u[0-9a-fA-F]{4}/g, " ").replace(/#[a-zA-Z0-9_\u0590-\u05FF]+/g, "")
      .replace(/\s*\([^)]*[a-zA-Z]{4,}[^)]*\)\s*$/g, "")
      .replace(/\bEXTENDED HIGHLIGHTS\b/gi, "תקציר מורחב")
      .replace(/\b(?:HIGHLIGHTS|HHIHLIGHTS|RESUMEN)\b/gi, "תקציר")
      .replace(/\b(?:FULL MATCH|PARTIDO COMPLETO|PARTIDO ENTERO)\b/gi, "משחק מלא")
      .replace(/\bFC Barcelona\b|\bBarça\b/gi, "ברצלונה")
      .replace(/\bReal Madrid\b/gi, "ריאל מדריד")
      .replace(/\bAtl[eé]tico de Madrid\b/gi, "אתלטיקו מדריד")
      .replace(/\bLa\s*Mas[ií]a\b/gi, "לה מאסיה")
      .replace(/\bOrian Goren\b/gi, "אוריין גורן")
      .replace(/\bLamine Yamal\b/gi, "לאמין ימאל")
      .replace(/\bPau Cubars[ií]\b/gi, "פאו קובארסי")
      .replace(/\bLALIGA EA SPORTS\b/gi, "לה ליגה")
      .replace(/\bדגשים\b|\bהבהרה\b/g, "תקציר")
      .trim();
  }

  async function translateSingleToHebrew(text) {
    const pre = cleanSportsTermsHe(text);
    const res = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=iw&dt=t&q=" + encodeURIComponent(pre));
    if (!res.ok) return pre;
    const data = await res.json();
    return cleanSportsTermsHe(((data[0] || []).map((x) => (x && x[0]) || "").join("") || "").trim() || pre);
  }

  function showStatus(msg, isErr = false) {
    const qEl = $("v15QuickStatus");
    if (qEl) { qEl.textContent = msg; qEl.style.color = isErr ? "var(--fail)" : "var(--ok)"; }
    const hEl = $("hint");
    if (hEl) hEl.textContent = "";
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
    if (msg && msg.type === "START_RECOMMEND" && msg.payload) {
      const useAi = $("recUseAiFilterToggle") && $("recUseAiFilterToggle").checked;
      const basePrompt = useAi ? String(msg.payload.filterPrompt || "").replace(/\[[A-Z0-9_:]+\]/gi, "").trim() : "";
      const tags = [];
      if ($("recHighQualityOnlyToggle") && $("recHighQualityOnlyToggle").checked) tags.push("[HQ_ONLY]");
      if (!$("recTranslateTitlesToggle") || $("recTranslateTitlesToggle").checked) tags.push("[TR_HE]");
      const plMode = ($("v15HubPlaylistMode") && $("v15HubPlaylistMode").value) || "auto";
      if (plMode === "uu_all") tags.push("[PL_UU]");
      else if (plMode === "streams") tags.push("[PL_STREAMS]");
      else if (plMode === "uulp") tags.push("[PL_UULP]");

      const durMode = ($("recDurationSelect") && $("recDurationSelect").value) || "all";
      if (durMode !== "all") tags.push("[DUR:" + durMode.toUpperCase() + "]");

      msg.payload.filterPrompt = (basePrompt + " " + tags.join(" ")).trim();
    }
    return origSend(msg, ...rest);
  };

  function applyLiveClientFilters() {
    const recList = $("recList");
    if (!recList) return;
    const durMode = ($("recDurationSelect") && $("recDurationSelect").value) || "all";
    const minViews = Number(($("recMinViewsSelect") && $("recMinViewsSelect").value) || 0);
    const hqOnly = Boolean($("recHighQualityOnlyToggle") && $("recHighQualityOnlyToggle").checked);
    const liveSearch = (($("liveRecSearchInput") && $("liveRecSearchInput").value) || "").trim().toLowerCase();

    let visibleCount = 0;
    for (const card of recList.children) {
      const txt = (card.textContent || "");
      const mDur = txt.match(/⏱\s*(\d+):(\d+)/);
      const totalSec = mDur ? (parseInt(mDur[1], 10) * 60 + parseInt(mDur[2], 10)) : 0;
      const mins = totalSec / 60;

      const mViews = txt.match(/👁\s*([\d,]+)/);
      const views = mViews ? parseInt(mViews[1].replace(/,/g, ""), 10) : 0;

      let show = true;
      if (durMode === "no_shorts" && totalSec > 0 && totalSec < 90) show = false;
      else if (durMode === "clips" && totalSec > 0 && (totalSec < 60 || mins > 20)) show = false;
      else if (durMode === "long" && totalSec > 0 && mins < 20) show = false;
      else if (durMode === "short5" && totalSec > 0 && mins > 5) show = false;

      if (show && hqOnly && totalSec > 0 && totalSec < 65) show = false;
      if (show && minViews > 0 && views < minViews) show = false;
      if (show && liveSearch && !txt.toLowerCase().includes(liveSearch)) show = false;

      card.style.display = show ? "flex" : "none";
      if (show) visibleCount++;
    }
    const st = $("recStatusText");
    if (st && recList.children.length > 0) {
      const baseTxt = st.dataset.baseText || st.textContent.replace(/\s*\(מוצגות כעת:.*\)$/, "");
      st.dataset.baseText = baseTxt;
      st.textContent = `${baseTxt} (מוצגות כעת: ${visibleCount} מתוך ${recList.children.length})`;
    }
  }

  let lastPreviewVid = "";
  async function updateInstantPreview(rawVal) {
    const vid = extract11Id(rawVal);
    const box = $("videoPreview"), thumb = $("previewThumb"), titleEl = $("previewTitle"), authorEl = $("previewAuthor");
    if (!vid || !box || !titleEl || !authorEl || (vid === lastPreviewVid && box.style.display !== "none")) return;
    lastPreviewVid = vid;
    box.dataset.v15Active = "1";
    box.style.display = "flex";
    titleEl.textContent = "⏳ טוען פרטי סרטון (" + vid + ")...";
    authorEl.textContent = "מזהה: " + vid;
    if (thumb) {
      thumb.onerror = () => { if (self.NETFREE_SAFE_THUMB_SVG && thumb.src !== self.NETFREE_SAFE_THUMB_SVG) thumb.src = self.NETFREE_SAFE_THUMB_SVG; };
      thumb.src = "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg";
    }
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", hl: "he", gl: "IL" } }, videoId: vid })
      });
      if (res.ok) {
        const data = await res.json(), vd = data.videoDetails || {}, mf = (data.microformat && data.microformat.playerMicroformatRenderer) || {};
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

  function initHubAndEvents() {
    const catSel = $("v15HubCatSelect"), chSel = $("v15HubChannelSelect"), quickBar = $("v15QuickChannelsBar");
    if (catSel && chSel && quickBar) {
      const populate = () => {
        const list = catSel.value === "all" ? ALL_CHANNELS : ALL_CHANNELS.filter((x) => x.cat === catSel.value);
        chSel.innerHTML = `<option value="">-- בחר ערוץ מהרשימה (${list.length}) --</option>` +
          list.map((x) => `<option value="${x.handle}">${x.label} (${x.handle})</option>`).join("");
        quickBar.innerHTML = `<span class="small muted" style="font-weight:700;">⚡ בחירה מהירה:</span>` +
          list.slice(0, 12).map((x) => {
            const cleanLbl = x.label.replace(/^[^\s]+\s*/, "").replace(/\s*\([^)]*\)/g, "").trim();
            return `<button type="button" class="btn small v15-ch" data-h="${x.handle}" style="padding:3px 9px;font-size:11.5px;border-radius:999px;">${cleanLbl}</button>`;
          }).join("");
        quickBar.querySelectorAll(".v15-ch").forEach((b) => b.addEventListener("click", () => {
          chSel.value = b.dataset.h;
          if ($("recChannelInput")) $("recChannelInput").value = b.dataset.h;
          showStatus(`📺 נבחר הערוץ ${b.dataset.h} — הגדר סינון או לחץ על "הפעל סריקה וחיפוש"`);
        }));
      };
      catSel.addEventListener("change", populate);
      chSel.addEventListener("change", () => {
        if (chSel.value && $("recChannelInput")) {
          $("recChannelInput").value = chSel.value;
        }
      });
      populate();

      if ($("v15LoadChannelPlaylistBtn")) {
        $("v15LoadChannelPlaylistBtn").addEventListener("click", () => {
          const h = chSel.value || ($("recChannelInput") && $("recChannelInput").value.trim());
          if (!h) return showStatus("❌ בחר ערוץ מהרשימה תחילה", true);
          if ($("recChannelInput")) $("recChannelInput").value = h;
          $("findRecsBtn").click();
        });
      }

      if ($("v15SendChannelToTopBtn")) {
        $("v15SendChannelToTopBtn").addEventListener("click", () => {
          const h = chSel.value || ($("recChannelInput") && $("recChannelInput").value.trim());
          if (!h || !$("urlInput")) return showStatus("❌ בחר ערוץ תחילה", true);
          const plMode = ($("v15HubPlaylistMode") && $("v15HubPlaylistMode").value) || "auto";
          const sfx = plMode === "streams" ? "/streams" : "/videos";
          const cleanH = h.startsWith("http") ? h : ("https://www.youtube.com/" + h + sfx);
          $("urlInput").value = cleanH;
          if ($("collectionToggle")) $("collectionToggle").checked = true;
          showStatus(`📥 הועבר לתיבת ההורדה הישירה למעלה: ${cleanH}`);
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
    }

    if ($("clearChannelBtn")) $("clearChannelBtn").onclick = () => {
      if ($("recChannelInput")) $("recChannelInput").value = "";
      if ($("v15HubChannelSelect")) $("v15HubChannelSelect").value = "";
    };
    if ($("clearQueryBtn")) $("clearQueryBtn").onclick = () => {
      if ($("recQueryInput")) $("recQueryInput").value = "";
    };
    if ($("resetSearchFiltersBtn")) $("resetSearchFiltersBtn").onclick = () => {
      if ($("recChannelInput")) $("recChannelInput").value = "";
      if ($("recQueryInput")) $("recQueryInput").value = "";
      if ($("v15HubChannelSelect")) $("v15HubChannelSelect").value = "";
      if ($("recSortBySelect")) $("recSortBySelect").value = "views";
      if ($("recDurationSelect")) $("recDurationSelect").value = "all";
      if ($("v15HubPlaylistMode")) $("v15HubPlaylistMode").value = "auto";
      if ($("recMinViewsSelect")) $("recMinViewsSelect").value = "0";
      if ($("recMaxResultsSelect")) $("recMaxResultsSelect").value = "60";
      if ($("recHighQualityOnlyToggle")) $("recHighQualityOnlyToggle").checked = false;
      if ($("liveRecSearchInput")) $("liveRecSearchInput").value = "";
      applyLiveClientFilters();
      showStatus("🔄 כל שדות החיפוש והסינון אופסו");
    };

    if ($("recUseAiFilterToggle") && $("aiFilterWrap")) {
      $("recUseAiFilterToggle").addEventListener("change", () => {
        $("aiFilterWrap").style.display = $("recUseAiFilterToggle").checked ? "block" : "none";
      });
    }

    for (const id of ["recDurationSelect", "recMinViewsSelect", "recHighQualityOnlyToggle", "liveRecSearchInput"]) {
      const el = $(id);
      if (el) {
        el.addEventListener("change", applyLiveClientFilters);
        el.addEventListener("input", applyLiveClientFilters);
      }
    }

    const urlInput = $("urlInput");
    if (urlInput) {
      const onUrlInput = () => {
        const raw = urlInput.value.trim(), vid = extract11Id(raw);
        if (vid && !raw.startsWith("http") && raw.split(/[\s,]+/).length === 1) {
          urlInput.value = "https://www.youtube.com/watch?v=" + vid;
          urlInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (vid) updateInstantPreview(vid);
      };
      urlInput.addEventListener("input", onUrlInput);
      urlInput.addEventListener("paste", () => setTimeout(onUrlInput, 30));
    }

    if ($("v15TopSimilarBtn")) {
      $("v15TopSimilarBtn").addEventListener("click", () => {
        const vid = extract11Id($("urlInput") && $("urlInput").value);
        if (!vid) return showStatus("❌ הזן קישור או מזהה 11 תווים בתיבה למעלה", true);
        triggerSimilarSearch(vid, ($("previewTitle") && $("previewTitle").textContent) || vid);
      });
    }

    if ($("cleanCloudBtn")) $("cleanCloudBtn").addEventListener("click", async () => {
      $("cleanCloudBtn").disabled = true;
      showStatus("⏳ מוחק את כל הריצות והשחרורים מהמאגר...");
      try {
        const res = await chrome.runtime.sendMessage({ type: "PURGE_ALL_CLOUD" });
        if (res && res.ok) showStatus(`✅ נמחקו ${res.deletedReleases || 0} שחרורים ו-${res.deletedRuns || 0} ריצות!`);
        else showStatus("❌ שגיאה במחיקה", true);
      } catch (e) { showStatus("❌ שגיאה: " + e.message, true); }
      finally { $("cleanCloudBtn").disabled = false; }
    });

    if ($("copyGhTokenBtn")) $("copyGhTokenBtn").addEventListener("click", async () => {
      const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      if (!cfg || !cfg.token) return showStatus("❌ לא נמצא טוקן", true);
      await navigator.clipboard.writeText(cfg.token.trim());
      showStatus("✅ ה-GitHub Token הועתק ללוח!");
    });

    if ($("copyYtCookiesEncBtn")) $("copyYtCookiesEncBtn").addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES" });
      if (res && res.ok && res.encrypted) { await navigator.clipboard.writeText(res.encrypted); showStatus("✅ העוגיות המוצפנות הועתקו ללוח!"); }
      else showStatus("❌ שגיאה בהצפנת עוגיות", true);
    });

    if ($("translateVisibleRecsBtn")) $("translateVisibleRecsBtn").addEventListener("click", async () => {
      const recList = $("recList");
      if (!recList) return;
      const els = Array.from(recList.querySelectorAll("a, div, span")).filter((el) => /^#\d+\s*•/.test((el.textContent || "").trim()) && el.children.length === 0);
      if (!els.length) return showStatus("אין תוצאות מוצגות לתרגום", true);
      showStatus(`⏳ מתרגם ומנקה ${els.length} כותרות לעברית...`);
      await Promise.all(els.map(async (el) => {
        const pfx = (el.textContent.match(/^#\d+\s*•\s*/) || [""])[0];
        const raw = el.title || el.textContent.replace(/^#\d+\s*•\s*/, "").trim();
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

  let enhanceScheduled = false;
  function scheduleEnhanceCards() {
    if (enhanceScheduled) return;
    enhanceScheduled = true;
    requestAnimationFrame(() => {
      enhanceScheduled = false;
      for (const cid of ["recList", "historyList"]) {
        const box = $(cid);
        if (!box) continue;
        for (const card of box.children) {
          if (card.dataset.v15Done === "1") continue;
          card.dataset.v15Done = "1";

          const imgEl = card.querySelector("img");
          if (imgEl) {
            imgEl.loading = "lazy";
            imgEl.onerror = () => { if (self.NETFREE_SAFE_THUMB_SVG && imgEl.src !== self.NETFREE_SAFE_THUMB_SVG) imgEl.src = self.NETFREE_SAFE_THUMB_SVG; };
          }

          const titleEl = Array.from(card.querySelectorAll("a, div, span")).find((el) => /^#\d+\s*•/.test((el.textContent || "").trim()) && el.children.length === 0);
          if (titleEl) {
            const pfx = (titleEl.textContent.match(/^#\d+\s*•\s*/) || [""])[0];
            const raw = titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim();
            titleEl.title = raw;
            const cleaned = cleanSportsTermsHe(raw);
            titleEl.textContent = pfx + cleaned;
            const autoTr = !$("recTranslateTitlesToggle") || $("recTranslateTitlesToggle").checked;
            if (autoTr && (cleaned.match(/[a-zA-Z]/g) || []).length >= 5 && !titleEl.dataset.trQueued) {
              titleEl.dataset.trQueued = "1";
              translateSingleToHebrew(cleaned).then((he) => {
                if (he && titleEl.isConnected) titleEl.textContent = pfx + he;
              }).catch(() => {});
            }
          }

          let vid11 = "";
          if (imgEl && imgEl.src && !imgEl.src.startsWith("data:")) vid11 = extract11Id(imgEl.src);
          if (!vid11) vid11 = extract11Id(card.textContent || "");

          if (vid11) {
            const btns = card.querySelectorAll("button"), lastBtn = btns[btns.length - 1];
            if (lastBtn && lastBtn.parentElement) {
              const parent = lastBtn.parentElement;
              if (cid === "recList") {
                const subDlBtn = document.createElement("button");
                subDlBtn.type = "button";
                subDlBtn.className = "btn small";
                subDlBtn.style.cssText = "padding:4px 8px;font-size:11.5px;border-color:var(--ok);color:var(--ok);";
                subDlBtn.textContent = "🎬+📝 עם כתוביות";
                subDlBtn.addEventListener("click", (e) => {
                  e.stopPropagation();
                  const cleanT = titleEl ? titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim() : vid11;
                  chrome.runtime.sendMessage({
                    type: "START_DOWNLOAD",
                    payload: { url: "https://www.youtube.com/watch?v=" + vid11, title: cleanT, quality: ($("formatSelect") && $("formatSelect").value) || "best", mode: "video", subtitles: "embed" }
                  });
                  showStatus(`🚀 נשלחה הורדה עם כתוביות בעברית: ${cleanT}`);
                });
                parent.insertBefore(subDlBtn, lastBtn);
              }
              const simBtn = document.createElement("button");
              simBtn.type = "button";
              simBtn.className = "btn small";
              simBtn.style.cssText = "padding:4px 8px;font-size:11.5px;border-color:var(--accent);color:var(--accent);";
              simBtn.textContent = "🔍 דומים";
              simBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                triggerSimilarSearch(vid11, titleEl ? titleEl.textContent.replace(/^#\d+\s*•\s*/, "").trim() : vid11);
              });
              parent.insertBefore(simBtn, lastBtn);

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
      applyLiveClientFilters();
    });
  }

  function init() {
    initHubAndEvents();
    const obs = new MutationObserver(scheduleEnhanceCards);
    if ($("recList")) obs.observe($("recList"), { childList: true });
    if ($("historyList")) obs.observe($("historyList"), { childList: true });
    scheduleEnhanceCards();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();