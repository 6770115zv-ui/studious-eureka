import os, sys, re, html, json, time, math, base64, shutil, zipfile, threading, subprocess, smtplib, email.message, urllib.parse, requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ev_path = os.environ.get("GITHUB_EVENT_PATH", "")
ev = json.load(open(ev_path, "r", encoding="utf-8")) if ev_path and os.path.exists(ev_path) else {}
inp = ev.get("inputs") or {}

req_id = str(inp.get("request_id", "")).strip()
target_url = str(inp.get("url", "")).strip()
quality = str(inp.get("quality", "best")).strip().lower() or "best"
mode = str(inp.get("mode", "video")).strip().lower() or "video"
urls_raw = str(inp.get("urls", "")).strip()
clip_start = str(inp.get("clip_start", "")).strip()
clip_end = str(inp.get("clip_end", "")).strip()
subtitles = str(inp.get("subtitles", "none")).strip().lower()
raw_sb = str(inp.get("sponsorblock", "{}")).strip()
cookies_enc = str(inp.get("cookies_enc", "")).strip()

secret_key_env = os.environ.get("COOKIE_KEY", "").strip().strip("\"'")
def mask_secret(*vals):
    for v in vals:
        if v and len(str(v)) >= 4:
            print(f"::add-mask::{v}", flush=True)

mask_secret(cookies_enc, secret_key_env)

if quality == "subs_only" or subtitles == "only":
    quality = "subs_only"
    subtitles = "only"

try:
    opts = json.loads(raw_sb) if raw_sb.startswith("{") else {"sb": raw_sb.lower() == "true"}
except Exception:
    opts = {}

geo = str(opts.get("geo") or "IL").upper()
sb = bool(opts.get("sb"))
chapters = bool(opts.get("chapters"))
norm_audio = bool(opts.get("norm"))
speed_val = str(opts.get("speed") or "1").strip()
email_opt = str(opts.get("email") or "").strip()
email_enc = str(opts.get("email_enc") or "").strip()
upload_drive_flag = bool(opts.get("upload_drive"))
send_email_flag = bool(opts.get("send_email"))
cloud_only_flag = bool((opts.get("cloud_only") or opts.get("drive_only")) and (upload_drive_flag or send_email_flag))

def decrypt_aes(b64_txt: str) -> str:
    if not b64_txt or len(secret_key_env) != 64:
        return ""
    try:
        raw = base64.b64decode(b64_txt)
        return AESGCM(bytes.fromhex(secret_key_env)).decrypt(raw[:12], raw[12:], None).decode("utf-8", errors="replace")
    except Exception:
        return ""

if email_enc:
    mask_secret(email_enc)
    _de = decrypt_aes(email_enc).strip()
    if "@" in _de:
        email_opt = _de
        mask_secret(email_opt)

def _safe_log_tail(txt: str, limit: int = 1600) -> str:
    s = str(txt or "")[-limit:]
    s = re.sub(r"https?://(?:www\.|m\.)?youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})\S*", r"yt:\1", s)
    return re.sub(r"https?://youtu\.be/([a-zA-Z0-9_-]{11})\S*", r"yt:\1", s)

def _ffmpeg_ok(args) -> bool:
    return subprocess.run(["/usr/bin/ffmpeg", "-y"] + args, capture_output=True, check=False).returncode == 0

def _ffprobe(args) -> str:
    try:
        r = subprocess.run(["ffprobe", "-v", "error"] + args, capture_output=True, text=True, timeout=15)
        return r.stdout or ""
    except Exception:
        return ""

out_dir, pkg_dir, stage_dir, subs_dir = Path("/tmp/out"), Path("/tmp/pkg"), Path("/tmp/stage"), Path("/tmp/subs")
out_dir.mkdir(parents=True, exist_ok=True)
pkg_dir.mkdir(parents=True, exist_ok=True)
cookie_file = Path("/tmp/cookies_full.txt")
embedded_srt_saved = None
embedded_srts_by_stem = {}
t_job_start = time.time()
detected_dur = 0.0
subs_verified_flag = None
subs_detail_msg = ""
telemetry = {"attempts": [], "winner": "", "dl_sec": 0, "sub_sec": 0, "ff_sec": 0, "pkg_sec": 0, "drive_sec": 0, "email_sec": 0, "sub_cues": 0, "sub_source": ""}

has_ck = False
if cookies_enc:
    decrypted_txt = decrypt_aes(cookies_enc)
    if decrypted_txt and ("youtube.com" in decrypted_txt or "# Netscape" in decrypted_txt):
        cookie_file.write_text(decrypted_txt, encoding="utf-8")
        has_ck = True
        print("Full cookies decrypted successfully.", flush=True)

target_urls = [target_url]
if mode == "list" and urls_raw:
    try:
        parsed = json.loads(urls_raw)
        if isinstance(parsed, list) and parsed:
            target_urls = [str(u).strip() for u in parsed if str(u).strip().startswith("http")]
    except Exception:
        pass

is_subs_only = (quality == "subs_only" or subtitles == "only")
is_audio = quality.startswith("audio")
req_h = {"2160": 2160, "1440": 1440, "1080": 1080, "720": 720, "480": 480, "360": 360}.get(quality, 2160)
MEDIA_EXTS = (".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".flac", ".wav", ".opus")
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}

def ts_to_ms(ts_str: str) -> int:
    try:
        clean = re.sub(r"[^\d:,.]", "", ts_str.strip()).replace(".", ",")
        hms, ms = clean.split(",", 1) if "," in clean else (clean, "0")
        p = [int(x) for x in hms.split(":") if x.isdigit()]
        h, m, s = p if len(p) == 3 else ((0, p[0], p[1]) if len(p) == 2 else ((0, 0, p[0]) if len(p) == 1 else (0, 0, 0)))
        return ((h * 3600 + m * 60 + s) * 1000) + int(ms[:3].ljust(3, "0"))
    except Exception:
        return 0

def ms_to_ts(ms: int) -> str:
    ms = max(0, int(ms))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, rem = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{rem:03d}"

TRAILING_SPLIT_RX = re.compile(
    r"^(.*?)\s+("
    r"with a couple of|a couple of|a lot of|kind of|sort of|out of|instead of|because of|in front of|"
    r"going to|trying to|want to|have to|has to|had to|used to|able to|ready to|"
    r"a|an|the|and|or|but|to|of|in|on|at|for|with|from|by|about|as|into|onto|upon|"
    r"is|are|was|were|be|been|has|have|had|will|would|can|could|should|may|might|must|"
    r"he|she|it|we|they|you|i|he's|she's|it's|we're|they're|you're|i'm|that's|there's|what's|who's|"
    r"his|her|its|our|their|my|your|this|that|these|those|which|who|whom|whose|when|where|while|if|because|since|until|than)$",
    re.IGNORECASE,
)
ADJ_PULL_RX = re.compile(
    r"\b(such a|a|an|the|very|really|pretty|quite|so|too|his|her|their|our|my|your|its)\s+"
    r"(good|great|big|small|new|old|first|last|next|other|another|right|wrong|best|worst|whole|same|nice|bad|high|low|long|short|full|hard|easy)$",
    re.IGNORECASE,
)

def clean_and_reconstruct_sentences(raw_srt_text: str):
    parsed_cues = []
    for b in re.split(r"\r?\n\r?\n+", raw_srt_text.strip()):
        lines = [ln.strip() for ln in b.splitlines() if ln.strip()]
        ti = next((i for i, ln in enumerate(lines[:3]) if "-->" in ln), -1)
        if ti < 0:
            continue
        ts_parts = lines[ti].split("-->")
        if len(ts_parts) < 2:
            continue
        start_ms, end_ms = ts_to_ms(ts_parts[0]), ts_to_ms(ts_parts[1].split()[0])
        if end_ms <= start_ms:
            continue
        t_lines = []
        for ln in lines[ti + 1:]:
            cl = re.sub(r"\{\\an\d+\}", "", html.unescape(html.unescape(re.sub(r"<[^>]+>", " ", ln)))).strip()
            if cl and not re.match(r"^(WEBVTT|Kind:|Language:)", cl, re.I) and (not t_lines or t_lines[-1] != cl):
                t_lines.append(cl)
        if t_lines:
            parsed_cues.append([start_ms, end_ms, t_lines])

    deduped, recent_lines = [], []
    for start_ms, end_ms, t_lines in parsed_cues:
        new_lines = []
        for ln in t_lines:
            norm_ln = re.sub(r"\s+", " ", ln).strip().lower()
            if not any(rl == norm_ln and (start_ms - prev_e) <= 450 for prev_e, rl in recent_lines):
                new_lines.append(ln)
                recent_lines.append((end_ms, norm_ln))
                if len(recent_lines) > 6:
                    recent_lines.pop(0)
        if not new_lines:
            if deduped and start_ms - deduped[-1][1] <= 500:
                deduped[-1][1] = max(deduped[-1][1], end_ms)
            continue
        joined = " ".join(new_lines).strip()
        if deduped and deduped[-1][2].lower() == joined.lower():
            deduped[-1][1] = max(deduped[-1][1], end_ms)
        else:
            deduped.append([start_ms, end_ms, joined])

    for i in range(len(deduped) - 1):
        cur_s, cur_e, cur_txt = deduped[i]
        nxt_s, nxt_e, nxt_txt = deduped[i + 1]
        if nxt_s - cur_e > 2000 or cur_txt.endswith((".", "!", "?", ":", ";")):
            continue
        if ADJ_PULL_RX.search(cur_txt):
            nw = nxt_txt.split()
            if len(nw) >= 2:
                deduped[i][2], deduped[i + 1][2] = f"{cur_txt} {nw[0]}".strip(), " ".join(nw[1:]).strip()
        for _ in range(2):
            mt = TRAILING_SPLIT_RX.match(deduped[i][2])
            if mt and len(mt.group(1).strip()) >= 6:
                deduped[i][2] = mt.group(1).strip()
                deduped[i + 1][2] = f"{mt.group(2).strip()} {deduped[i + 1][2]}".strip()
            else:
                break

    merged, i = [], 0
    while i < len(deduped):
        cur_s, cur_e, cur_txt = deduped[i]
        if not cur_txt.strip():
            i += 1
            continue
        while i + 1 < len(deduped):
            nxt_s, nxt_e, nxt_txt = deduped[i + 1]
            comb = f"{cur_txt} {nxt_txt}".strip()
            if (nxt_s - cur_e) <= 450 and (nxt_e - cur_s) <= 6500 and len(comb) <= 88:
                cur_e, cur_txt = nxt_e, comb
                i += 1
            else:
                break
        merged.append([cur_s, cur_e, cur_txt])
        i += 1
    for idx_m in range(len(merged) - 1):
        if merged[idx_m][1] > merged[idx_m + 1][0]:
            merged[idx_m][1] = max(merged[idx_m][0] + 150, merged[idx_m + 1][0] - 20)
    return merged

def sanitize_subtitle_text(raw_txt: str) -> str:
    t = html.unescape(html.unescape(str(raw_txt or "")))
    t = re.sub(r"<[^>]+>|\{\\[^}]+\}|\\u[0-9a-fA-F]{4}", " ", t)
    t = re.sub("[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]", "", t)
    t = re.sub(r"\s*(?:>>|>>>|♪|♫|\[מוזיקה\]|\[Music\]|\[Applause\])\s*", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip()

def has_hebrew(text: str) -> bool:
    return any("\u0590" <= ch <= "\u05FF" for ch in str(text or ""))

def format_rtl_hebrew_line(line: str) -> str:
    clean = sanitize_subtitle_text(line)
    if not clean:
        return ""
    if has_hebrew(clean):
        if len(clean) > 46 and " " in clean:
            words, mid, cur_len, split_idx = clean.split(" "), len(clean) // 2, 0, 0
            for wi, w in enumerate(words):
                cur_len += len(w) + 1
                if cur_len >= mid:
                    split_idx = max(1, wi + 1)
                    break
            if 0 < split_idx < len(words):
                return f"\u202b\u200f{' '.join(words[:split_idx]).strip()}\u200f\u202c\r\n\u202b\u200f{' '.join(words[split_idx:]).strip()}\u200f\u202c"
        return f"\u202b\u200f{clean}\u200f\u202c"
    return clean

def build_srt_string(cues_list) -> str:
    out = []
    for s_ms, e_ms, txt in cues_list:
        fmt = format_rtl_hebrew_line(txt)
        if fmt:
            out.append(f"{len(out) + 1}\r\n{ms_to_ts(s_ms)} --> {ms_to_ts(e_ms)}\r\n{fmt}")
    # UTF-8 BOM + RTL markers
    return "\ufeff" + "\r\n\r\n".join(out) + "\r\n"

gtrans_429_event = threading.Event()

def _gtrans_he(text: str, timeout: int = 18, retries: int = 2) -> str:
    if gtrans_429_event.is_set():
        return ""
    saw_429 = False
    for cid in ("gtx", "dict-chrome-ex"):
        if gtrans_429_event.is_set():
            return ""
        for att in range(retries):
            try:
                r = requests.post(
                    "https://translate.googleapis.com/translate_a/single",
                    params={"client": cid, "sl": "auto", "tl": "iw", "dt": "t", "dj": "1"},
                    data={"q": text},
                    headers={**HTTP_HEADERS, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
                    timeout=timeout,
                )
                if r.status_code == 200:
                    if "text/html" in (r.headers.get("content-type") or "").lower() or "/sorry" in (r.url or "").lower():
                        saw_429 = True
                        break
                    tr = "".join(s.get("trans", "") for s in (r.json().get("sentences") or []) if "trans" in s).strip()
                    if tr:
                        return tr
                    break
                if r.status_code == 429:
                    saw_429 = True
                    time.sleep(1.5 * (att + 1))
                elif r.status_code in (502, 503):
                    time.sleep(1.2 * (att + 1))
                else:
                    break
            except Exception:
                time.sleep(0.4)
    if saw_429:
        gtrans_429_event.set()
    return ""

def translate_batch_guaranteed(batch_cues, _depth: int = 0):
    if not batch_cues:
        return []
    joined = "\n".join(c[2].replace("\n", " ").strip() for c in batch_cues)
    if not gtrans_429_event.is_set():
        full_tr = _gtrans_he(joined, timeout=18, retries=2)
        if full_tr and has_hebrew(full_tr):
            tr_lines = [ln.strip() for ln in full_tr.splitlines() if ln.strip()]
            if len(tr_lines) == len(batch_cues):
                return [[c[0], c[1], t] for c, t in zip(batch_cues, tr_lines)]
        if (not gtrans_429_event.is_set()) and len(batch_cues) > 4 and _depth < 3:
            mid = len(batch_cues) // 2
            return translate_batch_guaranteed(batch_cues[:mid], _depth + 1) + translate_batch_guaranteed(batch_cues[mid:], _depth + 1)

    try:
        from deep_translator import GoogleTranslator
        dt = GoogleTranslator(source="auto", target="iw").translate(joined)
        if dt and has_hebrew(dt):
            tr_lines = [ln.strip() for ln in dt.splitlines() if ln.strip()]
            if len(tr_lines) == len(batch_cues):
                return [[c[0], c[1], t] for c, t in zip(batch_cues, tr_lines)]
    except Exception:
        pass

    if gtrans_429_event.is_set():
        return [[s_ms, e_ms, orig_txt] for s_ms, e_ms, orig_txt in batch_cues]

    out_batch = []
    for s_ms, e_ms, orig_txt in batch_cues:
        if gtrans_429_event.is_set():
            out_batch.append([s_ms, e_ms, orig_txt])
            continue
        cand = _gtrans_he(orig_txt, timeout=12, retries=1)
        out_batch.append([s_ms, e_ms, cand if (cand and has_hebrew(cand)) else orig_txt])
    return out_batch

def translate_cues_to_hebrew(cues_list):
    if not cues_list:
        return None
    if sum(1 for ch in " ".join(c[2] for c in cues_list[:15]) if "\u0590" <= ch <= "\u05FF") >= 5:
        return cues_list
    print(f"Translating {len(cues_list)} reconstructed sentences to Hebrew...", flush=True)
    batches = [cues_list[i:i + 25] for i in range(0, len(cues_list), 25)]
    translated = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        for rb in ex.map(translate_batch_guaranteed, batches):
            translated.extend(rb)
    if gtrans_429_event.is_set():
        print("Google Translate hit HTTP 429 — circuit breaker stopped redundant retries.", flush=True)
    he_chars = sum(1 for _, _, txt in translated for ch in txt if "\u0590" <= ch <= "\u05FF")
    print(f"Translation finished: {len(translated)} cues, {he_chars} Hebrew chars.", flush=True)
    return translated if he_chars > 0 else None

def _clip_cues_window(cues_in):
    if is_subs_only or not (clip_start or clip_end):
        return cues_in
    ws = ts_to_ms(clip_start) if clip_start else 0
    we = ts_to_ms(clip_end) if clip_end else 10**12
    if we <= ws:
        return cues_in
    sliced = []
    for s, e, t in cues_in:
        if e <= ws or s >= we:
            continue
        ns, ne = max(0, s - ws), min(we - ws, e - ws)
        if ne - ns >= 120:
            sliced.append([ns, ne, t])
    return sliced or cues_in

def _scale_cues_for_speed(cues_in, do_scale: bool = False):
    if is_subs_only or not do_scale:
        return cues_in
    try:
        sp = float(speed_val or 1.0)
    except Exception:
        return cues_in
    if sp <= 0 or abs(sp - 1.0) < 0.01:
        return cues_in
    return [[int(s / sp), max(int(s / sp) + 120, int(e / sp)), t] for s, e, t in cues_in]

def fetch_subtitles_for_url(video_url: str, base_stem: str = None, force_single: bool = False, proxy_url: str = "", info_json_path: Path = None, apply_speed_scale: bool = False):
    if subs_dir.exists():
        shutil.rmtree(subs_dir, ignore_errors=True)
    subs_dir.mkdir(parents=True, exist_ok=True)
    is_pl_sub = (mode == "collection" and not force_single)
    out_tmpl = f"/tmp/subs/{base_stem}.%(ext)s" if base_stem else "/tmp/subs/%(title).120B [%(id)s].%(ext)s"
    base_sub_cmd = [
        "python3", "-m", "yt_dlp", "--ignore-config", "--rm-cache-dir", "--force-ipv4",
        "--skip-download", "--ignore-errors", "--sleep-requests", "1", "--js-runtimes", "deno",
        "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
        "--sub-format", "vtt/srt/best", "-o", out_tmpl,
    ]
    if not is_pl_sub:
        base_sub_cmd.append("--no-playlist")
    if proxy_url:
        base_sub_cmd += ["--proxy", proxy_url]
    elif has_ck:
        base_sub_cmd += ["--cookies", str(cookie_file)]

    direct_tracks = {}
    sub_ip_ban = False
    def _is_sub_ban_err(err_txt: str) -> bool:
        low_s = str(err_txt or "").lower()
        return any(k in low_s for k in ("http error 403", "http error 429", "page needs to be reloaded", "sign in to confirm", "failed to extract any player response"))

    def detect_best_sub_candidates():
        nonlocal sub_ip_ban
        if is_pl_sub:
            return False, []
        info = None
        if info_json_path and info_json_path.exists():
            try:
                info = json.loads(info_json_path.read_text(encoding="utf-8", errors="replace"))
                print(f"Subtitle pre-detect loaded from local info.json ({info_json_path.name}) — 0 extra yt-dlp calls!", flush=True)
            except Exception:
                info = None
        if info is None:
            probe_cmd = [
                "python3", "-m", "yt_dlp", "--ignore-config", "--force-ipv4", "--skip-download", "--no-playlist",
                "--dump-single-json", "--no-warnings", "--js-runtimes", "deno",
                "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
            ] + (["--proxy", proxy_url] if proxy_url else (["--cookies", str(cookie_file)] if has_ck else []))
            try:
                pr = subprocess.run(probe_cmd + [video_url], capture_output=True, text=True, timeout=45, check=False)
                if pr.returncode != 0 or not pr.stdout.strip():
                    if _is_sub_ban_err(pr.stderr):
                        sub_ip_ban = True
                    return False, []
                info = json.loads(pr.stdout)
            except Exception:
                return False, []

        for s_flag, s_dict in (("--write-subs", info.get("subtitles") or {}), ("--write-auto-subs", info.get("automatic_captions") or {})):
            for lk, fmts in s_dict.items():
                if not lk or lk == "live_chat" or not isinstance(fmts, list):
                    continue
                bf = next((f for f in fmts if isinstance(f, dict) and f.get("url") and str(f.get("ext") or "").lower() in ("vtt", "srt")), None)
                if bf:
                    direct_tracks[(s_flag, lk)] = bf["url"]

        manual = [k for k in (info.get("subtitles") or {}) if k and k != "live_chat"]
        auto = [k for k in (info.get("automatic_captions") or {}) if k and k != "live_chat"]
        vlang = str(info.get("language") or "").strip().lower()
        vbase = vlang.split("-")[0] if vlang else ""
        if not manual and not auto:
            print(f"Subtitle pre-detect confirmed: 0 subtitles available (vlang={vlang}). Skipping fallback loop.", flush=True)
            return True, []

        plan, seen = [], set()
        def add_plan(flag, code, is_he):
            if code and (flag, code) not in seen:
                seen.add((flag, code))
                plan.append((flag, code, is_he))

        for k in manual:
            if k.lower() in ("he", "iw") or k.lower().startswith(("he-", "iw-")):
                add_plan("--write-subs", k, True)
        for k in auto:
            if k.lower() in ("he-orig", "iw-orig") or (vbase in ("he", "iw") and k.lower() in ("he", "iw")):
                add_plan("--write-auto-subs", k, True)
        if manual:
            pm = next((k for k in manual if vlang and (k.lower() == vlang or k.lower().startswith(vbase + "-"))), None)
            if not pm:
                pm = next((k for k in manual if k.lower().split("-")[0] in ("en", "es", "fr", "pt", "de", "it")), manual[0])
            add_plan("--write-subs", pm, pm.lower().startswith(("he", "iw")))
        if vlang:
            for vc in (f"{vlang}-orig", f"{vbase}-orig", vlang, vbase):
                ma = next((k for k in auto if k.lower() == vc), None)
                if ma:
                    add_plan("--write-auto-subs", ma, ma.lower().startswith(("he", "iw")))
        orig_autos = [k for k in auto if k.lower().endswith("-orig")]
        for plg in ("he", "iw", "en", "es", "fr", "pt", "de", "it"):
            mpo = next((k for k in orig_autos if k.lower() == f"{plg}-orig" or k.lower().startswith(f"{plg}-")), None)
            if mpo:
                add_plan("--write-auto-subs", mpo, mpo.lower().startswith(("he", "iw")))
        for k in orig_autos[:2]:
            add_plan("--write-auto-subs", k, k.lower().startswith(("he", "iw")))
        for fb in ("he", "iw", "en", "es"):
            if fb in auto:
                add_plan("--write-auto-subs", fb, fb in ("he", "iw"))
        if not plan and auto:
            add_plan("--write-auto-subs", auto[0], auto[0].lower().startswith(("he", "iw")))
        print(f"Subtitle pre-detect plan: {plan[:4]} (manual={len(manual)}, auto={len(auto)}, vlang={vlang})", flush=True)
        return True, plan[:4]

    def _process_raw_sub_text(raw_txt: str, clean_stem: str, lang_code: str, expect_he: bool):
        clean_cues = _clip_cues_window(clean_and_reconstruct_sentences(raw_txt))
        if not clean_cues:
            return None
        if expect_he or has_hebrew(" ".join(c[2] for c in clean_cues[:12])):
            dst = subs_dir / f"{clean_stem}.he.srt"
            dst.write_text(build_srt_string(_scale_cues_for_speed(clean_cues, apply_speed_scale)), encoding="utf-8")
            return dst, len(clean_cues), lang_code, f"כתוביות בעברית ({len(clean_cues)} שורות)"
        he_cues = translate_cues_to_hebrew(clean_cues)
        if he_cues:
            dst = subs_dir / f"{clean_stem}.he.srt"
            dst.write_text(build_srt_string(_scale_cues_for_speed(he_cues, apply_speed_scale)), encoding="utf-8")
            return dst, len(he_cues), f"{lang_code}->he", f"מתורגם לעברית מ-{lang_code} ({len(he_cues)} שורות)"
        dst = subs_dir / f"{clean_stem}.orig.srt"
        dst.write_text(build_srt_string(_scale_cues_for_speed(clean_cues, apply_speed_scale)), encoding="utf-8")
        return dst, len(clean_cues), lang_code, f"כתוביות מקור {lang_code} ({len(clean_cues)} שורות)"

    sub_clients = [[], ["--extractor-args", "youtube:player_client=default,web_safari"]] if has_ck else [[], ["--extractor-args", "youtube:player_client=android_vr,mweb"]]
    if proxy_url:
        sub_clients = sub_clients[:1]

    def try_download_single_sub(flag_args, lang_code, expect_he):
        nonlocal sub_ip_ban
        if len(flag_args) == 1 and (flag_args[0], lang_code) in direct_tracks and base_stem and not is_pl_sub:
            for px_d in ([{"http": proxy_url, "https": proxy_url}, None] if proxy_url else [None]):
                try:
                    dr = requests.get(direct_tracks[(flag_args[0], lang_code)], headers=HTTP_HEADERS, proxies=px_d, timeout=15)
                    if dr.status_code == 200 and len(dr.text) > 30 and "-->" in dr.text:
                        res_d = _process_raw_sub_text(dr.text, base_stem, lang_code, expect_he)
                        if res_d:
                            dst_f, cues_n, src_tag, lbl = res_d
                            telemetry["sub_cues"], telemetry["sub_source"] = cues_n, src_tag
                            print(f"Direct VTT subtitle fetch succeeded ({lang_code}, via={'proxy' if px_d else 'direct'}) — 0 extra yt-dlp runs!", flush=True)
                            return [dst_f], lbl
                except Exception:
                    pass
        for extra_cl in sub_clients:
            sub_p = subprocess.run(base_sub_cmd + extra_cl + flag_args + ["--sub-langs", lang_code, video_url], capture_output=True, text=True, check=False)
            if sub_p.stderr and _is_sub_ban_err(sub_p.stderr):
                sub_ip_ban = True
                print(f"Subtitle fetch hit IP/rate block for {lang_code} — stopping redundant yt-dlp retries.", flush=True)
                break
            cand_files = [p for p in list(subs_dir.glob("*.vtt")) + list(subs_dir.glob("*.srt")) if p.stat().st_size > 15 and not p.name.endswith("live_chat.json")]
            if not cand_files:
                continue
            if is_subs_only and is_pl_sub:
                by_stem = {}
                for cf in cand_files:
                    stk = re.sub(r"(\.f\d+(?:-\d+)?)?(\.[a-zA-Z0-9_-]+)?$", "", cf.stem)
                    if stk not in by_stem or cf.stat().st_size > by_stem[stk].stat().st_size:
                        by_stem[stk] = cf
                src_targets = list(by_stem.items())
            else:
                sf = max(cand_files, key=lambda p: p.stat().st_size)
                src_targets = [(re.sub(r"(\.f\d+(?:-\d+)?)?(\.[a-zA-Z0-9_-]+)?$", "", sf.stem), sf)]
            out_srts, total_cues_n, last_lbl = [], 0, ""
            for clean_stem, sf in src_targets:
                res_s = _process_raw_sub_text(sf.read_text(encoding="utf-8", errors="replace"), clean_stem, lang_code, expect_he)
                if not res_s:
                    continue
                dst_f, cues_n, src_tag, lbl = res_s
                out_srts.append(dst_f)
                total_cues_n += cues_n
                telemetry["sub_source"] = src_tag
                last_lbl = lbl
            for p in cand_files:
                if p not in out_srts:
                    p.unlink(missing_ok=True)
            if out_srts:
                telemetry["sub_cues"] = total_cues_n
                return out_srts, (f"{len(out_srts)} קובצי כתוביות ({total_cues_n} שורות)" if len(out_srts) > 1 else last_lbl)
        return None

    probe_ok, detected_plan = detect_best_sub_candidates()
    if probe_ok and not detected_plan:
        return [], "לסרטון זה אין כתוביות ביוטיוב"
    for sub_flag, lang_code, is_he in detected_plan:
        res_sub = try_download_single_sub([sub_flag], lang_code, is_he)
        if res_sub:
            return res_sub
        if sub_ip_ban:
            break
    if (not probe_ok) and (not sub_ip_ban):
        fb_langs = (("he,iw", True), ("en-orig", False)) if proxy_url else (("he,iw", True), ("en-orig", False), ("en", False), ("es-orig", False), ("es", False), ("fr-orig", False))
        for fb_lang, is_he in fb_langs:
            res_sub = try_download_single_sub(["--write-subs", "--write-auto-subs"], fb_lang, is_he)
            if res_sub:
                return res_sub
            if sub_ip_ban:
                break
    return [], ("SUB_IP_BAN" if sub_ip_ban else "לסרטון זה אין כתוביות ביוטיוב")

if is_subs_only:
    quality_report = "כתוביות בלבד (SRT)"
    ok_sub_labels, saw_sub_ban = [], False
    for cur_url in target_urls:
        srt_list, q_label = fetch_subtitles_for_url(cur_url)
        if srt_list:
            ok_sub_labels.append(q_label)
            for s_file in srt_list:
                shutil.copy2(str(s_file), str(out_dir / s_file.name))
        elif q_label == "SUB_IP_BAN":
            saw_sub_ban = True
    if ok_sub_labels:
        quality_report = ok_sub_labels[0] if len(ok_sub_labels) == 1 else f"{len(ok_sub_labels)}/{len(target_urls)} קובצי כתוביות בעברית"
    files = [p for p in out_dir.rglob("*") if p.is_file() and p.stat().st_size > 0]
    if not files:
        if saw_sub_ban:
            raise SystemExit("::error::AZURE_IP_403_BANNED|חסימת IP זמנית בשליפת כתוביות — קופץ לשרת נקי")
        raise SystemExit("::error::לא נמצאו כתוביות עבור קישור זה")
    primary_file = files[0]
else:
    AUDIO_FMT_MAP = {
        "audio": ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "320K", "--embed-thumbnail", "--embed-metadata"],
        "audio_m4a": ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a", "--audio-quality", "0", "--embed-thumbnail", "--embed-metadata"],
        "audio_opus": ["-f", "ba[acodec=opus]/ba/b", "-x", "--audio-format", "opus", "--audio-quality", "0", "--embed-metadata"],
        "audio_flac": ["-f", "ba/b", "-x", "--audio-format", "flac", "--audio-quality", "0", "--embed-thumbnail", "--embed-metadata"],
        "audio_wav": ["-f", "ba/b", "-x", "--audio-format", "wav", "--audio-quality", "0"],
    }
    def get_fmt_args(strict_hd: bool, prefer_hls: bool = False):
        if quality in AUDIO_FMT_MAP:
            return AUDIO_FMT_MAP[quality]
        if strict_hd and req_h >= 720:
            if quality in ("2160", "1440", "1080", "720"):
                fmt, sort_res = f"bv*[height<={req_h}][height>=720]+ba/b[height<={req_h}][height>=720]", f"res:{req_h}"
            else:
                fmt, sort_res = "bv*[height<=2160][height>=1080]+ba/bv*[height>=720]+ba/b[height>=720]", "res:2160"
        else:
            fmt, sort_res = f"bv*[height<={req_h}]+ba/b[height<={req_h}]/bv*+ba/b", f"res:{req_h}"
        if prefer_hls:
            fmt = f"bv*[protocol*=m3u8][height<={req_h}]+ba[protocol*=m3u8]/b[protocol*=m3u8][height<={req_h}]/bv*[protocol*=m3u8]+ba/b[protocol*=m3u8]/{fmt}"
            sort_str = f"proto:m3u8_native,{sort_res},fps,vcodec:vp9:av01:h264,ext:mp4"
        elif quality in ("best", "2160", "1440"):
            sort_str = f"{sort_res},fps,vcodec:vp9:av01:h264,acodec:m4a:aac:opus,ext:mp4:m4a"
        else:
            sort_str = f"{sort_res},fps,vcodec:h264:vp9:av01,acodec:m4a:aac:opus,ext:mp4:m4a"
        return ["-f", fmt, "-S", sort_str, "--merge-output-format", "mp4", "--no-embed-chapters", "--postprocessor-args", "Merger+ffmpeg:-dn -map_chapters -1 -movflags +faststart"]

    def inspect_media_quality(fpath: Path):
        try:
            data = json.loads(_ffprobe(["-show_entries", "stream=codec_type,codec_name,width,height,bit_rate:format=bit_rate,duration", "-of", "json", str(fpath)]) or "{}")
            streams = data.get("streams") or []
            v_s = next((s for s in streams if s.get("codec_type") == "video" and int(s.get("height") or 0) > 0), None)
            a_s = next((s for s in streams if s.get("codec_type") == "audio"), None)
            dur = float((data.get("format") or {}).get("duration") or 0)
            if v_s:
                w, h = int(v_s.get("width") or 0), int(v_s.get("height") or 0)
                hi, lo, vc = max(w, h), min(w, h), (v_s.get("codec_name") or "mp4").upper()
                tag_q = f"4K UHD ({lo}p)" if (lo >= 2160 or hi >= 3840) else (f"2K QHD ({lo}p)" if (lo >= 1440 or hi >= 2560) else (f"Full HD ({lo}p)" if (lo >= 1080 or hi >= 1920) else (f"HD ({lo}p)" if (lo >= 720 or hi >= 1280) else f"{lo}p")))
                return max(h, lo), dur, f"{tag_q} [{w}x{h} • {vc}]"
            if a_s:
                ac = (a_s.get("codec_name") or fpath.suffix.lstrip(".")).upper()
                br = int(a_s.get("bit_rate") or (data.get("format") or {}).get("bit_rate") or 0)
                return 0, dur, f"אודיו ({ac}{f' {round(br / 1000)}kbps' if br > 0 else ''})"
        except Exception:
            pass
        return 0, 0.0, "תקין"

    def _shared_dl_flags():
        fl = ["--yes-playlist", "--playlist-end", "35"] if mode == "collection" else ["--no-playlist"]
        if clip_start or clip_end:
            fl += ["--download-sections", f"*{clip_start or '00:00:00'}-{clip_end or 'inf'}", "--force-keyframes-at-cuts"]
        if sb:
            fl += ["--sponsorblock-remove", "sponsor,intro,outro,selfpromo,interaction"]
        if chapters and not is_audio:
            fl += ["--split-chapters"]
        return fl

    extra_args = ["--force-ipv4", "--no-mtime", "--js-runtimes", "deno", "--sleep-requests", "0.5", "--http-chunk-size", "10M", "--socket-timeout", "25"] + _shared_dl_flags()
    px_extra_args = ["--force-ipv4", "--no-mtime", "--js-runtimes", "deno", "--http-chunk-size", "4M"] + _shared_dl_flags()
    pot_ep = "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"

    # Iron Rule: NO Pre-Flight probe before yt-dlp; Attempt 1 = default,web_safari + Cookies + Auto PO-Token
    attempts = []
    if has_ck:
        attempts.append(("2026 Native Default + Cookies (default,web_safari + Auto PO-Token)", ["--cookies", str(cookie_file), "--concurrent-fragments", "8", "--extractor-args", "youtube:player_client=default,web_safari", "--extractor-args", pot_ep], True, False))
        attempts.append(("2026 TV+Safari HLS + Cookies + Impersonate Chrome (No XFF)", ["--cookies", str(cookie_file), "--impersonate", "chrome", "--concurrent-fragments", "8", "--extractor-args", "youtube:player_client=tv,web_safari,mweb", "--extractor-args", pot_ep], True, True))
    attempts.append(("2026 Native Clean (No Cookies, No XFF + Auto PO-Token)", ["--concurrent-fragments", "8", "--extractor-args", "youtube:player_client=default,web_safari,android_vr", "--extractor-args", pot_ep], True, False))
    attempts.append(("2026 Geo-XFF HD + TV/Safari + Cookies (StrictHD)", (["--cookies", str(cookie_file)] if has_ck else []) + ["--xff", geo, "--impersonate", "chrome", "--concurrent-fragments", "6", "--extractor-args", "youtube:player_client=tv,web_safari,default", "--extractor-args", pot_ep], True, False))
    attempts.append(("2026 Universal Resilient Fallback (No-POT + HLS)", (["--cookies", str(cookie_file)] if has_ck else []) + ["--xff", geo, "--impersonate", "chrome", "--concurrent-fragments", "4", "--extractor-args", "youtube:player_client=tv,web_safari,mweb,android_vr,ios"], False, True))

    def _reset_stage():
        if stage_dir.exists():
            shutil.rmtree(stage_dir, ignore_errors=True)
        stage_dir.mkdir(parents=True, exist_ok=True)

    def _stage_media():
        sf = [p for p in stage_dir.rglob("*") if p.is_file() and not p.name.endswith((".part", ".ytdl", ".temp")) and p.stat().st_size > 0]
        exts = (".mp3", ".m4a", ".flac", ".wav", ".opus") if is_audio else (".mp4", ".mkv", ".webm")
        return sf, [p for p in sf if p.suffix.lower() in exts and not re.search(r"\.f\d+(?:-\d+)?$", p.stem)]

    def _build_ytdlp_cmd(args, strict_hd, prefer_hls, cur_url):
        return [
            "python3", "-m", "yt_dlp", "--ignore-config", "--rm-cache-dir", "--write-info-json",
            "--ffmpeg-location", "/usr/bin/ffmpeg", "--retries", "8", "--fragment-retries", "8", "--file-access-retries", "5",
            "-o", "/tmp/stage/%(title).150B [%(id)s].%(ext)s",
        ] + args + get_fmt_args(strict_hd, prefer_hls) + extra_args + [cur_url]

    def extract_vid_id(u: str) -> str:
        s_u = str(u or "")
        mbr = re.findall(r"\[([a-zA-Z0-9_-]{11})\]", s_u)
        if mbr:
            return mbr[-1]
        m = re.search(r"(?:v=|youtu\.be/|/shorts/|/live/|/embed/)([a-zA-Z0-9_-]{11})", s_u)
        return m.group(1) if m else ""

    def _it_client(name: str, gl_code: str = "US"):
        if name == "ANDROID_VR":
            return ({"clientName": "ANDROID_VR", "clientVersion": "1.61.48", "deviceMake": "Oculus", "deviceModel": "Quest 3", "osName": "Android", "osVersion": "12L", "hl": "en", "gl": gl_code},
                    "com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; Quest 3)")
        if name == "IOS":
            return ({"clientName": "IOS", "clientVersion": "20.10.4", "deviceMake": "Apple", "deviceModel": "iPhone16,2", "osName": "iPhone", "osVersion": "18.3.2.22D82", "hl": "en", "gl": gl_code},
                    "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)")
        return ({"clientName": "WEB", "clientVersion": "2.20261121.00.00", "hl": "en", "gl": gl_code}, HTTP_HEADERS["User-Agent"])

    def _pick_direct_streams_from_player(j_res: dict, target_h: int):
        sd = j_res.get("streamingData") or {}
        adap = [f for f in (sd.get("adaptiveFormats") or []) if isinstance(f, dict) and f.get("url")]
        muxed = [f for f in (sd.get("formats") or []) if isinstance(f, dict) and f.get("url")]
        hls_u = str(sd.get("hlsManifestUrl") or "")
        v_cands = [f for f in adap if str(f.get("mimeType") or "").startswith("video/") and int(f.get("height") or 0) > 0]
        a_cands = [f for f in adap if str(f.get("mimeType") or "").startswith("audio/")]

        best_v = None
        if v_cands:
            pool_v = [f for f in v_cands if int(f.get("height") or 0) <= target_h] or v_cands
            if target_h >= 720:
                hd_v = [f for f in pool_v if int(f.get("height") or 0) >= 720]
                if hd_v:
                    pool_v = hd_v
            best_v = max(pool_v, key=lambda f: (int(f.get("height") or 0), int(f.get("fps") or 0), 3 if "vp9" in str(f.get("mimeType") or "").lower() else (2 if "avc1" in str(f.get("mimeType") or "").lower() else (1 if "av01" in str(f.get("mimeType") or "").lower() else 0)), int(f.get("bitrate") or 0)))

        best_a = None
        if a_cands:
            def _akey(f):
                mt, at = str(f.get("mimeType") or "").lower(), f.get("audioTrack") or {}
                return (1 if (not at or "original" in str(at.get("displayName") or "").lower()) else 0, 1 if (not at or at.get("audioIsDefault") or str(at.get("id") or "").endswith(".4")) else 0, 2 if "mp4a" in mt else (1 if "opus" in mt else 0), int(f.get("bitrate") or 0))
            best_a = max(a_cands, key=_akey)

        best_mux = max(muxed, key=lambda f: (int(f.get("height") or 0), int(f.get("bitrate") or 0))) if muxed else None
        return best_v, best_a, best_mux, hls_u

    def probe_playability(vid: str, px: str = None, timeout_s: float = 4.5, gl_code: str = "US", test_stream: bool = False):
        if not vid:
            return "", "", 0.0, None
        proxies = {"http": px, "https": px} if px else None
        last_st, last_rsn, last_meta = "", "", None
        for cl_idx, cname in enumerate(("ANDROID_VR", "IOS", "WEB")):
            if test_stream and px and cl_idx == 2 and last_st.startswith(("STREAM_", "OK_NO_STREAM")):
                break
            cl_obj, ua_str = _it_client(cname, gl_code)
            try:
                r = requests.post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", json={"context": {"client": cl_obj}, "videoId": vid}, headers={"Content-Type": "application/json", "User-Agent": ua_str}, proxies=proxies, timeout=timeout_s)
                if r.status_code != 200:
                    last_st, last_rsn = f"HTTP_{r.status_code}", ""
                    if px and r.status_code in (400, 407, 502, 503, 504):
                        break
                    continue
                j_res = r.json()
                avail_cc = [str(c).upper() for c in (((j_res.get("microformat") or {}).get("playerMicroformatRenderer") or {}).get("availableCountries") or []) if len(str(c)) == 2]
                if avail_cc and not last_meta:
                    last_meta = {"available_countries": avail_cc}
                ps = j_res.get("playabilityStatus") or {}
                st, rsn = str(ps.get("status") or ""), str(ps.get("reason") or "")
                if st == "OK":
                    best_v, best_a, best_mux, hls_u = _pick_direct_streams_from_player(j_res, req_h)
                    if not ((best_v and best_a) or (is_audio and best_a) or hls_u or best_mux):
                        last_st, last_rsn = "OK_NO_STREAM", rsn
                        continue
                    if test_stream and px:
                        probe_target, probe_mode = (best_a["url"], "adap") if (is_audio and best_a) else ((best_v["url"], "adap") if (best_v and best_a) else ((hls_u, "hls") if hls_u else (best_mux["url"], "mux")))
                        try:
                            ts = time.time()
                            hdr_s = {"User-Agent": ua_str, **({} if probe_mode == "hls" else {"Range": "bytes=0-131071"})}
                            sr = requests.get(probe_target, headers=hdr_s, proxies=proxies, timeout=5.5, stream=True)
                            if sr.status_code in (200, 206):
                                got = 0
                                for ch in sr.iter_content(chunk_size=16384):
                                    got += len(ch)
                                    if got >= 65536 or (time.time() - ts) > 4.0:
                                        break
                                sr.close()
                                if got >= (600 if probe_mode == "hls" else 8192):
                                    kbps = round((got / 1024.0) / max(0.05, time.time() - ts), 1)
                                    return "OK", f"{cname}:{probe_mode}:{kbps}KB/s", kbps, {"player_json": j_res, "ua": ua_str, "client": cname, "mode": probe_mode, "available_countries": avail_cc}
                            else:
                                sr.close()
                                last_st, last_rsn = f"STREAM_HTTP_{sr.status_code}", cname
                        except Exception as st_err:
                            last_st, last_rsn = f"STREAM_ERR_{type(st_err).__name__}", str(st_err)[:40]
                        continue
                    return "OK", rsn, 1.0, {"player_json": j_res, "ua": ua_str, "client": cname, "available_countries": avail_cc}
                if st == "UNPLAYABLE" and "country" in rsn.lower():
                    return st, rsn, 0.0, {"available_countries": avail_cc}
                last_st, last_rsn = st, rsn
            except Exception as ex:
                last_st, last_rsn = f"ERR_{type(ex).__name__}", str(ex)[:60]
                if px:
                    break
        return last_st, last_rsn, 0.0, last_meta

    def _collect_proxy_candidates(countries_batch):
        cand_proxies, seen_px, sources = [], set(), []
        for cc in countries_batch:
            cu = cc.upper()
            cp = f"&country={cu}" if cu != "ALL" else ""
            sources += [
                f"https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=all&timeout=4500&proxy_format=protocolipport&format=text{cp}",
                f"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=4500{cp}&ssl=all&anonymity=all",
                f"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=4500{cp}",
            ]
            if cu != "ALL":
                sources += [
                    f"https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/{cu}/data.txt",
                    f"https://www.proxy-list.download/api/v1/get?type=http&country={cu}",
                    f"https://www.proxy-list.download/api/v1/get?type=socks5&country={cu}",
                ]
            else:
                sources += [
                    "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt",
                    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
                    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
                    "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt",
                    "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
                    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
                ]

        def _fetch_src(src):
            out_u = []
            try:
                r = requests.get(src, timeout=6)
                if r.status_code == 200:
                    proto = "socks5://" if "socks5" in src else "http://"
                    for ln in r.text.splitlines():
                        ln = ln.strip()
                        mf = re.match(r"^(https?|socks[45])://(\d+\.\d+\.\d+\.\d+:\d+)$", ln, re.I)
                        if mf:
                            out_u.append(f"{mf.group(1).lower()}://{mf.group(2)}")
                        elif re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", ln):
                            out_u.append(proto + ln)
            except Exception:
                pass
            return out_u

        with ThreadPoolExecutor(max_workers=12) as ex:
            for rl in ex.map(_fetch_src, sources):
                for u in rl:
                    if u not in seen_px:
                        seen_px.add(u)
                        cand_proxies.append(u)

        for cc in countries_batch[:2]:
            try:
                gn = "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc" + (f"&country={cc.upper()}" if cc.upper() != "ALL" else "")
                gr = requests.get(gn, timeout=5)
                if gr.ok:
                    for row in (gr.json().get("data") or []):
                        ip_s, port_s, protos = str(row.get("ip") or ""), str(row.get("port") or ""), row.get("protocols") or []
                        pr = "socks5://" if "socks5" in protos else ("http://" if "http" in protos else ("socks4://" if "socks4" in protos else ""))
                        if ip_s and port_s and pr:
                            full_px = f"{pr}{ip_s}:{port_s}"
                            if full_px not in seen_px:
                                seen_px.add(full_px)
                                cand_proxies.append(full_px)
            except Exception:
                pass
        return cand_proxies

    def discover_working_proxies_batch(target_vid: str, countries_batch, tried_urls: set):
        priority_px = []
        for env_name in ("CUSTOM_PROXY", "IL_PROXY"):
            val = os.environ.get(env_name, "").strip().strip("\"'")
            if val and val not in tried_urls:
                mask_secret(val)
                if env_name == "CUSTOM_PROXY" or "IL" in countries_batch:
                    st, _, kbps, meta = probe_playability(target_vid, px=val, timeout_s=6.0, gl_code="IL", test_stream=True)
                    priority_px.append((val, st != "OK" and has_ck, kbps if st == "OK" else 9999.0, meta))
        cand_proxies = [p for p in _collect_proxy_candidates(countries_batch) if p not in tried_urls]
        verified_ok, verified_login, px_lock = [], [], threading.Lock()
        check_vid = target_vid or "dQw4w9WgXcQ"
        gl_probe = countries_batch[0] if (countries_batch and len(countries_batch[0]) == 2) else "IL"

        def test_px(px):
            with px_lock:
                if sum(1 for x in verified_ok if x[2] >= 120.0) >= 4 or len(verified_ok) >= 8:
                    return
            st, rsn, kbps, meta = probe_playability(check_vid, px=px, timeout_s=3.8, gl_code=gl_probe, test_stream=True)
            if st == "OK" and meta:
                with px_lock:
                    verified_ok.append((px, False, kbps, meta))
            elif has_ck and st == "LOGIN_REQUIRED" and ("country" not in str(rsn or "").lower()):
                with px_lock:
                    if len(verified_login) < 2:
                        verified_login.append((px, True, 0.0, None))

        if cand_proxies:
            with ThreadPoolExecutor(max_workers=50) as ex:
                list(ex.map(test_px, cand_proxies[:200]))
        verified_ok.sort(key=lambda x: x[2], reverse=True)
        return priority_px + verified_ok[:6] + verified_login[:2]

    def _write_proxy_info_json(info_cache_dir: Path, stem: str, vid: str, player_json: dict):
        try:
            cap_tracks = (((player_json.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or [])
            subs_map, auto_map = {}, {}
            for tr in cap_tracks:
                lc, bu = str(tr.get("languageCode") or "").strip(), str(tr.get("baseUrl") or "").strip()
                if not lc or not bu:
                    continue
                entry = [{"ext": "vtt", "url": bu + ("&fmt=vtt" if "fmt=" not in bu else "")}]
                if str(tr.get("kind") or "").lower() == "asr":
                    auto_map[lc] = auto_map[f"{lc}-orig"] = entry
                else:
                    subs_map[lc] = entry
            vd = player_json.get("videoDetails") or {}
            (info_cache_dir / f"{stem}.info.json").write_text(json.dumps({"id": vid, "title": vd.get("title") or stem, "language": (cap_tracks[0].get("languageCode") if cap_tracks else ""), "subtitles": subs_map, "automatic_captions": auto_map}, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def _download_url_chunked_proxy(url: str, dst_path: Path, proxies: dict, ua_str: str, content_len: int, label: str, max_sec: int = 260, resume_entry: dict = None, refresh_url_fn=None):
        t0 = time.time()
        base_hdrs = {"User-Agent": ua_str, "Accept": "*/*", "Connection": "keep-alive"}
        if content_len and content_len > 0:
            chunk_sz = 2 * 1024 * 1024
            ranges = [(s, min(content_len - 1, s + chunk_sz - 1)) for s in range(0, content_len, chunk_sz)]
            total_chunks = len(ranges)
            if resume_entry is not None:
                done_chunks = resume_entry["done_chunks"]
                if (not dst_path.exists()) or dst_path.stat().st_size != content_len:
                    done_chunks.clear()
                    with open(dst_path, "wb") as fp: fp.truncate(content_len)
            else:
                done_chunks = set()
                with open(dst_path, "wb") as fp: fp.truncate(content_len)
            pending = [(idx, s, e) for idx, (s, e) in enumerate(ranges) if idx not in done_chunks]
            if not pending:
                print(f"  [DirectProxy] {label}: already 100% on disk ({round(content_len/1048576, 1)} MB) — skipping!", flush=True)
                return True, "cached"
            already_bytes = sum((ranges[i][1] - ranges[i][0] + 1) for i in done_chunks)
            if already_bytes > 0:
                print(f"  [DirectProxy] Resuming {label} from {round(already_bytes/1048576, 1)}/{round(content_len/1048576, 1)} MB ({len(done_chunks)}/{total_chunks} chunks on disk)...", flush=True)

            write_lock, refresh_lock = threading.Lock(), threading.Lock()
            state = {"url": url, "ua": ua_str, "refreshes": 0, "chunks_since_refresh": 0, "done_bytes": already_bytes, "session_bytes": 0, "failed": False, "err": "", "last_log": t0}

            def _try_refresh(failed_url: str, sc: int) -> bool:
                if not refresh_url_fn:
                    return False
                with refresh_lock:
                    if state["failed"]:
                        return False
                    if state["url"] != failed_url:
                        return True
                    if state["refreshes"] >= 6 or (state["refreshes"] > 0 and state["chunks_since_refresh"] == 0):
                        state["err"], state["failed"] = f"HTTP_{sc}_refresh_stop", True
                        return False
                    ref_res = refresh_url_fn()
                    new_u, new_ua = ref_res if isinstance(ref_res, tuple) else (ref_res, "")
                    if not new_u:
                        state["err"], state["failed"] = f"HTTP_{sc}_refresh_empty", True
                        return False
                    state["url"], state["refreshes"], state["chunks_since_refresh"] = new_u, state["refreshes"] + 1, 0
                    if new_ua:
                        state["ua"] = new_ua
                    print(f"  [DirectProxy] Refreshed {label} URL after HTTP {sc} (refresh #{state['refreshes']}, at {round(state['done_bytes']/1048576, 1)}/{round(content_len/1048576, 1)} MB)...", flush=True)
                    return True

            def _dl_chunk(item):
                c_idx, s_b, e_b = item
                need = e_b - s_b + 1
                for tr in range(4):
                    if state["failed"] or (time.time() - t0) > max_sec:
                        if not state["err"] and (time.time() - t0) > max_sec:
                            state["err"] = f"timeout>{max_sec}s"
                        return False
                    cur_u = state["url"]
                    try:
                        r = requests.get(cur_u, headers={**base_hdrs, "User-Agent": state["ua"], "Range": f"bytes={s_b}-{e_b}"}, proxies=proxies, timeout=(10, 18), stream=True)
                        if r.status_code in (403, 410):
                            sc = r.status_code; r.close()
                            if _try_refresh(cur_u, sc):
                                continue
                            with write_lock:
                                state["err"] = state["err"] or f"HTTP_{sc}"
                                state["failed"] = True
                            return False
                        if r.status_code not in (200, 206):
                            sc = r.status_code; r.close()
                            with write_lock: state["err"] = f"HTTP_{sc}"
                            time.sleep(0.5 * (tr + 1))
                            continue
                        buf = bytearray()
                        for blk in r.iter_content(chunk_size=65536):
                            if state["failed"]:
                                r.close(); return False
                            if blk:
                                buf.extend(blk)
                                if r.status_code == 200 and len(buf) >= need:
                                    break
                        r.close()
                        if len(buf) == need or (r.status_code == 200 and s_b == 0 and len(buf) >= need):
                            chunk_data = bytes(buf[:need])
                            with write_lock:
                                if c_idx in done_chunks:
                                    return True
                                with open(dst_path, "r+b") as fp_w:
                                    fp_w.seek(s_b); fp_w.write(chunk_data)
                                done_chunks.add(c_idx)
                                state["done_bytes"] += need
                                state["session_bytes"] += need
                                state["chunks_since_refresh"] += 1
                                now = time.time()
                                if (now - state["last_log"]) >= 5.0 or state["done_bytes"] >= content_len:
                                    state["last_log"] = now
                                    el = max(0.2, now - t0)
                                    sess_kbps = round((state["session_bytes"] / 1024.0) / el, 0)
                                    pct = round((state["done_bytes"] / content_len) * 100.0, 1)
                                    print(f"  [DirectProxy] {label}: {round(state['done_bytes']/1048576, 1)}/{round(content_len/1048576, 1)} MB ({pct}%) @ {int(sess_kbps)} KB/s", flush=True)
                                    if el >= 22.0 and sess_kbps < 28.0 and pct < 85.0:
                                        print(f"  [DirectProxy] {label} slow ({int(sess_kbps)} KB/s) — saving progress & switching proxy.", flush=True)
                                        state["err"], state["failed"] = f"slow_{int(sess_kbps)}KB/s", True
                                        return False
                            return True
                        with write_lock: state["err"] = f"short_read_{len(buf)}/{need}"
                    except Exception as ex:
                        with write_lock: state["err"] = type(ex).__name__
                        time.sleep(0.4 * (tr + 1))
                with write_lock: state["failed"] = True
                return False

            with ThreadPoolExecutor(max_workers=min(2, len(pending))) as ex:
                list(ex.map(_dl_chunk, pending))
            ok_done = len(done_chunks) == total_chunks and dst_path.exists() and dst_path.stat().st_size == content_len
            if not ok_done:
                print(f"  [DirectProxy] {label} stopped ({state['err'] or 'incomplete'}): saved {round(state['done_bytes']/1048576, 1)}/{round(content_len/1048576, 1)} MB ({len(done_chunks)}/{total_chunks} chunks).", flush=True)
            return ok_done, (state["err"] or ("ok" if ok_done else "incomplete"))

        try:
            r = requests.get(url, headers=base_hdrs, proxies=proxies, timeout=(8, 20), stream=True)
            if r.status_code not in (200, 206):
                sc = r.status_code; r.close(); return False, f"HTTP_{sc}"
            got = 0
            with open(dst_path, "wb") as fp:
                for blk in r.iter_content(chunk_size=65536):
                    if (time.time() - t0) > max_sec:
                        r.close(); return False, f"timeout>{max_sec}s"
                    if blk:
                        fp.write(blk); got += len(blk)
            r.close()
            return (got > 32768), ("ok" if got > 32768 else "too_small")
        except Exception as ex:
            return False, type(ex).__name__

    def _download_hls_playlist_proxy(m3u8_url: str, dst_path: Path, proxies: dict, ua_str: str, label: str, max_sec: int = 220) -> bool:
        t0, hdrs = time.time(), {"User-Agent": ua_str}
        try:
            rm = requests.get(m3u8_url, headers=hdrs, proxies=proxies, timeout=12)
            if rm.status_code != 200 or "#EXTM3U" not in rm.text or "#EXT-X-KEY" in rm.text:
                return False
            init_url, segs = "", []
            for ln in (x.strip() for x in rm.text.splitlines() if x.strip()):
                if ln.startswith("#EXT-X-MAP:"):
                    mm = re.search(r'URI="([^"]+)"', ln)
                    if mm: init_url = urllib.parse.urljoin(m3u8_url, mm.group(1))
                elif not ln.startswith("#"):
                    segs.append(urllib.parse.urljoin(m3u8_url, ln))
            if not segs:
                return False
            all_urls = ([init_url] if init_url else []) + segs
            seg_dir = dst_path.parent / (dst_path.stem + "_segs")
            seg_dir.mkdir(parents=True, exist_ok=True)
            state, lk = {"done": 0, "bytes": 0, "failed": False, "last_log": t0}, threading.Lock()

            def _dl_seg(pair):
                idx_s, su = pair
                sp = seg_dir / f"{idx_s:05d}.seg"
                for tr in range(3):
                    if state["failed"] or (time.time() - t0) > max_sec:
                        return False
                    try:
                        rs = requests.get(su, headers=hdrs, proxies=proxies, timeout=(7, 15))
                        if rs.status_code == 200 and rs.content:
                            sp.write_bytes(rs.content)
                            with lk:
                                state["done"] += 1; state["bytes"] += len(rs.content)
                                now = time.time()
                                if (now - state["last_log"]) >= 6.0 or state["done"] == len(all_urls):
                                    state["last_log"] = now
                                    print(f"  [DirectProxy HLS] {label}: {state['done']}/{len(all_urls)} segs ({round(state['bytes']/1048576, 1)} MB) @ {int((state['bytes']/1024.0)/max(0.2, now-t0))} KB/s", flush=True)
                            return True
                    except Exception:
                        time.sleep(0.4 * (tr + 1))
                state["failed"] = True
                return False

            with ThreadPoolExecutor(max_workers=4) as ex:
                ok_all = all(ex.map(_dl_seg, enumerate(all_urls)))
            if not ok_all or state["failed"]:
                return False
            with open(dst_path, "wb") as out_fp:
                for idx_s in range(len(all_urls)):
                    out_fp.write((seg_dir / f"{idx_s:05d}.seg").read_bytes())
            shutil.rmtree(seg_dir, ignore_errors=True)
            return dst_path.exists() and dst_path.stat().st_size > 16384
        except Exception:
            return False

    def _refresh_stream_url_on_proxy(cur_vid: str, px_url: str, target_itag: int, want_client: str = "IOS", target_clen: int = 0, gl_code: str = "IL"):
        proxies = {"http": px_url, "https": px_url}
        for cl_try in (want_client, "ANDROID_VR" if want_client == "IOS" else "IOS"):
            cl_obj, ua_str = _it_client(cl_try, gl_code)
            try:
                r = requests.post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", json={"context": {"client": cl_obj}, "videoId": cur_vid}, headers={"Content-Type": "application/json", "User-Agent": ua_str}, proxies=proxies, timeout=7.0)
                if r.status_code != 200:
                    continue
                sd = r.json().get("streamingData") or {}
                for f in (sd.get("adaptiveFormats") or []) + (sd.get("formats") or []):
                    if isinstance(f, dict) and int(f.get("itag") or -1) == int(target_itag) and f.get("url"):
                        f_clen = int(f.get("contentLength") or 0)
                        if target_clen > 0 and f_clen > 0 and f_clen != target_clen:
                            continue
                        return str(f["url"]), ua_str
            except Exception:
                pass
        return "", ""

    def direct_download_via_proxy(cur_vid: str, px_url: str, probe_meta: dict, info_cache_dir: Path, resume_store: dict = None, resume_dir: Path = None):
        if not probe_meta or not probe_meta.get("player_json"):
            return None, "no_meta"
        j_res, ua_str, cl_name = probe_meta["player_json"], probe_meta.get("ua") or HTTP_HEADERS["User-Agent"], str(probe_meta.get("client") or "IOS")
        proxies = {"http": px_url, "https": px_url}
        raw_title = str((j_res.get("videoDetails") or {}).get("title") or cur_vid).strip()
        safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", raw_title)
        safe_title = re.sub(r"\s+", " ", safe_title).strip(" .")[:110] or cur_vid
        stem = f"{safe_title} [{cur_vid}]"
        best_v, best_a, _, hls_u = _pick_direct_streams_from_player(j_res, req_h)
        work_d = stage_dir / "direct_px"
        if work_d.exists(): shutil.rmtree(work_d, ignore_errors=True)
        work_d.mkdir(parents=True, exist_ok=True)
        if resume_dir is not None: resume_dir.mkdir(parents=True, exist_ok=True)

        def _slot(kind: str, fmt_obj: dict):
            itag, clen = int(fmt_obj.get("itag") or 0), int(fmt_obj.get("contentLength") or 0)
            if resume_store is not None and resume_dir is not None and itag > 0 and clen > 0:
                rk = f"{cur_vid}_{kind}_{itag}_{clen}"
                if rk not in resume_store:
                    resume_store[rk] = {"path": resume_dir / f"{rk}.part", "done_chunks": set(), "clen": clen, "itag": itag}
                return resume_store[rk]["path"], resume_store[rk], itag, clen
            return (work_d / f"{kind}.raw"), None, itag, clen

        if is_audio and best_a:
            a_path, a_res, a_itag, a_len = _slot("aud", best_a)
            a_ok, a_err = _download_url_chunked_proxy(best_a["url"], a_path, proxies, ua_str, a_len, "Audio", 180, a_res, (lambda: _refresh_stream_url_on_proxy(cur_vid, px_url, a_itag, cl_name, a_len)) if a_itag else None)
            if a_ok:
                enc_map = {"audio": (".mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]), "audio_m4a": (".m4a", ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]), "audio_opus": (".opus", ["-c:a", "libopus", "-b:a", "160k"]), "audio_flac": (".flac", ["-c:a", "flac"]), "audio_wav": (".wav", ["-c:a", "pcm_s16le"])}
                dst_ext, enc_args = enc_map.get(quality, enc_map["audio"])
                out_fp = stage_dir / f"{stem}{dst_ext}"
                if _ffmpeg_ok(["-i", str(a_path), "-vn", "-dn", "-map_chapters", "-1"] + enc_args + [str(out_fp)]) and out_fp.exists() and out_fp.stat().st_size > 8192:
                    _write_proxy_info_json(info_cache_dir, stem, cur_vid, j_res)
                    return out_fp, "ok"
            return None, f"audio_{a_err}"

        last_err = "no_stream"
        if best_v and best_a:
            v_h = int(best_v.get("height") or 0)
            a_path, a_res, a_itag, a_len = _slot("aud", best_a)
            v_path, v_res, v_itag, v_len = _slot("vid", best_v)
            print(f"  [DirectProxy] Downloading {v_h}p video (itag={v_itag}, {round(v_len/1048576, 1)} MB) + audio (itag={a_itag}, {round(a_len/1048576, 1)} MB) via {cl_name}...", flush=True)
            a_ok, a_err = _download_url_chunked_proxy(best_a["url"], a_path, proxies, ua_str, a_len, "Audio", 120, a_res, (lambda: _refresh_stream_url_on_proxy(cur_vid, px_url, a_itag, cl_name, a_len)) if a_itag else None)
            if not a_ok:
                last_err = f"aud:{a_err}"
            else:
                v_ok, v_err = _download_url_chunked_proxy(best_v["url"], v_path, proxies, ua_str, v_len, f"Video {v_h}p", 280, v_res, (lambda: _refresh_stream_url_on_proxy(cur_vid, px_url, v_itag, cl_name, v_len)) if v_itag else None)
                if v_ok:
                    for ext_m, tail_m in ((".mp4", ["-movflags", "+faststart"]), (".mkv", [])):
                        out_f = stage_dir / f"{stem}{ext_m}"
                        if _ffmpeg_ok(["-i", str(v_path), "-i", str(a_path), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-dn", "-map_chapters", "-1"] + tail_m + [str(out_f)]) and out_f.exists() and out_f.stat().st_size > 32768:
                            _write_proxy_info_json(info_cache_dir, stem, cur_vid, j_res)
                            return out_f, "ok"
                    last_err = "ffmpeg_mux_failed"
                else:
                    last_err = f"vid:{v_err}"
                    if v_res is not None and len(v_res["done_chunks"]) >= 4:
                        return None, last_err

        if hls_u:
            try:
                rm = requests.get(hls_u, headers={"User-Agent": ua_str}, proxies=proxies, timeout=12)
                if rm.status_code == 200 and "#EXTM3U" in rm.text:
                    audio_groups, variants = {}, []
                    lines = [l.strip() for l in rm.text.splitlines() if l.strip()]
                    for i_l, ln in enumerate(lines):
                        if ln.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in ln:
                            mg, mu = re.search(r'GROUP-ID="([^"]+)"', ln), re.search(r'URI="([^"]+)"', ln)
                            if mg and mu and (mg.group(1) not in audio_groups or "DEFAULT=YES" in ln):
                                audio_groups[mg.group(1)] = urllib.parse.urljoin(hls_u, mu.group(1))
                        elif ln.startswith("#EXT-X-STREAM-INF:") and i_l + 1 < len(lines) and not lines[i_l + 1].startswith("#"):
                            mr, mb, ma = re.search(r"RESOLUTION=\d+x(\d+)", ln), re.search(r"BANDWIDTH=(\d+)", ln), re.search(r'AUDIO="([^"]+)"', ln)
                            variants.append((int(mr.group(1)) if mr else 0, int(mb.group(1)) if mb else 0, ma.group(1) if ma else "", urllib.parse.urljoin(hls_u, lines[i_l + 1])))
                    if variants:
                        v_h, _, a_gid, v_m3u8 = max([v for v in variants if v[0] <= req_h] or variants, key=lambda x: (x[0], x[1]))
                        a_m3u8 = audio_groups.get(a_gid, "")
                        print(f"  [DirectProxy HLS] Downloading {v_h}p HLS stream via {cl_name}...", flush=True)
                        hv_p, ha_p = work_d / "hls_vid.ts", work_d / "hls_aud.ts"
                        if _download_hls_playlist_proxy(v_m3u8, hv_p, proxies, ua_str, f"HLS Video {v_h}p", 240):
                            has_a = bool(a_m3u8 and _download_hls_playlist_proxy(a_m3u8, ha_p, proxies, ua_str, "HLS Audio", 140))
                            out_mp4 = stage_dir / f"{stem}.mp4"
                            ff_h = (["-i", str(hv_p), "-i", str(ha_p), "-map", "0:v:0", "-map", "1:a:0"] if has_a else ["-i", str(hv_p)]) + ["-c", "copy", "-dn", "-map_chapters", "-1", "-movflags", "+faststart", str(out_mp4)]
                            if _ffmpeg_ok(ff_h) and out_mp4.exists() and out_mp4.stat().st_size > 32768:
                                _write_proxy_info_json(info_cache_dir, stem, cur_vid, j_res)
                                return out_mp4, "ok_hls"
            except Exception as hls_ex:
                print(f"  [DirectProxy HLS] error: {type(hls_ex).__name__}", flush=True)
        return None, last_err

    def run_proxy_ytdlp(cmd_list, stall_sec: int = 28, max_total_sec: int = 360):
        out_buf = []
        proc = subprocess.Popen(cmd_list, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        def _reader(pipe):
            try:
                for ln in iter(pipe.readline, ""):
                    out_buf.append(ln)
                    if len(out_buf) > 120: del out_buf[:40]
            except Exception: pass
        t_rd = threading.Thread(target=_reader, args=(proc.stdout,), daemon=True)
        t_rd.start()
        t0 = last_growth = time.time()
        last_bytes, saw_data, killed = 0, False, ""
        while proc.poll() is None:
            time.sleep(2.0)
            now = time.time()
            cur_bytes = sum(p.stat().st_size for p in stage_dir.rglob("*") if p.is_file())
            if cur_bytes > last_bytes + 4096:
                last_bytes, last_growth, saw_data = cur_bytes, now, True
            eff_stall = 45 if saw_data else stall_sec
            if (now - last_growth) >= eff_stall:
                killed = f"stalled>{eff_stall}s (got={round(last_bytes / 1048576, 2)}MB)"; proc.kill(); break
            if (now - t0) >= max_total_sec:
                killed = f"max_time>{max_total_sec}s (got={round(last_bytes / 1048576, 2)}MB)"; proc.kill(); break
        try: proc.wait(timeout=5)
        except Exception: pass
        t_rd.join(timeout=2)
        return proc.returncode, "".join(out_buf[-40:]), killed

    any_perm_unavail_reason, any_il_geo_blocked = "", False
    for u_idx, cur_url in enumerate(target_urls, 1):
        cur_vid = extract_vid_id(cur_url)
        print(f"\n>>> Processing target {u_idx}/{len(target_urls)}: yt:{cur_vid or 'item'} (Quality: {quality})", flush=True)
        info_cache_dir = Path("/tmp/info_cache")
        info_cache_dir.mkdir(parents=True, exist_ok=True)
        downloaded_media_for_url, downloaded_media_list, winning_proxy = None, [], ""
        avail_cc_set, us_geo_blocked, il_geo_blocked, perm_unavail_reason, api_403_fails = set(), False, False, "", 0
        has_custom_px = bool(os.environ.get("CUSTOM_PROXY", "").strip() or os.environ.get("IL_PROXY", "").strip())

        def _commit_stage(s_files):
            last_m = None
            for f in s_files:
                if f.name.endswith(".info.json"):
                    shutil.move(str(f), str(info_cache_dir / f.name))
                    continue
                dest_f = out_dir / f.name
                shutil.move(str(f), str(dest_f))
                if dest_f.suffix.lower() in MEDIA_EXTS:
                    last_m = dest_f
                    downloaded_media_list.append(dest_f)
            return last_m

        for att_idx, (label, args, strict_hd, prefer_hls) in enumerate(attempts, 1):
            if il_geo_blocked and "--xff" not in args:
                continue
            if att_idx > 1:
                time.sleep(0.5)
            t_att = time.time()
            _reset_stage()
            print(f"=== Trying ({att_idx}/{len(attempts)}): {label} (StrictHD={strict_hd}) ===", flush=True)
            proc = subprocess.run(_build_ytdlp_cmd(args, strict_hd, prefer_hls, cur_url), capture_output=True, text=True, check=False)
            for stream_txt in (proc.stdout, proc.stderr):
                if stream_txt: print(_safe_log_tail(stream_txt, 1800), flush=True)
            combined_out = (proc.stdout or "") + "\n" + (proc.stderr or "")
            low_comb = combined_out.lower()
            if any(k in low_comb for k in ("available in israel", "not made this video available in your country", "blocked it in your country")):
                il_geo_blocked = any_il_geo_blocked = True

            s_files, media_files = _stage_media()
            is_true_sd_only = ("requested format is not available" in low_comb) and not any(k in low_comb for k in ("only images are available", "unable to download api page", "the page needs to be reloaded"))
            if (not media_files) and strict_hd and is_true_sd_only and (not il_geo_blocked) and att_idx in (1, 2):
                print(f">>> Video has no 720p+ stream (SD/classic video) — retrying {label} immediately with StrictHD=False on the same server!", flush=True)
                _reset_stage()
                proc_sd = subprocess.run(_build_ytdlp_cmd(args, False, prefer_hls, cur_url), capture_output=True, text=True, check=False)
                for stream_txt in (proc_sd.stdout, proc_sd.stderr):
                    if stream_txt: print(_safe_log_tail(stream_txt, 1500), flush=True)
                s_files, media_files = _stage_media()
                if media_files:
                    label = f"{label} [SD Fallback]"
                else:
                    proc = proc_sd
                    combined_out = (proc.stdout or "") + "\n" + (proc.stderr or "")
                    low_comb = combined_out.lower()

            if media_files:
                downloaded_media_for_url = _commit_stage(s_files) or downloaded_media_for_url
                att_sec = round(time.time() - t_att, 1)
                telemetry["winner"] = label
                telemetry["dl_sec"] = round(telemetry["dl_sec"] + att_sec, 1)
                telemetry["attempts"].append({"n": att_idx, "label": label, "ok": True, "sec": att_sec})
                print(f"=== Success with: {label} ({att_sec}s) ===", flush=True)
                break

            att_sec = round(time.time() - t_att, 1)
            err_lines = [ln.strip() for ln in (proc.stderr or "").splitlines() if "ERROR:" in ln or "HTTP Error 403" in ln]
            short_err = (err_lines[-1][:140] if err_lines else f"exit={proc.returncode}")
            telemetry["attempts"].append({"n": att_idx, "label": label, "ok": False, "sec": att_sec, "err": short_err})

            if (not il_geo_blocked) and ("sign in to confirm" not in low_comb) and ("available in your country" not in low_comb):
                if any(k in low_comb for k in ("private video", "this video has been removed", "members-only", "join this channel to get access", "drm protected", "this live event will begin")):
                    perm_unavail_reason = short_err
                    if not any_perm_unavail_reason:
                        any_perm_unavail_reason = short_err
                    break

            is_final_retry = bool(re.search(r"-r[5-9]\d*$", req_id))
            is_api_403 = (not is_true_sd_only) and (any(k in combined_out for k in ("Unable to download API page: HTTP Error 403", "Failed to extract any player response", "Only images are available for download", "The page needs to be reloaded", "HTTP Error 429")) or any(k in low_comb for k in ("this content isn't available", "this content isn\u2019t available")))
            if is_api_403:
                api_403_fails += 1
            if (not has_custom_px) and (not il_geo_blocked) and (not is_final_retry) and api_403_fails >= 2:
                has_saved_prev = any(p.is_file() and p.suffix.lower() in MEDIA_EXTS and p.stat().st_size > 0 for p in out_dir.rglob("*"))
                if not has_saved_prev:
                    print(f">>> FAST-ABORT: Both authenticated yt-dlp profiles hit IP ban on this Azure VM (att={att_idx}). Switching to Fresh VM!", flush=True)
                    raise SystemExit(f"::error::AZURE_IP_403_BANNED|{short_err}")
                print(f">>> IP ban on item {u_idx}/{len(target_urls)} after previous items succeeded — preserving files & engaging Proxy Tunnel.", flush=True)
                break
            if il_geo_blocked and att_idx >= 4:
                print(">>> Confirmed Geo-Restriction after direct & XFF attempts! Engaging Direct-Stream Proxy Tunnel...", flush=True)
                break

        if (not downloaded_media_for_url) and (not perm_unavail_reason):
            if cur_vid and not avail_cc_set:
                _pst, _prsn, _, _pmeta = probe_playability(cur_vid, px=None, timeout_s=5.0, gl_code="US", test_stream=False)
                avail_cc_set = set((_pmeta or {}).get("available_countries") or [])
                if _pst == "UNPLAYABLE" and "country" in _prsn.lower():
                    us_geo_blocked = il_geo_blocked = any_il_geo_blocked = True
                print(f">>> Lazy Geo-Probe before Proxy Tunnel: status={_pst} availableCountries={len(avail_cc_set)} (IL={'IL' in avail_cc_set}, US={'US' in avail_cc_set})", flush=True)
            preferred_pool = [geo, "IL", "NL", "DE", "PL", "FR", "GB", "IT", "CA", "SG", "BR", "ES", "US"]
            valid_cc = ([c for c in preferred_pool if c in avail_cc_set] or sorted(avail_cc_set)[:6]) if avail_cc_set else [c for c in preferred_pool if not (us_geo_blocked and c == "US")]
            dedup_cc = list(dict.fromkeys(c for c in valid_cc if c))
            waves = ([dedup_cc[:3], dedup_cc[3:6] if len(dedup_cc) > 3 else ["ALL"]] + ([dedup_cc[6:9]] if len(dedup_cc) > 6 else []) + [["ALL"]]) if len(dedup_cc) >= 3 else (([dedup_cc] + ([["ALL"]] if len(avail_cc_set) != 1 else [])) if dedup_cc else [["ALL"]])

            px_deadline, px_idx, tried_px = time.time() + 280, 0, set()
            can_use_direct = bool(cur_vid and mode != "collection" and not clip_start and not clip_end and not sb and not chapters)
            px_resume_dir = Path("/tmp/px_resume") / (cur_vid or f"u{u_idx}")
            if px_resume_dir.exists(): shutil.rmtree(px_resume_dir, ignore_errors=True)
            px_resume_dir.mkdir(parents=True, exist_ok=True)
            px_resume_store = {}

            for wave_cc in waves:
                if downloaded_media_for_url or time.time() >= px_deadline:
                    break
                wave_lbl = "+".join(wave_cc)
                proxies_list = discover_working_proxies_batch(cur_vid, wave_cc, tried_px)
                ok_list = [x for x in proxies_list if not x[1] and x[3]]
                print(f">>> [Proxy Wave ({wave_lbl})] Stream-verified: clean_OK={len(ok_list)} (top={f'{ok_list[0][2]} KB/s' if ok_list else 'n/a'}), login_ck={len(proxies_list) - len(ok_list)} for {cur_vid or 'target'}.", flush=True)
                for px_url, px_use_ck, px_kbps, px_meta in proxies_list[:6]:
                    if downloaded_media_for_url or time.time() >= px_deadline:
                        break
                    tried_px.add(px_url); px_idx += 1; t_px = time.time()
                    if can_use_direct and (not px_use_ck) and px_meta:
                        _reset_stage()
                        print(f"=== Trying Direct-Stream Proxy #{px_idx} ({wave_lbl}, {px_meta.get('client')}, probe={px_kbps}KB/s) ===", flush=True)
                        direct_out, direct_err = direct_download_via_proxy(cur_vid, px_url, px_meta, info_cache_dir, px_resume_store, px_resume_dir)
                        if direct_out and direct_out.exists() and direct_out.stat().st_size > 16384:
                            winning_proxy = px_url
                            dest_f = out_dir / direct_out.name
                            shutil.move(str(direct_out), str(dest_f))
                            downloaded_media_for_url = dest_f; downloaded_media_list.append(dest_f)
                            shutil.rmtree(px_resume_dir, ignore_errors=True)
                            px_sec = round(time.time() - t_px, 1)
                            telemetry["winner"] = f"DirectProxy ({wave_lbl} #{px_idx} {px_meta.get('client')})"
                            telemetry["dl_sec"] = round(telemetry["dl_sec"] + px_sec, 1)
                            telemetry["attempts"].append({"n": 100 + px_idx, "label": telemetry["winner"], "ok": True, "sec": px_sec})
                            print(f"=== Success via Direct-Stream Proxy #{px_idx} ({px_sec}s, {round(dest_f.stat().st_size/1048576, 1)} MB)! ===", flush=True)
                            break
                        telemetry["attempts"].append({"n": 100 + px_idx, "label": f"DirectProxy {wave_lbl}", "ok": False, "sec": round(time.time() - t_px, 1), "err": direct_err or "direct_stream_failed"})
                        continue

                    prof = ("ck+tv/safari-HLS", True, True, True, "youtube:player_client=tv,web_safari,mweb;fetch_pot=always", True, True) if (px_use_ck and has_ck) else ("clean+vr/ios-HD", False, False, False, "youtube:player_client=android_vr,ios;player_skip=webpage,configs", True, False)
                    prof_name, use_ck_now, use_imp, use_pot, client_arg, px_strict_hd, px_hls = prof
                    _reset_stage()
                    px_cmd = ["python3", "-m", "yt_dlp", "--ignore-config", "--rm-cache-dir", "--write-info-json", "--proxy", px_url, "--ffmpeg-location", "/usr/bin/ffmpeg", "--concurrent-fragments", "2", "--socket-timeout", "12", "--retries", "2", "--fragment-retries", "2", "--newline", "--extractor-args", client_arg, "-o", "/tmp/stage/%(title).150B [%(id)s].%(ext)s"]
                    if use_imp: px_cmd += ["--impersonate", "chrome"]
                    if use_pot: px_cmd += ["--extractor-args", pot_ep]
                    if use_ck_now and has_ck: px_cmd += ["--cookies", str(cookie_file)]
                    px_cmd += get_fmt_args(px_strict_hd, px_hls) + px_extra_args + [cur_url]
                    print(f"=== Trying yt-dlp Proxy #{px_idx} ({wave_lbl}, {prof_name}) ===", flush=True)
                    rc, tail_out, kill_rsn = run_proxy_ytdlp(px_cmd)
                    if tail_out: print(tail_out[-1200:], flush=True)
                    s_files, media_files = _stage_media()
                    if media_files:
                        winning_proxy = px_url
                        downloaded_media_for_url = _commit_stage(s_files) or downloaded_media_for_url
                        px_sec = round(time.time() - t_px, 1)
                        telemetry["winner"] = f"Verified Proxy ({wave_lbl} #{px_idx} {prof_name})"
                        telemetry["dl_sec"] = round(telemetry["dl_sec"] + px_sec, 1)
                        telemetry["attempts"].append({"n": 100 + px_idx, "label": telemetry["winner"], "ok": True, "sec": px_sec})
                        print(f"=== Success via Verified Proxy #{px_idx} ({px_sec}s)! ===", flush=True)
                        break
                    pe = [ln.strip() for ln in (tail_out or "").splitlines() if "ERROR:" in ln or "HTTP Error" in ln]
                    telemetry["attempts"].append({"n": 100 + px_idx, "label": f"Proxy {wave_lbl} {prof_name}", "ok": False, "sec": round(time.time() - t_px, 1), "err": kill_rsn or (pe[-1][:120] if pe else f"exit={rc}")})
            shutil.rmtree(px_resume_dir, ignore_errors=True)

        speed_applied_files = set()
        if downloaded_media_list and ((speed_val not in ("1", "1.0", "")) or norm_audio):
            t_ff = time.time()
            try: spd = float(speed_val) if speed_val else 1.0
            except Exception: spd = 1.0
            if spd > 0 and (abs(spd - 1.0) >= 0.01 or norm_audio):
                af = ([f"atempo={spd}"] if abs(spd - 1.0) >= 0.01 else []) + (["loudnorm=I=-16:TP=-1.5:LRA=11"] if norm_audio else [])
                for fpath in list(downloaded_media_list):
                    suf = fpath.suffix.lower()
                    if suf not in MEDIA_EXTS: continue
                    tmp_p = fpath.with_name("proc_" + fpath.name)
                    if suf in (".mp4", ".mkv", ".webm"):
                        ff_cmd = ["-i", str(fpath), "-map", "0:v:0?", "-map", "0:a:0?", "-dn", "-map_chapters", "-1"]
                        ff_cmd += (["-filter:v", f"setpts=PTS/{spd}"] + (["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"] if suf in (".mp4", ".mkv") else ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "6", "-crf", "30", "-b:v", "0"])) if abs(spd - 1.0) >= 0.01 else ["-c:v", "copy"]
                        ff_cmd += (["-filter:a", ",".join(af)] + (["-c:a", "aac", "-b:a", "192k"] if suf in (".mp4", ".mkv") else ["-c:a", "libopus", "-b:a", "128k"])) if af else ["-c:a", "copy"]
                        if suf == ".mp4": ff_cmd += ["-movflags", "+faststart"]
                    else:
                        ff_cmd = ["-i", str(fpath), "-map", "0:a:0", "-dn", "-map_chapters", "-1"] + (["-filter:a", ",".join(af)] if af else []) + (["-movflags", "+faststart"] if suf == ".m4a" else [])
                    if _ffmpeg_ok(ff_cmd + [str(tmp_p)]) and tmp_p.exists() and tmp_p.stat().st_size > 0:
                        tmp_p.replace(fpath)
                        if abs(spd - 1.0) >= 0.01: speed_applied_files.add(fpath)
            telemetry["ff_sec"] = round(telemetry["ff_sec"] + (time.time() - t_ff), 1)

        if downloaded_media_list and (not is_audio) and subtitles in ("embed", "files"):
            sub_targets = downloaded_media_list if len(downloaded_media_list) > 1 else [downloaded_media_list[0]]
            for mf_item in sub_targets:
                mf_vid = extract_vid_id(mf_item.name) if len(sub_targets) > 1 else extract_vid_id(cur_url)
                sub_req_url = f"https://www.youtube.com/watch?v={mf_vid}" if (len(sub_targets) > 1 and mf_vid) else cur_url
                cand_info = info_cache_dir / f"{mf_item.stem}.info.json"
                if (not cand_info.exists()) and mf_vid:
                    cand_info = next((p for p in info_cache_dir.glob("*.info.json") if f"[{mf_vid}]" in p.name), cand_info)
                time.sleep(0.2)
                t_sub = time.time()
                srt_list, sub_label = fetch_subtitles_for_url(sub_req_url, mf_item.stem, True, winning_proxy, cand_info if cand_info.exists() else None, mf_item in speed_applied_files)
                telemetry["sub_sec"] = round(telemetry["sub_sec"] + (time.time() - t_sub), 1)
                if srt_list:
                    best_srt = srt_list[0]
                    saved_copy = Path(f"/tmp/mail_sub_{len(embedded_srts_by_stem)}.he.srt")
                    shutil.copy2(str(best_srt), str(saved_copy))
                    embedded_srts_by_stem[mf_item.stem] = saved_copy
                    if subtitles == "embed" and mf_item.suffix.lower() in (".mp4", ".mkv") and mf_item.stat().st_size < 8000 * 1024 * 1024:
                        emb_tmp = mf_item.with_name("sub_" + mf_item.name)
                        sub_c = "mov_text" if mf_item.suffix.lower() == ".mp4" else "srt"
                        s_lang, s_title = ("heb", "Hebrew") if best_srt.name.endswith(".he.srt") else ("und", "Original")
                        ff_sub = ["-i", str(mf_item), "-i", str(best_srt), "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:0", "-dn", "-map_chapters", "-1", "-c:v", "copy", "-c:a", "copy", "-c:s", sub_c, "-metadata:s:s:0", f"language={s_lang}", "-metadata:s:s:0", f"title={s_title}"] + (["-movflags", "+faststart"] if mf_item.suffix.lower() == ".mp4" else []) + [str(emb_tmp)]
                        if _ffmpeg_ok(ff_sub) and emb_tmp.exists():
                            emb_tmp.replace(mf_item)
                        else:
                            shutil.copy2(str(best_srt), str(out_dir / best_srt.name))
                            subs_detail_msg = "⚠️ הטמעה נכשלה — צורף קובץ SRT נפרד"
                    else:
                        for s_f in srt_list: shutil.copy2(str(s_f), str(out_dir / s_f.name))
                        subs_verified_flag, subs_detail_msg = True, f"📄 צורף קובץ כתוביות ({sub_label})"
                elif len(sub_targets) == 1:
                    subs_verified_flag, subs_detail_msg = False, "⚠️ אין כתוביות לסרטון זה ביוטיוב"

    shutil.rmtree(stage_dir, ignore_errors=True)
    shutil.rmtree(subs_dir, ignore_errors=True)
    files = [p for p in out_dir.rglob("*") if p.is_file() and not p.name.endswith((".part", ".ytdl")) and p.stat().st_size > 0]
    if not files:
        last_errs = " ; ".join(f"#{a.get('n')}:{a.get('err','')}" for a in telemetry.get("attempts", [])[-3:] if not a.get("ok"))
        if any_perm_unavail_reason:
            raise SystemExit(f"::error::PERMANENT_UNAVAILABLE|{any_perm_unavail_reason}")
        if any_il_geo_blocked:
            raise SystemExit(f"::error::GEO_BLOCKED|הסרטון חסום גיאוגרפית ולא נמצא Proxy פעיל | {last_errs[:160]}")
        raise SystemExit(f"::error::ALL_CLIENTS_FAILED|{last_errs[:200] or 'הורדת המדיה נכשלה בכל הקליינטים'}")
    media_out = [p for p in files if p.suffix.lower() in MEDIA_EXTS]
    primary_file = media_out[0] if media_out else files[0]
    embedded_srt_saved = embedded_srts_by_stem.get(primary_file.stem)
    detected_h, detected_dur, quality_report = inspect_media_quality(primary_file)

file_mb = round(primary_file.stat().st_size / 1048576, 2)
if (not is_audio) and (not is_subs_only) and subtitles == "embed":
    vid_outs = [p for p in media_out if p.suffix.lower() in (".mp4", ".mkv", ".webm")] or [primary_file]
    verified_vids = 0
    for vp in vid_outs:
        try:
            if json.loads(_ffprobe(["-select_streams", "s", "-show_entries", "stream=codec_name:stream_tags=language", "-of", "json", str(vp)]) or "{}").get("streams"):
                verified_vids += 1
        except Exception:
            pass
    if verified_vids > 0:
        sub_src = str(telemetry.get("sub_source") or "")
        is_he_verified = (not sub_src) or sub_src.startswith(("he", "iw")) or sub_src.endswith("->he")
        subs_verified_flag = is_he_verified
        cn = telemetry.get("sub_cues") or 0
        if is_he_verified:
            subs_detail_msg = (
                f"✅ כתוביות בעברית מוטמעות ומאומתות ({verified_vids}/{len(vid_outs)} קבצים)"
                if len(vid_outs) > 1
                else f"✅ כתוביות בעברית מוטמעות ומאומתות{f' ({cn} שורות)' if cn else ''}"
            )
        else:
            subs_detail_msg = f"⚠️ הוטמעו כתוביות מקור ({sub_src}{f', {cn} שורות' if cn else ''}) — התרגום לעברית נחסם זמנית"
    elif not subs_detail_msg:
        subs_verified_flag, subs_detail_msg = False, "⚠️ לא אומת ערוץ כתוביות מוטמע בקובץ"
elif is_subs_only:
    subs_verified_flag, subs_detail_msg = True, f"✅ {quality_report}"
print(f">>> VERIFIED OUTPUT: {quality_report} ({file_mb} MB) | SUBS: {subs_detail_msg or 'none'} <<<", flush=True)

MAX_SINGLE_ZIP_BYTES = 550 * 1024 * 1024
tag = "dl-" + req_id
zip_paths, split_join_meta = [], None
oversize_target = next((f for f in files if f.stat().st_size > MAX_SINGLE_ZIP_BYTES), None)

def _pack_batches(file_list, prefix):
    batch, b_bytes, idx = [], 0, 0
    def _write_batch():
        nonlocal idx
        idx += 1
        zp = pkg_dir / (f"{prefix}.zip" if idx == 1 else f"{prefix}-part{idx}.zip")
        with zipfile.ZipFile(zp, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as zf:
            for bf in batch: zf.write(bf, bf.relative_to(out_dir))
        zip_paths.append(zp)
    for f in file_list:
        f_sz = f.stat().st_size
        if batch and b_bytes + f_sz > MAX_SINGLE_ZIP_BYTES:
            _write_batch(); batch, b_bytes = [f], f_sz
        else:
            batch.append(f); b_bytes += f_sz
    if batch:
        _write_batch()

if cloud_only_flag:
    zip_paths = [primary_file]
elif oversize_target is not None:
    primary_file = oversize_target
    embedded_srt_saved = embedded_srts_by_stem.get(primary_file.stem) or embedded_srt_saved
    total_sz = primary_file.stat().st_size
    num_parts = max(2, math.ceil(total_sz / MAX_SINGLE_ZIP_BYTES))
    part_target = math.ceil(total_sz / num_parts)
    part_names = []
    print(f">>> Large file ({round(total_sz/1048576, 1)} MB > 550 MB): raw binary splitting into {num_parts} parts for automatic lossless reassembly <<<", flush=True)
    with open(primary_file, "rb") as src_fp:
        for p_i in range(1, num_parts + 1):
            tmp_dat = pkg_dir / f"part{p_i:02d}.dat"
            z_name = f"{tag}-part{p_i:02d}.zip"
            z_path = pkg_dir / z_name
            rem = part_target if p_i < num_parts else (total_sz - (p_i - 1) * part_target)
            with open(tmp_dat, "wb") as dst_fp:
                while rem > 0:
                    buf = src_fp.read(min(16 * 1024 * 1024, rem))
                    if not buf: break
                    dst_fp.write(buf); rem -= len(buf)
            with zipfile.ZipFile(z_path, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as zf:
                zf.write(tmp_dat, tmp_dat.name)
            tmp_dat.unlink(missing_ok=True)
            zip_paths.append(z_path); part_names.append(z_name)
    split_join_meta = {"filename": primary_file.name, "total_size": total_sz, "parts": part_names}
    extra_small = [f for f in files if f != primary_file]
    if extra_small:
        _pack_batches(extra_small, f"{tag}-extras")
else:
    _pack_batches(files, tag)

zip_path = zip_paths[0]
zip_size = sum(z.stat().st_size for z in zip_paths)
repo = os.environ.get("GITHUB_REPOSITORY", "")
blob_shas = []

t_pkg = time.time()
if not cloud_only_flag and len(zip_paths) == 1 and zip_size <= 95 * 1024 * 1024:
    raw_bytes = zip_path.read_bytes()
    chunks_list = [raw_bytes[o:o + 16 * 1024 * 1024] for o in range(0, len(raw_bytes), 16 * 1024 * 1024)]
    del raw_bytes
    def _up_blob(ch_b):
        body_j = json.dumps({"content": base64.b64encode(ch_b).decode("ascii"), "encoding": "base64"})
        for att_b in range(2):
            p = subprocess.run(["gh", "api", f"repos/{repo}/git/blobs", "-q", ".sha", "--input", "-"], input=body_j, text=True, capture_output=True, check=False)
            if p.returncode == 0 and p.stdout.strip():
                return p.stdout.strip()
            if att_b == 0:
                time.sleep(1.5)
        return ""
    with ThreadPoolExecutor(max_workers=4) as ex:
        shas_out = list(ex.map(_up_blob, chunks_list))
    if all(shas_out):
        blob_shas = shas_out
telemetry["pkg_sec"] = round(time.time() - t_pkg, 1)

drive_web_link = drive_url_enc = drive_status = ""
gd_cid, gd_sec, gd_ref, gd_fld = (re.sub(r"\s+", "", os.environ.get(k, "")).strip("\"'") for k in ("GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN", "GDRIVE_FOLDER_ID"))
_share_target = email_opt if (email_opt and "@" in email_opt) else next((os.environ.get(k, "").strip() for k in ("EMAIL_TO", "SMTP_TO", "SMTP_USER", "EMAIL_USER", "GMAIL_USER") if os.environ.get(k, "").strip()), "")
if _share_target and "@" in _share_target: mask_secret(_share_target)
has_gd_secrets = bool(gd_cid and gd_sec and gd_ref)
auto_drive_for_mail = bool(send_email_flag and has_gd_secrets and primary_file.exists() and primary_file.stat().st_size > int(17.5 * 1024 * 1024))

if upload_drive_flag or auto_drive_for_mail:
    if not has_gd_secrets:
        print(f"Drive secrets status: cid={bool(gd_cid)} sec={bool(gd_sec)} ref={bool(gd_ref)} fld={bool(gd_fld)}", flush=True)
        drive_status = "⚠️ חסרים Secrets של Google Drive (GDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN)"
    else:
        try:
            tr = requests.post("https://oauth2.googleapis.com/token", data={"client_id": gd_cid, "client_secret": gd_sec, "refresh_token": gd_ref, "grant_type": "refresh_token"}, timeout=20)
            tr.raise_for_status()
            acc_tok = tr.json()["access_token"]
            mask_secret(acc_tok)
            gd_h = {"Authorization": f"Bearer {acc_tok}"}
            if not gd_fld:
                fq = requests.get("https://www.googleapis.com/drive/v3/files", headers=gd_h, params={"q": "name='YouTube Cloud Ultra' and mimeType='application/vnd.google-apps.folder' and trashed=false", "fields": "files(id)"}, timeout=15)
                flist = (fq.json().get("files") or []) if fq.ok else []
                if flist:
                    gd_fld = flist[0]["id"]
                else:
                    fc = requests.post("https://www.googleapis.com/drive/v3/files", headers={**gd_h, "Content-Type": "application/json"}, json={"name": "YouTube Cloud Ultra", "mimeType": "application/vnd.google-apps.folder"}, timeout=15)
                    if fc.ok: gd_fld = fc.json().get("id", "")
            t_drv = time.time()
            drive_targets = list(files)
            uploaded_fids, first_link = [], ""
            drive_mime_map = {".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".wav": "audio/wav", ".opus": "audio/opus", ".srt": "text/plain", ".zip": "application/zip"}
            for up_target in drive_targets:
                f_total = up_target.stat().st_size
                f_mime = drive_mime_map.get(up_target.suffix.lower(), "application/octet-stream")
                meta = {"name": up_target.name, "mimeType": f_mime, **({"parents": [gd_fld]} if gd_fld else {})}
                init_r = requests.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", headers={**gd_h, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": f_mime, "X-Upload-Content-Length": str(f_total)}, json=meta, timeout=25)
                init_r.raise_for_status()
                up_url, fin_json = init_r.headers["Location"], {}
                with open(up_target, "rb") as fp:
                    pos = 0
                    while pos < f_total:
                        buf = fp.read(16 * 1024 * 1024)
                        if not buf: break
                        cr = None
                        for ctry in range(3):
                            try:
                                cr = requests.put(up_url, headers={**gd_h, "Content-Length": str(len(buf)), "Content-Range": f"bytes {pos}-{pos + len(buf) - 1}/{f_total}"}, data=buf, timeout=180)
                                if cr.status_code in (200, 201, 308): break
                            except Exception:
                                cr = None
                            time.sleep(2.0 * (ctry + 1))
                        if cr is None or cr.status_code not in (200, 201, 308):
                            raise RuntimeError(f"Drive chunk HTTP {getattr(cr, 'status_code', 'NET_ERR')}")
                        pos += len(buf)
                        if cr.status_code in (200, 201):
                            fin_json = cr.json(); break
                fid = fin_json.get("id", "")
                if fid:
                    uploaded_fids.append(fid); mask_secret(fid)
                    first_link = first_link or fin_json.get("webViewLink") or f"https://drive.google.com/file/d/{fid}/view"
                    if _share_target and "@" in _share_target:
                        try: requests.post(f"https://www.googleapis.com/drive/v3/files/{fid}/permissions", headers={**gd_h, "Content-Type": "application/json"}, params={"sendNotificationEmail": "false"}, json={"type": "user", "role": "reader", "emailAddress": _share_target}, timeout=20)
                        except Exception: pass
            telemetry["drive_sec"] = round(time.time() - t_drv, 1)
            if uploaded_fids:
                drive_web_link = f"https://drive.google.com/drive/folders/{gd_fld}" if (len(uploaded_fids) > 1 and gd_fld) else first_link
                mask_secret(drive_web_link)
                if len(secret_key_env) == 64:
                    _iv = os.urandom(12)
                    drive_url_enc = base64.b64encode(_iv + AESGCM(bytes.fromhex(secret_key_env)).encrypt(_iv, drive_web_link.encode("utf-8"), None)).decode("ascii")
                    drive_status = f"☁️ הועלו {len(uploaded_fids)} קבצים ל-Google Drive בהצלחה" if len(uploaded_fids) > 1 else "☁️ הועלה ל-Google Drive בהצלחה"
                else:
                    drive_status = f"☁️ הועלה ל-Drive ({len(uploaded_fids)} קבצים) — הגדר COOKIE_KEY להצגת קישור בתוסף"
                print(f"Google Drive upload succeeded ({len(uploaded_fids)} file(s)).", flush=True)
        except Exception as gd_err:
            code = getattr(getattr(gd_err, "response", None), "status_code", "")
            rtxt = str(getattr(getattr(gd_err, "response", None), "text", ""))[:180].replace("\n", " ")
            print(f"Google Drive upload error: {type(gd_err).__name__} HTTP={code} {rtxt or gd_err}", flush=True)
            drive_status = f"⚠️ שגיאת Drive ({type(gd_err).__name__} {code})"

MAX_GMAIL_RAW_BYTES = int(17.5 * 1024 * 1024)
TARGET_CHUNK_BYTES = int(13.8 * 1024 * 1024)
MAX_SAFE_SMTP_PARTS = 5
SMTP_COOLDOWN_SEC = 25

smtp_user = next((os.environ.get(k, "").strip() for k in ("SMTP_USER", "EMAIL_USER", "GMAIL_USER") if os.environ.get(k, "").strip()), "")
smtp_pass = next((os.environ.get(k, "").strip() for k in ("SMTP_PASS", "EMAIL_PASS", "GMAIL_APP_PASSWORD", "GMAIL_PASS") if os.environ.get(k, "").strip()), "")
secret_to = next((os.environ.get(k, "").strip() for k in ("EMAIL_TO", "SMTP_TO") if os.environ.get(k, "").strip()), smtp_user)
recipient = email_opt if (email_opt and "@" in email_opt) else secret_to
mask_secret(smtp_user, smtp_pass, secret_to, recipient)

def _mail_safe_stem(raw_name: str) -> str:
    s = re.sub(r"\.f\d+(?:-\d+)?$", "", str(raw_name or "video"), flags=re.I)
    s = re.sub("[\U00010000-\U0010FFFF\u2600-\u27BF\uFE00-\uFEFF]", " ", s)
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f#~%&{}^`!@$+=;]+', " ", s)
    return (re.sub(r"\s+", " ", s).strip(" ._-")[:72].strip(" ._-")) or "youtube-video"

def _probe_dur_sec(fp: Path) -> float:
    try: return max(0.0, float(_ffprobe(["-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(fp)]).strip() or 0))
    except Exception: return 0.0

def _probe_has_subs(fp: Path) -> bool:
    return bool(_ffprobe(["-select_streams", "s", "-show_entries", "stream=index", "-of", "csv=p=0", str(fp)]).strip())

def _parse_raw_srt(raw_txt: str):
    cues = []
    for blk in re.split(r"\r?\n\r?\n+", raw_txt.lstrip("\ufeff").strip()):
        lns = [l for l in blk.splitlines() if l.strip()]
        ti = next((i for i, l in enumerate(lns[:3]) if "-->" in l), -1)
        if ti < 0 or len(lns[ti].split("-->")) < 2: continue
        a, b = lns[ti].split("-->")[:2]
        s_ms, e_ms, body = ts_to_ms(a), ts_to_ms(b.strip().split()[0]), "\r\n".join(lns[ti + 1:]).strip()
        if e_ms > s_ms and body: cues.append((s_ms, e_ms, body))
    return cues

def _slice_srt_window(cues, ws: int, we: int) -> str:
    out, dur_ms = [], max(1, we - ws)
    for cs, ce, body in cues:
        if ce <= ws or cs >= we: continue
        ns, ne = max(0, cs - ws), min(dur_ms, ce - ws)
        if ne - ns >= 120:
            out.append(f"{len(out) + 1}\r\n{ms_to_ts(ns)} --> {ms_to_ts(ne)}\r\n{body}")
    return ("\ufeff" + "\r\n\r\n".join(out) + "\r\n") if out else ""

def _split_lossless_once(src_fp: Path, dst_dir: Path, prefix: str, seg_sec: int, is_vid: bool):
    dst_dir.mkdir(parents=True, exist_ok=True)
    ext = src_fp.suffix.lower()
    cmd = ["-i", str(src_fp), "-dn", "-map_chapters", "-1"] + (["-map", "0:v:0", "-map", "0:a:0?"] if is_vid else ["-map", "0:a:0"])
    cmd += ["-c", "copy", "-f", "segment", "-segment_time", str(max(4, seg_sec)), "-reset_timestamps", "1"]
    if ext in (".mp4", ".m4a", ".mov"): cmd += ["-segment_format_options", "movflags=+faststart"]
    _ffmpeg_ok(cmd + [str(dst_dir / f"{prefix}_%03d{ext}")])
    return sorted(p for p in dst_dir.glob(f"{prefix}_*{ext}") if p.is_file() and p.stat().st_size > 0)

def _send_mail(subject: str, body: str, attachments=None, extra_headers=None):
    msg = email.message.EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, smtp_user, recipient
    for k, v in (extra_headers or {}).items():
        msg[k] = v
    msg.set_content(body)
    for fp, mt, st, fname in (attachments or []):
        msg.add_attachment(fp.read_bytes(), maintype=mt, subtype=st, filename=fname)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=120) as srv:
        srv.login(smtp_user, smtp_pass)
        srv.send_message(msg)

def _collect_side_srts(clean_stem: str, exclude_primary: bool = False):
    srts = [p for p in out_dir.glob("*.srt") if (not exclude_primary or p != primary_file)]
    if not srts and (not exclude_primary) and embedded_srt_saved and embedded_srt_saved.exists():
        srts = [embedded_srt_saved]
    out_atts = []
    for p in srts:
        if p.stat().st_size <= 2 * 1024 * 1024:
            fname = f"{clean_stem}.he.srt" if (p == embedded_srt_saved or len(srts) == 1) else f"{_mail_safe_stem(p.stem)}.srt"
            out_atts.append((p, "text", "plain", fname))
    return out_atts

email_sent_status = ""
email_delivered_ok = False
if send_email_flag and not (smtp_user and smtp_pass and recipient and "@" in recipient):
    email_sent_status = "⚠️ חסרים Secrets של מייל (SMTP_USER/SMTP_PASS)"
elif send_email_flag:
    t_em = time.time()
    try:
        clean_stem = _mail_safe_stem(primary_file.stem)
        ext_low = primary_file.suffix.lower()
        base_subject = f"YouTube Cloud Ultra [{quality_report}] - {clean_stem}"

        if drive_web_link and primary_file.stat().st_size > MAX_GMAIL_RAW_BYTES:
            _send_mail(base_subject, f"שלום,\n\nהקובץ הועלה ל-Google Drive באיכות המקורית המלאה (ללא דחיסה וללא פיצול)!\n• שם הקובץ: {clean_stem}{ext_low}\n• איכות / סוג: {quality_report}\n• גודל: {file_mb} MB\n• קישור ישיר לצפייה והורדה ב-Google Drive:\n{drive_web_link}\n", _collect_side_srts(clean_stem))
            email_delivered_ok, email_sent_status = True, "נשלח מייל אחד עם קישור Google Drive (איכות מלאה)"
            print(f">>> EMAIL OK: {email_sent_status}", flush=True)
        elif primary_file.exists() and primary_file.stat().st_size <= MAX_GMAIL_RAW_BYTES:
            atts = [(primary_file, "application", "octet-stream", f"{clean_stem}{ext_low}")] + _collect_side_srts(clean_stem, exclude_primary=True)
            _send_mail(base_subject, f"שלום,\n\nהקובץ הורד ונשלח אליך באיכות המקורית המלאה!\n• שם הקובץ: {clean_stem}{ext_low}\n• איכות / סוג: {quality_report}\n• גודל: {file_mb} MB\n" + (f"• קישור Google Drive: {drive_web_link}\n" if drive_web_link else ""), atts)
            email_delivered_ok, email_sent_status = True, "נשלח למייל באיכות מקורית"
            print(f">>> EMAIL OK: {email_sent_status}", flush=True)
        else:
            mail_work = Path("/tmp/mail_parts")
            if mail_work.exists(): shutil.rmtree(mail_work, ignore_errors=True)
            mail_work.mkdir(parents=True, exist_ok=True)
            is_vid_f, is_aud_f = ext_low in (".mp4", ".mkv", ".webm"), ext_low in (".mp3", ".m4a", ".flac", ".wav", ".opus")
            tot_bytes = primary_file.stat().st_size
            est_parts = math.ceil(tot_bytes / TARGET_CHUNK_BYTES)
            raw_chunks, srt_cues = [], []

            if (is_vid_f or is_aud_f) and est_parts <= MAX_SAFE_SMTP_PARTS:
                srt_src = embedded_srt_saved if (embedded_srt_saved and embedded_srt_saved.exists() and embedded_srt_saved.stat().st_size > 15) else None
                if not srt_src and _probe_has_subs(primary_file):
                    ext_tmp = mail_work / "extracted_internal.srt"
                    if _ffmpeg_ok(["-i", str(primary_file), "-map", "0:s:0", str(ext_tmp)]) and ext_tmp.exists(): srt_src = ext_tmp
                if not srt_src:
                    ss = sorted(out_dir.glob("*.srt"))
                    if ss: srt_src = ss[0]
                if srt_src and srt_src.exists(): srt_cues = _parse_raw_srt(srt_src.read_text(encoding="utf-8", errors="replace"))
                tot_dur = _probe_dur_sec(primary_file) or float(detected_dur or 0.0) or 600.0
                raw_chunks = _split_lossless_once(primary_file, mail_work / "pass0", "seg", max(8, int(tot_dur * (TARGET_CHUNK_BYTES / max(1, tot_bytes)))), is_vid_f)
                for rnd in range(2):
                    nxt, chg = [], False
                    for ci, cfp in enumerate(raw_chunks):
                        csz = cfp.stat().st_size
                        if csz > MAX_GMAIL_RAW_BYTES:
                            subs_l = _split_lossless_once(cfp, mail_work / f"r{rnd}_{ci}", "sub", max(4, int(_probe_dur_sec(cfp) / max(2, math.ceil(csz / (13.0 * 1024 * 1024))))), is_vid_f)
                            if len(subs_l) >= 2: nxt.extend(subs_l); chg = True; continue
                        nxt.append(cfp)
                    raw_chunks = nxt
                    if not chg: break

            if raw_chunks and len(raw_chunks) <= MAX_SAFE_SMTP_PARTS:
                final_dir = mail_work / "final"; final_dir.mkdir(parents=True, exist_ok=True)
                cursor_ms, parts_to_send, has_int_subs, skipped_p = 0, [], False, 0
                for idx_p, cfp in enumerate(raw_chunks, 1):
                    cdur = _probe_dur_sec(cfp)
                    ws, we = cursor_ms, cursor_ms + max(1000, int(round(cdur * 1000)))
                    cursor_ms = we
                    part_dst, part_ext_srt = final_dir / f"{clean_stem} - Part {idx_p:02d}{ext_low}", None
                    sliced = _slice_srt_window(srt_cues, ws, we) if srt_cues else ""
                    if sliced and is_vid_f and ext_low in (".mp4", ".mkv"):
                        psrt = final_dir / f"{clean_stem} - Part {idx_p:02d}.he.srt"
                        psrt.write_text(sliced, encoding="utf-8")
                        if subtitles == "embed" or _probe_has_subs(primary_file):
                            mc = ["-i", str(cfp), "-i", str(psrt), "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:0", "-dn", "-map_chapters", "-1", "-c", "copy", "-c:s", "mov_text" if ext_low == ".mp4" else "srt", "-metadata:s:s:0", "language=heb", "-metadata:s:s:0", "title=Hebrew"] + (["-movflags", "+faststart"] if ext_low == ".mp4" else []) + [str(part_dst)]
                            if _ffmpeg_ok(mc) and part_dst.exists() and part_dst.stat().st_size > 0: has_int_subs = True
                            else: shutil.copy2(str(cfp), str(part_dst)); part_ext_srt = psrt
                        else:
                            shutil.copy2(str(cfp), str(part_dst))
                            if subtitles == "files": part_ext_srt = psrt
                    else:
                        shutil.copy2(str(cfp), str(part_dst))
                    if part_dst.exists() and part_dst.stat().st_size <= int(18.5 * 1024 * 1024):
                        parts_to_send.append((part_dst, int(round(cdur)), part_ext_srt))
                    else:
                        skipped_p += 1
                        print(f"WARNING: Email part #{idx_p} exceeded 18.5MB limit and was skipped.", flush=True)

                pl_file = final_dir / f"00 - הפעל הכל לפי הסדר - {clean_stem}.m3u8"
                pl_file.write_text("\n".join(["#EXTM3U"] + [ln for pf, pdur, _ in parts_to_send for ln in (f"#EXTINF:{max(1, pdur)},{pf.stem}", pf.name)]) + "\n", encoding="utf-8")
                tot_p, tid, sent_ok = len(parts_to_send), f"<ytcloud-{req_id}-part1@gmail.com>", 0
                for p_idx, (pfp, _, psrt) in enumerate(parts_to_send, 1):
                    hdrs = {"Message-ID": tid if p_idx == 1 else f"<ytcloud-{req_id}-part{p_idx}@gmail.com>", **({"In-Reply-To": tid, "References": tid} if p_idx > 1 else {})}
                    atts = ([(pl_file, "application", "vnd.apple.mpegurl", pl_file.name)] if (p_idx == 1 and pl_file.exists()) else []) + [(pfp, "application", "octet-stream", pfp.name)] + ([(psrt, "text", "plain", psrt.name)] if (psrt and psrt.exists() and psrt.stat().st_size <= 2 * 1024 * 1024) else [])
                    body_p = f"שלום,\n\nחלק {p_idx} מתוך {tot_p} — איכות מקורית מלאה (השהיה בטוחה למניעת חסימת Gmail)!\n• קובץ מצורף: {pfp.name} ({round(pfp.stat().st_size/1048576, 1)} MB)\n• איכות מקור: {quality_report} (גודל כולל: {file_mb} MB)\n" + ("• כתוביות פנימיות בעברית: מוטמעות ומסונכרנות אוטומטית בכל חלק!\n" if has_int_subs else "") + f"• להפעלה אוטומטית ברצף: שמור את כל {tot_p} החלקים + קובץ הפלייליסט (.m3u8 ממייל #1) באותה תיקייה ולחץ דאבל-קליק על \"00 - הפעל הכל לפי הסדר...\".\n"
                    _send_mail(base_subject, body_p, atts, hdrs)
                    sent_ok += 1
                    if p_idx < tot_p:
                        print(f"Waiting {SMTP_COOLDOWN_SEC}s before next email part to protect Gmail account...", flush=True)
                        time.sleep(SMTP_COOLDOWN_SEC)
                email_delivered_ok = sent_ok > 0
                email_sent_status = f"נשלח למייל באיכות מקורית ({sent_ok}/{tot_p} חלקים מושהים + פלייליסט){f' (⚠️ {skipped_p} חלקים חרגו מ-18.5MB ודולגו)' if skipped_p else ''}"
                print(f">>> EMAIL OK: {email_sent_status}", flush=True)
            else:
                attach_fp = None
                if is_vid_f:
                    mail_prev = mail_work / f"{clean_stem} (Mail Safe).mp4"
                    dur_s = max(10.0, _probe_dur_sec(primary_file) or float(detected_dur or 600.0))
                    v_kbps = max(95, int((14.5 * 8192) / dur_s) - 56)
                    _ffmpeg_ok(["-i", str(primary_file), "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-map_chapters", "-1", "-vf", f"scale=trunc(oh*a/2)*2:{480 if v_kbps >= 280 else 360}", "-c:v", "libx264", "-preset", "veryfast", "-b:v", f"{v_kbps}k", "-maxrate", f"{int(v_kbps*1.15)}k", "-bufsize", f"{v_kbps*2}k", "-c:a", "aac", "-b:a", "56k", "-movflags", "+faststart", "-fs", str(int(16.0 * 1024 * 1024)), str(mail_prev)])
                    if mail_prev.exists() and 0 < mail_prev.stat().st_size <= MAX_GMAIL_RAW_BYTES: attach_fp = mail_prev
                atts = ([(attach_fp, "application", "octet-stream", attach_fp.name)] if attach_fp else []) + _collect_side_srts(clean_stem)
                body_a = f"שלום,\n\n🛡️ הגנת חסימת Gmail הופעלה: הקובץ המקורי גדול מאוד ({file_mb} MB — כ-{est_parts} חלקים) ושליחה של מעל {MAX_SAFE_SMTP_PARTS} מיילים כבדים גורמת לגוגל לנעול את חשבון ה-Gmail זמנית.\n\n" + (f"• מצב ענן בלבד פעיל — הקובץ המלא לא הורד למחשב (0MB).\n" if cloud_only_flag else f"• הקובץ המלא באיכות המקורית ({quality_report}) נשמר אצלך במחשב!\n") + (f"• למייל זה צורף עותק צפייה מותאם במייל אחד בטוח ({round(attach_fp.stat().st_size/1048576, 1)} MB).\n" if attach_fp else "") + "• טיפ: חבר Google Drive (דרך הגדרת ה-Secrets של Drive במאגר) — ואז כל קובץ גדול יועלה אוטומטית ל-Drive באיכות 100% וישלח אליך במייל אחד קליל עם קישור ישיר!\n"
                _send_mail(base_subject, body_a, atts)
                email_delivered_ok, email_sent_status = True, f"נשלח מייל אחד מוגן (הגנת חסימת Gmail לקובץ {file_mb}MB — חבר Drive לאיכות מלאה)"
                print(f">>> EMAIL OK (ANTI-LOCKOUT): {email_sent_status}", flush=True)
    except Exception as e:
        print(f"Email delivery error: {type(e).__name__}: {e}", flush=True)
        email_sent_status = f"שגיאת מייל ({type(e).__name__})"
    finally:
        shutil.rmtree("/tmp/mail_parts", ignore_errors=True)
        telemetry["email_sec"] = round(time.time() - t_em, 1)

is_cloud_only_done = bool(cloud_only_flag and (drive_web_link or email_delivered_ok))
rel_files = [str(z) for z in zip_paths]
if cloud_only_flag:
    drv_marker = pkg_dir / ("cloud-ok.txt" if is_cloud_only_done else "cloud-failed.txt")
    drv_marker.write_text("Cloud-Only delivery (Drive/Email) completed. Zero local PC download.\n" if is_cloud_only_done else f"Cloud-Only delivery failed: drive={drive_status} | email={email_sent_status}\n", encoding="utf-8")
    rel_files, blob_shas = [str(drv_marker)], []

telemetry["total_cloud_sec"] = round(time.time() - t_job_start, 1)
telemetry["file_mb"] = file_mb
notes = json.dumps({
    "v": 24.0, "size": zip_size, "video_title": primary_file.stem, "quality_info": f"{quality_report} ({file_mb} MB)",
    "subs_verified": subs_verified_flag, "subs_detail": subs_detail_msg, "split_join": split_join_meta,
    "email_status": email_sent_status, "drive_status": drive_status, "drive_url_enc": drive_url_enc,
    "drive_only": is_cloud_only_done, "cloud_only": is_cloud_only_done,
    "cloud_temp_path": "Cloud-Only (0MB Local Traffic -> Drive/Email)" if cloud_only_flag else ("/tmp/stage -> /tmp/out -> /tmp/pkg/" + zip_path.name),
    "blobs": blob_shas, "telemetry": telemetry,
}, ensure_ascii=False)

rc_rel = subprocess.run(["gh", "release", "create", tag] + rel_files + ["--repo", repo, "--title", tag, "--notes", notes], capture_output=True, text=True, check=False)
if rc_rel.returncode != 0:
    print(f"gh release create failed: {(rc_rel.stderr or rc_rel.stdout)[:300]}", flush=True)
    subprocess.run(["gh", "release", "create", tag, "--repo", repo, "--title", tag, "--notes", notes], capture_output=True, text=True, check=False)
    up_errs = []
    for z in rel_files:
        ru = subprocess.run(["gh", "release", "upload", tag, str(z), "--repo", repo, "--clobber"], capture_output=True, text=True, check=False)
        if ru.returncode != 0:
            up_errs.append((ru.stderr or ru.stdout)[:160])
    if up_errs:
        raise SystemExit(f"::error::Release upload failed: {' | '.join(up_errs)[:240]}")
