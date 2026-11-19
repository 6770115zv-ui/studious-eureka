"use strict";
(() => {
  const HUB_GROUPS = {
    il_media: [["🇮🇱 ערוץ הספורט (ספורט 5)","@SPORT5_IL"],["🇮🇱 ספורט 1 / צ'רלטון","@sport1sport2"],["🇮🇱 ONE ראשי","@one-1004"],["🇮🇱 ONE כתבות","@one4576"],["🇮🇱 ONE שידורים","@one5353"],["🇮🇱 מנהלת הכדורגל IPFL","@Ipflofficial"],["🇮🇱 מנהלת ליגת העל בכדורסל","@WInnerleague"],["🇮🇱 ההתאחדות לכדורגל","@israel_football_association"],["🇮🇱 רדיו חיפה ספורט","@sport107.5fm"],["🇮🇱 וואלה ספורט","@walla"],["🇮🇱 ישראל היום ספורט","@IsraelHayomOfficial"],["🇮🇱 מעריב ספורט","@Maarivonline"]],
    il_pod: [["🎙️ הפודיום (אורן יוסיפוביץ)","@hapodium_podcast"],["🎙️ בית הפודיום","@hapodium_sport"],["🎙️ האנליסטים","@haanalistimTV"],["🎙️ All•in קיקטוק","@getallin"],["🎙️ ONE פודקאסטים","@onepodcasts3641"],["🎙️ פוד-און","@podonmedia"],["🏀 פיני בראל","@PiniBarel"],["🏀 עושים NBA","@OsimNBA"],["🎙️ FootPod פרמיירליג","@FootPodPL"],["🎙️ אני מכבי","@im_maccabi_podcast"],["🎙️ Playmaker","@PlaymakerIL"],["🎙️ שער 10","@Aviel-10"],["🎙️ בצהוב שחור","@beitarpodcast"],["🎙️ וסרמיליה","@Vasermilya"]],
    il_clubs: [["🟢 מכבי חיפה","@mhfootballclub"],["🟡 מכבי תל אביב (כדורגל)","@MaccabiTLVFC"],["🏀 מכבי תל אביב (כדורסל)","@maccabitelaviv"],["🔴 הפועל תל אביב (כדורגל)","@HapoelTelAvivFC"],["🏀 הפועל תל אביב (כדורסל)","@HapoelTLVBC"],["🟡⚫ בית\"ר ירושלים","@fcbj1936"],["🔴 הפועל באר שבע","@officehb7"],["🏀 הפועל ירושלים","@HapoelJerusalem"]],
    world_leagues: [["🏀 NBA","@NBA"],["🏀 EuroLeague","@euroleague"],["🏆 UEFA","@UEFA"],["🌍 FIFA","@fifa"],["🦁 Premier League","@premierleague"],["⚽ LaLiga","@LaLiga"],["🇮🇹 Serie A","@seriea"],["🇩🇪 Bundesliga","@bundesliga"],["🏈 NFL","@NFL"],["🏎️ Formula 1","@Formula1"],["🥊 UFC","@ufc"],["🎾 ATP Tour","@ATPTour"],["🎾 Wimbledon","@Wimbledon"],["🏅 Olympics","@Olympics"],["🐂 Red Bull","@redbull"]],
    world_media: [["📺 CBS Sports Golazo","@cbssportsgolazo"],["📺 ESPN","@espn"],["📺 ESPN FC","@ESPNFC"],["📺 Sky Sports PL","@SkySportsPL"],["📺 TNT Sports","@tntsports"],["📺 DAZN Football","@DAZNFootball"],["🥊 DAZN Boxing","@DAZNBoxing"],["📺 Bleacher Report","@bleacherreport"],["🎙️ The Overlap","@TheOverlap"],["🧠 Tifo Football","@TifoFootball"],["🎙️ The Athletic FC","@TheAthleticFC"],["🚨 Fabrizio Romano","@FabrizioRomano"],["🏀 Thinking Basketball","@ThinkingBasketball"],["🎙️ Bill Simmons","@billsimmons"],["🏀 Podcast P","@PodcastPwithPaulGeorge"],["📚 HITC Sevens","@HITCSevens"]],
    world_clubs: [["🔵🔴 FC Barcelona","@FCBarcelona"],["👑 Real Madrid","@realmadrid"],["🩵 Man City","@mancity"],["🔴 Liverpool FC","@LiverpoolFC"],["🔴⚪ Arsenal","@arsenal"],["🔴⚫ Man Utd","@manutd"],["🔴⚪ FC Bayern","@fcbayern"]]
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

  function stripNoiseBeforeTranslate(t) {
    return String(t || "").replace(/[\u2066-\u2069\u200e\u200f]/g, "").replace(/\\u[0-9a-fA-F]{4}/g, " ").replace(/#[a-zA-Z0-9_\u0590-\u05FF]+/g, "").replace(/\s+/g, " ").trim();
  }

  // מילון השלמה סופי לעברית (רץ רק אחרי התרגום כדי לא לשבור sl=auto!)
  const HE_POLISH_PAIRS = [
    [/\bEXTENDED HIGHLIGHTS\b/gi, "תקציר מורחב"], [/\b(?:HIGHLIGHTS|HHIHLIGHTS|RESUMEN)\b/gi, "תקציר"],
    [/\b(?:FULL MATCH|PARTIDO COMPLETO|PARTIDO ENTERO)\b/gi, "משחק מלא"], [/\bFIRST TEAM\b/gi, "הקבוצה הבוגרת"],
    [/\bBEST OF\b/gi, "מיטב הרגעים של"], [/\bSKILLS\s*&\s*GOALS\b/gi, "מהלכים ושערים"], [/\bSKILLS\b/gi, "מהלכים"],
    [/\bGOALS\b/gi, "שערים"], [/\bFINAL\b/gi, "גמר"], [/\bVS\.?\b/gi, "נגד"], [/\bLIVESTREAM\b/gi, "שידור חי"],
    [/\bINTERVIEW\b/gi, "ראיון"], [/\bTRAINING\b/gi, "אימון"], [/\bACADEMY\b/gi, "אקדמיה"],
    [/\bFC Barcelona\b|\bBarça\b|\bBarcelona\b/gi, "ברצלונה"], [/\bReal Madrid\b/gi, "ריאל מדריד"],
    [/\bAtl[eé]tico de Madrid\b/gi, "אתלטיקו מדריד"], [/\bValencia\b/gi, "ולנסיה"], [/\bSevilla\b/gi, "סביליה"],
    [/\bReal Betis\b/gi, "ריאל בטיס"], [/\bGirona\s*FC\b|\bGirona\b/gi, "ג'ירונה"], [/\bVillarreal\b/gi, "ויאריאל"],
    [/\bMalaga\s*CF\b|\bM[aá]laga\b/gi, "מלאגה"], [/\bAtalanta\b/gi, "אטאלנטה"], [/\bAl Ahly\b/gi, "אל-אהלי"],
    [/\bHuesca\b/gi, "הואסקה"], [/\bViktoria Plzen\b/gi, "ויקטוריה פלזן"], [/\bRM Castilla\b/gi, "ריאל מדריד קסטייה"],
    [/\bLa\s*Mas[ií]a\b|לה מסיה|לה מאסה/gi, "לה מאסיה"], [/\bLALIGA EA SPORTS\b|\bLALIGA\b/gi, "לה ליגה"],
    [/\bCopa Del Rey Juvenil\b/gi, "גביע המלך לנוער"], [/\bUEFA Youth League\b/gi, "ליגת האלופות לנוער"],
    [/\bOrian Goren\b/gi, "אוריין גורן"], [/\bLamine Yamal\b|למין ימל|לאמין ימל/gi, "לאמין ימאל"],
    [/\bPau Cubars[ií]\b/gi, "פאו קובארסי"], [/\bJoan Garc[ií]a\b|חואן גרסיה|חואן גארסיה/gi, "ז'ואן גרסיה"],
    [/\bLionel Messi\b|\bLeo Messi\b/gi, "ליונל מסי"], [/\bAnsu Fati\b/gi, "אנסו פאטי"], [/\bGavi\b/gi, "גאבי"],
    [/\bMarc Bernal\b/gi, "מארק ברנאל"], [/\bDani Olmo\b/gi, "דני אולמו"], [/\bFerm[ií]n\b/gi, "פרמין"],
    [/\bEric Garc[ií]a\b/gi, "אריק גרסיה"], [/\bAndr[eé]s Iniesta\b/gi, "אנדרס אינייסטה"], [/\bH[eé]ctor Fort\b/gi, "הקטור פורט"],
    [/\bCarles Puyol\b/gi, "קרלס פויול"], [/\bRiqui Puig\b/gi, "ריקי פוץ'"], [/\bBalde\b/gi, "באלדה"],
    [/\bThiago Messi\b/gi, "תיאגו מסי"], [/\bAdam Qaroual\b/gi, "אדם קרואל"], [/\bHugo Galdeano\b/gi, "הוגו גלדיאנו"],
    [/\bXavi\b/gi, "צ'אבי"], [/\bPiqu[eé]\b/gi, "פיקה"], [/\bBusquets\b/gi, "בוסקטס"],
    [/\bדגשים\b|\bהבהרה\b|\bהבהרות\b/g, "תקציר"]
  ];

  function polishSportsHebrew(t) {
    let s = stripNoiseBeforeTranslate(t);
    for (const [rx, rep] of HE_POLISH_PAIRS) s = s.replace(rx, rep);
    return s.replace(/\s+/g, " ").trim();
  }

  function needsHebrewTranslation(text) {
    const nonHe = (String(text || "").match(/[a-zA-Z\u00C0-\u024F\u0600-\u06FF\u0400-\u04FF]/g) || []).length;
    return nonHe >= 3;
  }

  async function gtransPost(qText, sl = "auto") {
    for (const clientName of ["gtx", "dict-chrome-ex"]) {
      try {
        const res = await fetch(
          `https://translate.googleapis.com/translate_a/single?client=${clientName}&sl=${sl}&tl=iw&dt=t&dj=1`,
          { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ q: qText }).toString() }
        );
        if (res.ok) {
          const data = await res.json();
          const tr = ((data && data.sentences) || []).map((s) => (s && s.trans) || "").join("").trim();
          if (tr) return tr;
        }
      } catch {}
    }
    return "";
  }

  async function translateSingleToHebrew(text) {
    const cleanOrig = stripNoiseBeforeTranslate(text);
    if (!cleanOrig) return "";
    // אם זה טקסט מעורב (עברית + לועזית ממטמון ישן), מתרגמים ישירות רק את הרצפים הלועזיים!
    if (/[\u0590-\u05FF]/.test(cleanOrig) && /[a-zA-Z\u00C0-\u024F\u0600-\u06FF]{3,}/.test(cleanOrig)) {
      const hasEs = /[áéíóúñ¡¿]|\b(el|la|los|las|del|en|con|al|gana|contra|partido|torneo|niño|años)\b/i.test(cleanOrig);
      const sl = /[\u0600-\u06FF]/.test(cleanOrig) ? "ar" : (hasEs ? "es" : "en");
      const tr = await gtransPost(cleanOrig, sl);
      if (tr) return polishSportsHebrew(tr);
    }
    const trAuto = await gtransPost(cleanOrig, "auto");
    let out = polishSportsHebrew(trAuto || cleanOrig);
    if (needsHebrewTranslation(out)) {
      const trEn = await gtransPost(out, "en");
      if (trEn) out = polishSportsHebrew(trEn);
    }
    return out;
  }

  async function translateTitlesBatchToHebrew(titlesList) {
    const results = new Array(titlesList.length);
    const batchSize = 15;
    for (let i = 0; i < titlesList.length; i += batchSize) {
      const slice = titlesList.slice(i, i + batchSize).map((t) => stripNoiseBeforeTranslate(t).replace(/\r?\n/g, " "));
      const hasMixed = slice.some((s) => /[\u0590-\u05FF]/.test(s) && /[a-zA-Z]{3,}/.test(s));
      let batchDone = false;
      if (!hasMixed) {
        const fullTr = await gtransPost(slice.join("\n"), "auto");
        const lines = fullTr ? fullTr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
        if (lines.length === slice.length) {
          for (let j = 0; j < slice.length; j++) {
            const cand = polishSportsHebrew(lines[j]);
            results[i + j] = needsHebrewTranslation(cand) ? await translateSingleToHebrew(slice[j]) : cand;
          }
          batchDone = true;
        }
      }
      if (!batchDone) {
        for (let j = 0; j < slice.length; j++) results[i + j] = await translateSingleToHebrew(slice[j]);
      }
      if (i + batchSize < titlesList.length) await new Promise((r) => setTimeout(r, 120));
    }
    return results;
  }

  async function fetchWithTimeout(url, options, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  async function harvestLocalIsraeliIds(chInput, qInput, seasonMode) {
    const ch = String(chInput || "").trim(), q = String(qInput || "").trim();
    if (!ch && !q) return [];
    const SEASON_OPS = { "2026_2027":"after:2026-07-31","2025_2026":"after:2025-07-31 before:2026-08-01","2024_2025":"after:2024-07-31 before:2025-08-01","2023_2024":"after:2023-07-31 before:2024-08-01","2022_2023":"after:2022-07-31 before:2023-08-01","year_2025":"after:2024-12-31 before:2026-01-01","year_2024":"after:2023-12-31 before:2025-01-01","year_2023":"after:2022-12-31 before:2024-01-01","before_2023":"before:2023-01-01" };
    const dateOp = SEASON_OPS[seasonMode] || "";
    const chObj = ALL_CHANNELS.find((x) => x.handle.toLowerCase() === ch.toLowerCase());
    const chName = chObj ? chObj.label.replace(/^[^\s]+\s*/, "").split(" (")[0].replace("ראשי", "הערוץ הרשמי").trim() : ch.replace(/^@/, "");
    const queries = [];
    if (ch && seasonMode && seasonMode !== "all") {
      if (q) { queries.push(`"${chName}" ${q} ${dateOp}`.trim(), `${chName} ${q} ${dateOp}`.trim()); }
      else { for (const kw of ["","תקציר","תקציר מורחב","מחזור","ברצלונה","ריאל מדריד","מכבי","הפועל"]) queries.push(`"${chName}" ${kw} ${dateOp}`.replace(/\s+/g," ").trim()); }
    } else if (ch || q) queries.push(`${chName} ${q} ${dateOp}`.replace(/\s+/g," ").trim());
    const foundIds = new Set();
    const ctx = { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", hl: "he", gl: "IL" } };
    await Promise.all(queries.map(async (qStr) => {
      try {
        const res = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ context:ctx, query:qStr }) }, 4000);
        if (!res.ok) return;
        const txt = await res.text(), rx = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
        let m; while ((m = rx.exec(txt)) !== null) foundIds.add(m[1]);
      } catch {}
    }));
    return Array.from(foundIds);
  }

  self.YTUltra = { HUB_GROUPS, ALL_CHANNELS, extract11Id, normalizeYtInputValue, stripNoiseBeforeTranslate, cleanSportsTermsHe: polishSportsHebrew, polishSportsHebrew, needsHebrewTranslation, translateSingleToHebrew, translateTitlesBatchToHebrew, harvestLocalIsraeliIds };
})();
