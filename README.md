# YouTube Cloud Ultra v3.0 — מערכת הורדה מתקדמת דרך GitHub Actions

מערכת להורדת קובצי מדיה ואודיו באמצעות **GitHub Actions** ותוסף דפדפן (Chrome / Edge / Brave), כולל הצפנת עוגיות מקצה לקצה (**AES-256-GCM**), עקיפת חסימות אזוריות אוטומטית (**Geo-Bypass XFF**) ומנגנון התאוששות חכם.

## יכולות עיקריות בגרסה 3.0

1. **12 פורמטים ואיכויות**: `4K (2160p)`, `2K (1440p)`, `1080p`, `720p`, `480p`, `360p`, `Auto Best`, `MP3 320kbps`, `FLAC`, `WAV`, `M4A`, `OPUS`.
2. **עקיפת חסימת מדינה אוטומטית (Geo-Bypass)**: פתרון מלא לשגיאת `The uploader has not made this video available in your country` באמצעות כותרות מיקום (`IL`, `GB`, `US`) ו-8 שלבי גיבוי.
3. **משיכת API ישירה עם Retry אוטומטי**: משיכת הקבצים דרך `apiUrl` עם כותרת `Accept: application/octet-stream`, גשר `CacheStorage` מה-Service Worker ו-4 ניסיונות חוזרים אוטומטיים למניעת `Failed to fetch` ב-75%.
4. **חיתוך קטעים לפי זמנים (Clipper)**, **SponsorBlock מובנה** ו**כתוביות בעברית ובאנגלית**.

## התקנה מהירה

1. העלה את כל הקבצים בתיקייה זו למאגר ה-GitHub שלך (כולל `.github/workflows`).
2. הרץ את `set-token.bat` (או הגדר ישירות מתוך דף ההגדרות של התוסף), והוסף את `COOKIE_KEY` ל-GitHub תחת `Settings -> Secrets and variables -> Actions -> New repository secret`.
3. טען את התיקייה `extension/` בדפדפן דרך `chrome://extensions` במצב מפתח (**Load unpacked**).