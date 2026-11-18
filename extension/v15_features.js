"use strict";
(() => {
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

  const ALL_CHANNELS = Object.entries(HUB_GROUPS).flatMap(([cat, arr]) =>
    arr.map(([label, handle]) => ({ cat, label, handle }))
  );

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
    return String(t || "")
      .replace(/[\u2066-\u2069]/g, "")
      .replace(/\\u[0-9a-fA-F]{4}/g, " ")
      .replace(/#[a-zA-Z0-9_\u0590-\u05FF]+/g, "")
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
      .replace(/\bJoan Garc[ií]a\b/gi, "ז'ואן גרסיה")
      .replace(/\bLALIGA EA SPORTS\b/gi, "לה ליגה")
      .replace(/\bדגשים\b|\bהבהרה\b/g, "תקציר")
      .replace(/\s+/g, " ")
      .trim();
  }

  function needsHebrewTranslation(text) {
    const s = String(text || "");
    const heCount = (s.match(/[\u0590-\u05FF]/g) || []).length;
    const nonHeLetters = (s.match(/[a-zA-Z\u00C0-\u024F\u0600-\u06FF\u0400-\u04FF]/g) || []).length;
    return nonHeLetters >= 3 && nonHeLetters > heCount * 0.4;
  }

  async function translateSingleToHebrew(text) {
    const pre = cleanSportsTermsHe(text);
    try {
      const res = await fetch(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=iw&dt=t&q=" + encodeURIComponent(pre)
      );
      if (!res.ok) return pre;
      const data = await res.json();
      const joined = ((data[0] || []).map((x) => (x && x[0]) || "").join("") || "").trim();
      return cleanSportsTermsHe(joined || pre);
    } catch {
      return pre;
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function harvestLocalIsraeliIds(chInput, qInput, seasonMode) {
    const ch = String(chInput || "").trim();
    const q = String(qInput || "").trim();
    if (!ch && !q) return [];
    const SEASON_OPS = {
      "2026_2027": "after:2026-07-31",
      "2025_2026": "after:2025-07-31 before:2026-08-01",
      "2024_2025": "after:2024-07-31 before:2025-08-01",
      "2023_2024": "after:2023-07-31 before:2024-08-01",
      "2022_2023": "after:2022-07-31 before:2023-08-01",
      "year_2025": "after:2024-12-31 before:2026-01-01",
      "year_2024": "after:2023-12-31 before:2025-01-01",
      "year_2023": "after:2022-12-31 before:2024-01-01",
      "before_2023": "before:2023-01-01"
    };
    const dateOp = SEASON_OPS[seasonMode] || "";
    const chObj = ALL_CHANNELS.find((x) => x.handle.toLowerCase() === ch.toLowerCase());
    const chName = chObj
      ? chObj.label.replace(/^[^\s]+\s*/, "").split(" (")[0].replace("ראשי", "הערוץ הרשמי").trim()
      : ch.replace(/^@/, "");

    const queries = [];
    if (ch && seasonMode && seasonMode !== "all") {
      if (q) {
        queries.push(`"${chName}" ${q} ${dateOp}`.trim());
        queries.push(`${chName} ${q} ${dateOp}`.trim());
      } else {
        for (const kw of ["", "תקציר", "תקציר מורחב", "מחזור", "ברצלונה", "ריאל מדריד", "מכבי", "הפועל"]) {
          queries.push(`"${chName}" ${kw} ${dateOp}`.replace(/\s+/g, " ").trim());
        }
      }
    } else if (ch || q) {
      queries.push(`${chName} ${q} ${dateOp}`.replace(/\s+/g, " ").trim());
    }

    const foundIds = new Set();
    const ctx = { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", hl: "he", gl: "IL" } };
    await Promise.all(queries.map(async (qStr) => {
      try {
        const res = await fetchWithTimeout(
          "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: ctx, query: qStr })
          },
          4000
        );
        if (!res.ok) return;
        const txt = await res.text();
        const rx = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
        let m;
        while ((m = rx.exec(txt)) !== null) foundIds.add(m[1]);
      } catch {}
    }));
    return Array.from(foundIds);
  }

  // ניקוי אוטומטי של לשוניות ריקות או כפולות שהסתיימו
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["ytproxy_rec_sessions"], (d) => {
      if (!d || !d.ytproxy_rec_sessions) return;
      const next = {};
      const seenSig = new Set();
      let changed = false;
      const sorted = Object.entries(d.ytproxy_rec_sessions).sort(
        (a, b) => ((b[1] && b[1].startedAt) || 0) - ((a[1] && a[1].startedAt) || 0)
      );
      for (const [k, s] of sorted) {
        if (!s) continue;
        if (s.status === "completed" && (!s.items || s.items.length === 0)) {
          changed = true;
          continue;
        }
        if (s.status === "completed") {
          const sig = `${(s.tabTitle || s.channel || s.query || "").trim().toLowerCase()}|${(s.items || []).length}`;
          if (seenSig.has(sig)) {
            changed = true;
            continue;
          }
          seenSig.add(sig);
        }
        next[k] = s;
      }
      if (changed) chrome.storage.local.set({ ytproxy_rec_sessions: next });
    });
  }

  self.YTUltra = {
    HUB_GROUPS,
    ALL_CHANNELS,
    extract11Id,
    normalizeYtInputValue,
    cleanSportsTermsHe,
    needsHebrewTranslation,
    translateSingleToHebrew,
    harvestLocalIsraeliIds
  };
})();
