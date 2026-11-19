# YouTube Cloud Ultra — ארכיטקטורת המערכת (v22.2)

## 1. מבנה הקבצים

### תוסף הדפדפן (`extension/`, Manifest V3)
* `manifest.json` — הגדרות MV3 והרשאות (`storage`, `cookies`, `downloads`, `notifications`, `offscreen`, `alarms`).
* `background.js` — Service Worker מרכזי: ניהול תור משימות (`jobs`), סשני חיפוש מקבילים (`REC_SESSIONS_KEY`), הצפנה/פענוח AES-256-GCM, תקשורת עם GitHub API, משיכת Blobs ישירה למטמון (`CacheStorage`), ושמירה נקייה לדיסק (`v15CleanWindowsFilename`).
* `offscreen.js` / `offscreen.html` — מסמך Offscreen למשיכה מזורמת עם פיצול בלוקים של 32MB לחיסכון ב-RAM, וחילוץ Zero-Copy מתוך `ZIP_STORED` באמצעות `blob.slice()`.
* `panel.html` / `panel.js` — ממשק 4 טאבים (חיפוש חכם וערוצים, הורדה ו-Google Drive, תור והיסטוריה, מתרגם כתוביות מקומי), Polling חכם שפעיל רק כשיש משימות רצות.
* `v15_features.js` — אינדקס 65 ערוצי ספורט ופודקאסטים, מילון ליטוש מונחי ספורט בעברית (`HE_POLISH_PAIRS`), תרגום מקבצי כותרות ואיסוף מזהים מקומי מישראל.
* `content.js` / `content.css` — הזרקת סרגל הורדה/כתוביות/חיתוך ישירות לדף הצפייה ביוטיוב מבוסס `yt-navigate-finish` ו-`MutationObserver`.
* `options.html` / `options.js` — דף הגדרות חיבור למאגר, טוקן, `COOKIE_KEY` ומייל ברירת מחדל (`emailTo`).
* `config.js` / `config.example.js` — ערכי ברירת מחדל בלבד (ללא שמירת סודות קבועים בקוד).
* `shared/common.js` / `shared/theme.css` — פרופילים (`YTPROXY_PRESETS`), כלי עזר ועיצוב כהה RTL.

### GitHub Actions (`.github/workflows/`)
* `download.yml` — הורדת מדיה באמצעות `yt-dlp` + Deno + BgUtils PO Token + FFmpeg; זיהוי מקדים של שפת כתוביות (מונע 429) ותרגום RTL לעברית; תמיכה ב-Cloud-Only (0MB תעבורה מקומית), העלאה Resumable ל-Google Drive, ושליחה למייל עם הגנת חסימת Gmail; אריזה כ-`ZIP_STORED` וגשר Git Blobs API.
* `recommend.yml` — חיפוש רב-לשוני וסריקת ערוצים/פלייליסטים, סינון ודירוג ב-Gemini 3.5 Flash-Lite עם מיון משוקלל (`ai_score * 1.8 + log10(views + 1)`), תרגום מלא לעברית והטמעת תמונות WebP 16:9 ב-Base64.
* `cleanup.yml` — ניקוי אוטומטי כל 6 שעות (ובשיגור ידני) של Releases, Tags וריצות Actions ישנות לשמירה על היגיינת המאגר הציבורי.

## 2. GitHub Secrets
* `COOKIE_KEY` — מפתח 64 תווי hex (AES-256-GCM) להצפנת עוגיות, כתובת מייל מותאמת וקישורי Google Drive.
* `GEMINI_API_KEY` — מפתח API לסינון, דירוג, הרחבת שאילתות ותרגום.
* `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, `GDRIVE_FOLDER_ID` — אינטגרציית Google Drive OAuth2.
* `SMTP_USER`, `SMTP_PASS` (ואופציונלי `SMTP_TO` / `EMAIL_TO`) — שליחת מייל מאובטחת דרך Gmail SMTP.

## 3. מפתחות `chrome.storage`
* `chrome.storage.local`:
  * `ytproxy_cfg` — הגדרות המאגר, הטוקן, `cookieKey` ו-`emailTo`.
  * `ytproxy_history` — היסטוריית 80 הורדות אחרונות (כולל איכות בפועל וקישור Drive).
  * `ytproxy_rec_sessions` — סשני חיפוש מקבילים ותוצאותיהם (עם מנגנון הגבלת גודל מתחת ל-4.2MB).
  * העדפות ממשק: `ytproxy_ai_filter_prompt`, `ytproxy_send_email_enabled`, `ytproxy_upload_drive_enabled`, `ytproxy_drive_only_enabled`, `ytproxy_active_tab`, `ytproxy_netfree_no_thumbs`, `ytproxy_search_langs`.
* `chrome.storage.session`:
  * `ytproxy_jobs` — מצב משימות ההורדה הפעילות והאחרונות.
