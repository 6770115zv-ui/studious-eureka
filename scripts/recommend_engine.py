import base64, datetime, io, json, math, os, re, subprocess, threading, time, urllib.parse, requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image

req_id = os.environ.get("REQ_ID", "").strip()
query = os.environ.get("QUERY", "").strip()
channel_input = os.environ.get("CHANNEL", "").strip()
sort_raw = os.environ.get("SORT_BY", "relevance").strip()
max_results = max(10, min(2500, int(os.environ.get("MAX_RESULTS", "60") or 60)))
min_views = int(os.environ.get("MIN_VIEWS", "0") or 0)
exclude = set(filter(None, os.environ.get("EXCLUDE_IDS", "").split(",")))
filter_prompt = os.environ.get("FILTER_PROMPT", "").strip()
cookies_enc = os.environ.get("COOKIES_ENC", "").strip()
secret_key_env = os.environ.get("COOKIE_KEY", "").strip().strip("\"'")

def mask_secret(*vals):
    for v in vals:
        if v and len(str(v)) >= 8:
            print(f"::add-mask::{v}", flush=True)

mask_secret(cookies_enc, secret_key_env, os.environ.get("GEMINI_API_KEY", "").strip().strip("\"'"))

fp_low = filter_prompt.lower()
high_quality_only = "[hq_only]" in fp_low or "|hq" in sort_raw.lower()
translate_titles = "[tr_he]" in fp_low or "|tr" in sort_raw.lower()
playlist_mode = "streams" if "[pl_streams]" in fp_low else ("uu_all" if "[pl_uu]" in fp_low else ("uulp" if "[pl_uulp]" in fp_low else "auto"))
m_dur = re.search(r"\[dur:([a-z0-9_]+)\]", fp_low)
dur_filter = m_dur.group(1) if m_dur else "all"
m_season = re.search(r"\[season:([a-z0-9_]+)\]", fp_low)
season_filter = m_season.group(1) if m_season else "all"
m_il = re.search(r"\[il_ids:([a-zA-Z0-9_,-]+)\]", filter_prompt, flags=re.I)
il_seed_ids = [x.strip() for x in (m_il.group(1).split(",") if m_il else []) if len(x.strip()) == 11]
m_langs = re.search(r"\[langs:([a-z,]+)\]", fp_low)
search_langs = [x.strip() for x in (m_langs.group(1).split(",") if m_langs else ["he", "en", "es"]) if x.strip()]
expand_queries = "[expand]" in fp_low
m_ctype = re.search(r"\[ctype:([a-z0-9_]+)\]", fp_low)
content_type = m_ctype.group(1) if m_ctype else "all"
no_gaming = "[no_gaming]" in fp_low
m_excl = re.search(r"\[excl:([^\]]+)\]", filter_prompt, flags=re.I)
exclude_terms = [urllib.parse.unquote(x).strip().lower() for x in (m_excl.group(1).split(",") if m_excl else []) if x.strip()]

SEASON_RANGES = {
    "2026_2027": ("20260801", "20270731", "after:2026-07-31"),
    "2025_2026": ("20250801", "20260731", "after:2025-07-31 before:2026-08-01"),
    "2024_2025": ("20240801", "20250731", "after:2024-07-31 before:2025-08-01"),
    "2023_2024": ("20230801", "20240731", "after:2023-07-31 before:2024-08-01"),
    "2022_2023": ("20220801", "20230731", "after:2022-07-31 before:2023-08-01"),
    "year_2025": ("20250101", "20251231", "after:2024-12-31 before:2026-01-01"),
    "year_2024": ("20240101", "20241231", "after:2023-12-31 before:2025-01-01"),
    "year_2023": ("20230101", "20231231", "after:2022-12-31 before:2024-01-01"),
    "before_2023": ("19900101", "20221231", "before:2023-01-01"),
}
season_info = SEASON_RANGES.get(season_filter)
sort_by = re.sub(r"\|(hq|tr|notr)", "", sort_raw.lower()).strip() or "relevance"
filter_prompt = re.sub(r"\[(HQ_ONLY|TR_HE|PL_UU|PL_STREAMS|PL_UULP|DUR:[A-Z0-9_]+|SEASON:[A-Z0-9_]+|IL_IDS:[A-Za-z0-9_,-]+|LANGS:[a-z,]+|EXPAND|CTYPE:[A-Z0-9_]+|NO_GAMING|EXCL:[^\]]+)\]", "", filter_prompt, flags=re.I).strip()

try:
    from google import genai as _genai
    from google.genai import types as _gtypes
    import importlib.metadata as _im
    _GENAI_SDK_VER = _im.version("google-genai")
except Exception:
    _genai, _gtypes, _GENAI_SDK_VER = None, None, "rest-fallback"

def _parse_json_lenient(raw_s: str):
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(raw_s or ""), flags=re.S).strip()
    try:
        return json.loads(s)
    except Exception:
        dec = json.JSONDecoder()
        for cand_s in (s, re.sub(r",\s*([}\]])", r"\1", s)):
            for m_st in re.finditer(r"[\{\[]", cand_s):
                try:
                    obj, _ = dec.raw_decode(cand_s, m_st.start())
                    if isinstance(obj, (dict, list)):
                        return obj
                except Exception:
                    pass
        raise

class AIRouter:
    PREFERRED_GEMINI = [
        "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
        "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.8-flash",
        "gemini-4-argon", "gemini-4-carbon",
    ]
    PREFERRED_GROQ_PREFIXES = [
        "qwen/qwen3.8", "qwen/qwen3", "qwen",
        "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "llama-4",
        "llama-3.3-70b", "openai/gpt-oss-120b", "openai/gpt-oss-20b",
        "moonshotai/kimi", "deepseek", "llama-3.1-8b", "gemma",
    ]
    PREFERRED_CEREBRAS_PREFIXES = [
        "gpt-oss-120b", "qwen-3.8", "qwen-3-235b", "qwen-3",
        "zai-glm", "deepseek", "llama-4", "llama3.1-8b",
    ]
    CEREBRAS_MODELS = ["gpt-oss-120b", "qwen-3.8-27b", "qwen-3-235b-a22b-instruct-2507", "zai-glm-4.7"]
    PREFERRED_OPENROUTER_PREFIXES = [
        "nvidia/nemotron", "qwen/", "deepseek/", "meta-llama/", "google/gemma", "openai/gpt-oss",
    ]
    OPENROUTER_MODELS = ["openrouter/free", "nvidia/nemotron-3-ultra:free"]

    def __init__(self):
        self.lock = threading.Lock()
        self.gemini_keys = self._collect_gemini_keys()
        self.groq_key = os.environ.get("GROQ_API_KEY", "").strip().strip("\"'")
        self.cerebras_key = os.environ.get("CEREBRAS_API_KEY", "").strip().strip("\"'")
        self.openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip().strip("\"'")
        mask_secret(*self.gemini_keys, self.groq_key, self.cerebras_key, self.openrouter_key)

        self.key_stats = {
            f"Gemini#{i}": {"alias": f"Gemini#{i}", "provider": "gemini", "status": "ready", "ok": 0, "fail": 0, "last_error": ""}
            for i in range(1, len(self.gemini_keys) + 1)
        }
        for alias, prov, kv in (("Groq#1", "groq", self.groq_key), ("Cerebras#1", "cerebras", self.cerebras_key), ("OpenRouter#1", "openrouter", self.openrouter_key)):
            if kv:
                self.key_stats[alias] = {"alias": alias, "provider": prov, "status": "ready", "ok": 0, "fail": 0, "last_error": ""}

        self.dead_keys, self.dead_models = set(), set()
        self.low_thinking_models, self.no_thinking_models = set(), set()
        self.cooldowns, self._clients = {}, {}
        self.rr_cursor = 0
        self.call_log, self.errors, self.alerts_he = [], [], []
        self.discovered_models, self.discovered_groq_models = [], []
        self.discovered_cerebras_models, self.discovered_openrouter_models = [], []
        with ThreadPoolExecutor(max_workers=4) as ex:
            f_gem = ex.submit(self._discover_gemini_models)
            f_grq = ex.submit(self._discover_groq_models)
            f_cer = ex.submit(self._discover_cerebras_models)
            f_orr = ex.submit(self._discover_openrouter_models)
            self.gemini_models = f_gem.result()
            self.groq_models = f_grq.result()
            self.cerebras_models = f_cer.result()
            self.openrouter_models = f_orr.result()

    def _collect_gemini_keys(self):
        parts = []
        for k in ("GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4", "GEMINI_API_KEY_5"):
            if os.environ.get(k):
                parts.extend(re.split(r"[,;\r\n\s]+", os.environ[k]))
        out, seen = [], set()
        for p in parts:
            cl = p.strip().strip("\"'")
            if len(cl) >= 16 and cl not in seen:
                seen.add(cl); out.append(cl)
        return out

    def has_any_provider(self) -> bool:
        return bool(self.gemini_keys or self.groq_key or self.cerebras_key or self.openrouter_key)

    def _get_client(self, alias: str, api_key: str, timeout_sec: int):
        if _genai is None or _gtypes is None:
            return None
        ck = (alias, timeout_sec)
        with self.lock:
            if ck in self._clients:
                return self._clients[ck]
        try:
            cl = _genai.Client(api_key=api_key, http_options=_gtypes.HttpOptions(timeout=int(timeout_sec * 1000)))
            with self.lock:
                self._clients[ck] = cl
            return cl
        except Exception:
            return None

    def _discover_gemini_models(self):
        if not self.gemini_keys:
            return []
        found = []
        bad = ("embedding", "imagen", "veo", "tts", "audio", "image", "robotics", "computer-use", "deep-research", "omni", "preview", "exp", "nano", "live", "1.0", "1.5", "2.0", "2.5")
        for ki, kval in enumerate(self.gemini_keys, 1):
            alias = f"Gemini#{ki}"
            try:
                cl = self._get_client(alias, kval, 10)
                if cl is not None:
                    for m in cl.models.list():
                        name = str(getattr(m, "name", "") or "").replace("models/", "").strip()
                        acts = [str(a) for a in (getattr(m, "supported_actions", None) or [])]
                        if name.lower().startswith("gemini-") and (not acts or "generateContent" in acts) and not any(b in name.lower() for b in bad):
                            found.append(name)
                else:
                    r = requests.get("https://generativelanguage.googleapis.com/v1beta/models", headers={"x-goog-api-key": kval}, timeout=10)
                    if r.status_code == 200:
                        for m in (r.json().get("models") or []):
                            name = str(m.get("name") or "").replace("models/", "").strip()
                            if name.lower().startswith("gemini-") and "generateContent" in (m.get("supportedGenerationMethods") or []) and not any(b in name.lower() for b in bad):
                                found.append(name)
                    elif r.status_code in (401, 403):
                        raise RuntimeError(f"HTTP {r.status_code}")
                if found:
                    break
            except Exception as e:
                es = f"{type(e).__name__}: {e}"
                low_e = es.lower()
                with self.lock:
                    self.errors.append(f"gemini_discovery#G{ki}: {es[:80]}")
                    if any(k in low_e for k in ("401", "403", "api_key_invalid", "permission_denied")):
                        self.dead_keys.add(alias)
                        self.key_stats[alias]["status"] = "invalid_key"
                        self.key_stats[alias]["last_error"] = es[:90]
                if alias in self.dead_keys:
                    self._add_alert(f"⚠️ {alias} לא תקין או חסום (401/403) — בדוק את ה-Secret ב-GitHub.")

        self.discovered_models = sorted(set(found))
        if not found:
            return list(self.PREFERRED_GEMINI[:4])
        ranked = [p for p in self.PREFERRED_GEMINI if p in found]
        for extra in found:
            if "flash" in extra.lower() and extra not in ranked:
                ranked.append(extra)
        print(f"AIRouter live Gemini ladder: {ranked[:6]}", flush=True)
        return ranked[:6] or list(self.PREFERRED_GEMINI[:5])

    def _discover_groq_models(self):
        if not self.groq_key:
            return []
        found, bad = [], ("whisper", "tts", "orpheus", "playai", "guard", "safeguard", "embed", "moderation", "vision-preview", "allam", "distil")
        try:
            r = requests.get("https://api.groq.com/openai/v1/models", headers={"Authorization": f"Bearer {self.groq_key}", "Accept": "application/json"}, timeout=10)
            if r.status_code == 200:
                for m in (r.json().get("data") or []):
                    mid = str(m.get("id") or "").strip()
                    if mid and m.get("active") is not False and not any(b in mid.lower() for b in bad):
                        found.append(mid)
            elif r.status_code in (401, 403):
                with self.lock:
                    self.dead_keys.add("Groq#1")
                    self.key_stats["Groq#1"]["status"] = "invalid_key"
                self._add_alert("⚠️ מפתח GROQ_API_KEY לא תקין (401/403) — בדוק את ה-Secret ב-GitHub.")
                return []
            else:
                with self.lock:
                    self.errors.append(f"groq_discovery: HTTP {r.status_code}: {r.text[:80]}")
        except Exception as e:
            with self.lock:
                self.errors.append(f"groq_discovery: {type(e).__name__}: {str(e)[:80]}")

        self.discovered_groq_models = sorted(set(found))
        if not found:
            return []
        ranked = []
        for pref in self.PREFERRED_GROQ_PREFIXES:
            for mid in found:
                if pref in mid.lower() and mid not in ranked:
                    ranked.append(mid)
        for mid in found:
            if mid not in ranked:
                ranked.append(mid)
        print(f"AIRouter live Groq ladder ({len(found)} found): {ranked[:4]}", flush=True)
        return ranked[:4]

    def _discover_cerebras_models(self):
        if not self.cerebras_key:
            return []
        found, bad = [], ("whisper", "tts", "embed", "guard", "moderation")
        try:
            r = requests.get("https://api.cerebras.ai/v1/models", headers={"Authorization": f"Bearer {self.cerebras_key}", "Accept": "application/json"}, timeout=8)
            if r.status_code == 200:
                for m in (r.json().get("data") or []):
                    mid = str(m.get("id") or "").strip()
                    if mid and not any(b in mid.lower() for b in bad):
                        found.append(mid)
            elif r.status_code in (401, 403):
                with self.lock:
                    self.dead_keys.add("Cerebras#1")
                    self.key_stats["Cerebras#1"]["status"] = "invalid_key"
                self._add_alert("⚠️ מפתח CEREBRAS_API_KEY לא תקין (401/403) — בדוק את ה-Secret ב-GitHub.")
                return []
            else:
                with self.lock:
                    self.errors.append(f"cerebras_discovery: HTTP {r.status_code}: {r.text[:80]}")
        except Exception as e:
            with self.lock:
                self.errors.append(f"cerebras_discovery: {type(e).__name__}: {str(e)[:80]}")

        self.discovered_cerebras_models = sorted(set(found))
        if not found:
            return list(self.CEREBRAS_MODELS[:3])
        ranked = []
        for pref in self.PREFERRED_CEREBRAS_PREFIXES:
            for mid in found:
                if pref in mid.lower() and mid not in ranked:
                    ranked.append(mid)
        for mid in found:
            if mid not in ranked:
                ranked.append(mid)
        print(f"AIRouter live Cerebras ladder ({len(found)} found): {ranked[:4]}", flush=True)
        return ranked[:4]

    def _discover_openrouter_models(self):
        if not self.openrouter_key:
            return []
        found, bad = [], ("embed", "tts", "whisper", "image", "vl", "vision", "guard", "moderation", "audio")
        try:
            r = requests.get("https://openrouter.ai/api/v1/models", headers={"Authorization": f"Bearer {self.openrouter_key}", "Accept": "application/json"}, timeout=8)
            if r.status_code == 200:
                for m in (r.json().get("data") or []):
                    mid = str(m.get("id") or "").strip()
                    pr = m.get("pricing") or {}
                    is_zero = str(pr.get("prompt", "")) == "0" and str(pr.get("completion", "")) == "0"
                    if mid and is_zero and mid != "openrouter/free" and not any(b in mid.lower() for b in bad):
                        found.append(mid)
            elif r.status_code in (401, 403):
                with self.lock:
                    self.dead_keys.add("OpenRouter#1")
                    self.key_stats["OpenRouter#1"]["status"] = "invalid_key"
                self._add_alert("⚠️ מפתח OPENROUTER_API_KEY לא תקין (401/403) — בדוק את ה-Secret ב-GitHub.")
                return []
            else:
                with self.lock:
                    self.errors.append(f"openrouter_discovery: HTTP {r.status_code}: {r.text[:80]}")
        except Exception as e:
            with self.lock:
                self.errors.append(f"openrouter_discovery: {type(e).__name__}: {str(e)[:80]}")

        self.discovered_openrouter_models = sorted(set(found))
        ranked = ["openrouter/free"]
        for pref in self.PREFERRED_OPENROUTER_PREFIXES:
            for mid in found:
                if pref in mid.lower() and mid not in ranked:
                    ranked.append(mid)
        for mid in found:
            if mid not in ranked:
                ranked.append(mid)
        res = ranked[:4] if found else list(self.OPENROUTER_MODELS)
        print(f"AIRouter live OpenRouter ladder ({len(found)} free found): {res}", flush=True)
        return res

    def _thinking_cfg(self, model_name: str):
        if _gtypes is None or model_name in self.no_thinking_models:
            return None
        low = model_name.lower()
        fields = getattr(_gtypes.ThinkingConfig, "model_fields", {}) or {}
        if "gemini-3" in low or "gemini-4" in low:
            no_minimal = (
                model_name in self.low_thinking_models
                or "gemini-3.8" in low
                or "gemini-4" in low
                or "-pro" in low
            )
            levels = ("LOW",) if no_minimal else ("MINIMAL", "LOW")
            if "thinking_level" in fields:
                for lvl in levels:
                    try:
                        return _gtypes.ThinkingConfig(thinking_level=lvl)
                    except Exception:
                        pass
            if "thinking_budget" in fields and not no_minimal:
                try:
                    return _gtypes.ThinkingConfig(thinking_budget=0)
                except Exception:
                    pass
        return None

    def _call_gemini_once(self, alias: str, api_key: str, model_name: str, prompt_text: str, timeout_sec: int):
        cl = self._get_client(alias, api_key, timeout_sec)
        t_cfg = self._thinking_cfg(model_name)
        if cl is not None and _gtypes is not None:
            kw = {"temperature": 0.15, "response_mime_type": "application/json", **({"thinking_config": t_cfg} if t_cfg is not None else {})}
            resp = cl.models.generate_content(model=model_name, contents=prompt_text, config=_gtypes.GenerateContentConfig(**kw))
            cands_r = getattr(resp, "candidates", None) or []
            txt_out = ""
            if cands_r and getattr(cands_r[0], "content", None) and getattr(cands_r[0].content, "parts", None):
                txt_out = "".join(str(getattr(p, "text", "") or "") for p in cands_r[0].content.parts if not getattr(p, "thought", False)).strip()
            txt_out = txt_out or str(getattr(resp, "text", "") or "").strip()
            if not txt_out:
                raise RuntimeError("empty_response")
            return _parse_json_lenient(txt_out)
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json={"contents": [{"parts": [{"text": prompt_text}]}], "generationConfig": {"temperature": 0.15, "responseMimeType": "application/json"}},
            timeout=timeout_sec,
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:140]}")
        parts = ((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        txt_out = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not txt_out:
            raise RuntimeError("empty_response")
        return _parse_json_lenient(txt_out)

    def _call_openai_compat(self, url: str, headers: dict, model_name: str, prompt_text: str, timeout_sec: int, use_json_mode: bool = True):
        body = {
            "model": model_name, "temperature": 0.15,
            "messages": [
                {"role": "system", "content": "You are a strict JSON API. Return ONLY a single valid JSON object matching the requested schema, with no markdown fences and no extra text."},
                {"role": "user", "content": prompt_text},
            ],
            **({"response_format": {"type": "json_object"}} if use_json_mode else {}),
        }
        r = requests.post(url, headers={**headers, "Content-Type": "application/json", "Accept": "application/json"}, json=body, timeout=timeout_sec)
        if r.status_code == 400 and use_json_mode and any(k in r.text.lower() for k in ("response_format", "json_validate", "json", "structured", "unsupported")):
            return self._call_openai_compat(url, headers, model_name, prompt_text, timeout_sec, False)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:140]}")
        if not (r.text or "").strip():
            raise RuntimeError("HTTP 200 empty body")
        msg_obj = (((json.loads(r.text).get("choices") or [{}])[0]).get("message") or {})
        content = (msg_obj.get("content") or "").strip()
        if not content:
            content = (msg_obj.get("reasoning_content") or msg_obj.get("reasoning") or "").strip()
        content = re.sub(r"<think>[\s\S]*?</think>", "", content, flags=re.I).strip()
        if not content:
            raise RuntimeError("empty_choices_content")
        return _parse_json_lenient(content)

    def _record(self, stage, provider, model, alias, status, ms, err=""):
        with self.lock:
            self.call_log.append({"stage": stage, "provider": provider, "model": model, "key": alias, "status": status, "ms": int(ms), "error": str(err)[:110] if err else ""})
            st = self.key_stats.get(alias)
            if st:
                if status == "ok":
                    st["ok"] += 1; st["status"] = "active"
                else:
                    st["fail"] += 1; st["last_error"] = str(err)[:90]
            if err:
                self.errors.append(f"[{stage}] {alias}/{model}: {str(err)[:110]}")

    def _add_alert(self, msg_he: str):
        with self.lock:
            if msg_he not in self.alerts_he:
                self.alerts_he.append(msg_he)

    def _try_fast_backups(self, prompt_text: str, stage: str):
        backups = []
        for prov, alias, url, kv, models in (
            ("groq", "Groq#1", "https://api.groq.com/openai/v1/chat/completions", self.groq_key, self.groq_models),
            ("cerebras", "Cerebras#1", "https://api.cerebras.ai/v1/chat/completions", self.cerebras_key, self.cerebras_models),
            ("openrouter", "OpenRouter#1", "https://openrouter.ai/api/v1/chat/completions", self.openrouter_key, self.openrouter_models),
        ):
            if kv and alias not in self.dead_keys:
                for m in models:
                    if m not in self.dead_models:
                        backups.append((prov, alias, url, {"Authorization": f"Bearer {kv}"}, m))
        skip_aliases, now_bk = set(), time.time()
        for prov, alias, url, hdrs, m_name in backups:
            with self.lock:
                if alias in skip_aliases or alias in self.dead_keys or m_name in self.dead_models:
                    continue
                if self.cooldowns.get((alias, m_name), 0) > now_bk or self.cooldowns.get((alias, "*"), 0) > now_bk:
                    continue
            t0 = time.time()
            try:
                res = self._call_openai_compat(url, hdrs, m_name, prompt_text, 20)
                self._record(stage, prov, m_name, alias, "ok", (time.time() - t0) * 1000)
                self._add_alert(f"⚡ מעבר אוטומטי מהיר ל-{alias} ({m_name}) עקב עומס רגעי ב-Gemini!")
                return res, f"{prov}:{m_name.split('/')[-1]}"
            except Exception as e:
                es = f"{type(e).__name__}: {e}"
                self._record(stage, prov, m_name, alias, "fail", (time.time() - t0) * 1000, es)
                print(f"AIRouter [{stage}] {alias}/{m_name} failed: {es[:130]}", flush=True)
                with self.lock:
                    if "401" in es or "403" in es:
                        self.dead_keys.add(alias); self.key_stats[alias]["status"] = "invalid_key"; skip_aliases.add(alias)
                    elif "404" in es:
                        self.dead_models.add(m_name)
                    elif "request too large" in es.lower():
                        skip_aliases.add(alias)
                    elif "429" in es or "rate_limit" in es.lower():
                        self.cooldowns[(alias, m_name)] = time.time() + 30
                        self.cooldowns[(alias, "*")] = time.time() + 15
                        self.key_stats[alias]["status"] = "quota_429"; skip_aliases.add(alias)
        return None, ""

    def call_json(self, prompt_text: str, timeout_sec: int = 16, stage: str = "general"):
        has_fast_bk = bool(
            (self.groq_key and self.groq_models and "Groq#1" not in self.dead_keys)
            or (self.cerebras_key and self.cerebras_models and "Cerebras#1" not in self.dead_keys)
            or (self.openrouter_key and self.openrouter_models and "OpenRouter#1" not in self.dead_keys)
        )
        backups_tried, is_planner = False, stage.startswith("planner")

        if self.gemini_keys and self.gemini_models:
            with self.lock:
                start_k = self.rr_cursor % len(self.gemini_keys)
                self.rr_cursor += 1
            key_indices = [(start_k + i) % len(self.gemini_keys) for i in range(len(self.gemini_keys))]

            for pass_i in range(2):
                now, tried_any, tried_models = time.time(), False, set()
                cd_grace = 0.0 if pass_i == 0 else 10.0
                for m_name in (self.gemini_models if pass_i == 0 else self.gemini_models[:2]):
                    if m_name in self.dead_models or self.cooldowns.get(("*", m_name), 0) > now + cd_grace:
                        continue
                    global_503 = False
                    for k_idx in key_indices:
                        alias = f"Gemini#{k_idx + 1}"
                        if alias in self.dead_keys or self.cooldowns.get((alias, m_name), 0) > now + cd_grace:
                            continue
                        tried_any = True; tried_models.add(m_name); t0 = time.time()
                        m_to = min(timeout_sec, (18 if "lite" in m_name else 16) if is_planner else (20 if "lite" in m_name else 18))
                        try:
                            res = self._call_gemini_once(alias, self.gemini_keys[k_idx], m_name, prompt_text, m_to)
                            self._record(stage, "gemini", m_name, alias, "ok", (time.time() - t0) * 1000)
                            return res, m_name
                        except Exception as e:
                            ms, es = (time.time() - t0) * 1000, f"{type(e).__name__}: {e}"
                            low_e = es.lower()
                            if ("400" in low_e or "invalid_argument" in low_e) and any(k in low_e for k in ("thinking", "budget", "level")) and m_name not in self.no_thinking_models:
                                with self.lock:
                                    if m_name not in self.low_thinking_models and "gemini-3.8" not in m_name.lower() and "gemini-4" not in m_name.lower():
                                        self.low_thinking_models.add(m_name)
                                    else:
                                        self.no_thinking_models.add(m_name)
                                tr0 = time.time()
                                try:
                                    res = self._call_gemini_once(alias, self.gemini_keys[k_idx], m_name, prompt_text, m_to)
                                    self._record(stage, "gemini", m_name, alias, "ok", (time.time() - tr0) * 1000)
                                    return res, m_name
                                except Exception as e2:
                                    es, low_e = f"{type(e2).__name__}: {e2}", f"{type(e2).__name__}: {e2}".lower()
                                    if ("400" in low_e or "invalid_argument" in low_e) and any(k in low_e for k in ("thinking", "budget", "level")):
                                        with self.lock:
                                            self.no_thinking_models.add(m_name)
                            self._record(stage, "gemini", m_name, alias, "fail", ms, es)
                            print(f"AIRouter [{stage}] {alias}/{m_name} failed ({int(ms)}ms): {es[:130]}", flush=True)
                            bad_k = False
                            with self.lock:
                                if any(k in low_e for k in ("401", "403", "api_key_invalid", "permission_denied")):
                                    self.dead_keys.add(alias); self.key_stats[alias]["status"] = "invalid_key"; bad_k = True
                                elif "404" in low_e or "not_found" in low_e:
                                    self.dead_models.add(m_name)
                                elif any(k in low_e for k in ("429", "resource_exhausted", "quota")):
                                    self.cooldowns[(alias, m_name)] = time.time() + 30; self.key_stats[alias]["status"] = "quota_429"
                                elif any(k in low_e for k in ("504", "500", "internal", "deadline_exceeded", "timeout")):
                                    self.cooldowns[(alias, m_name)] = time.time() + 14; self.key_stats[alias]["status"] = "busy_503"
                                elif any(k in low_e for k in ("503", "unavailable", "high demand")):
                                    self.cooldowns[(alias, m_name)] = self.cooldowns[("*", m_name)] = time.time() + 10
                                    self.key_stats[alias]["status"] = "busy_503"; global_503 = True
                            if bad_k: self._add_alert(f"⚠️ {alias} לא תקין או חסום (401/403) — בדוק את ה-Secret ב-GitHub.")
                            if global_503: break
                    if (not is_planner) and has_fast_bk and not backups_tried and len(tried_models) >= 3:
                        backups_tried = True
                        b_res, b_mod = self._try_fast_backups(prompt_text, stage)
                        if b_res is not None: return b_res, b_mod
                if pass_i == 0:
                    if not backups_tried and (self.groq_key or self.cerebras_key or self.openrouter_key):
                        backups_tried = True
                        b_res, b_mod = self._try_fast_backups(prompt_text, stage)
                        if b_res is not None: return b_res, b_mod
                    time.sleep(1.5 if tried_any else 2.0)
        return (None, "") if backups_tried else self._try_fast_backups(prompt_text, stage)

    def export_telemetry(self):
        return {
            "sdk": f"google-genai {_GENAI_SDK_VER}",
            "gemini_keys_count": len(self.gemini_keys),
            "has_github_models_backup": False,
            "has_groq_backup": bool((self.groq_key and self.groq_models) or (self.cerebras_key and self.cerebras_models) or (self.openrouter_key and self.openrouter_models)),
            "active_ladder": (
                list(self.gemini_models[:4])
                + [f"groq:{m}" for m in self.groq_models[:2]]
                + [f"cerebras:{m}" for m in self.cerebras_models[:2]]
                + [f"openrouter:{m}" for m in self.openrouter_models[:1]]
            ),
            "discovered_models": self.discovered_models[:10],
            "discovered_groq_models": self.discovered_groq_models[:10],
            "key_health": list(self.key_stats.values()),
            "alerts_he": self.alerts_he[:6],
            "call_log": self.call_log[-18:],
        }

ai_router = AIRouter()

cookie_file = Path("/tmp/rec_cookies.txt")
cookie_dict = {"SOCS": "CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg", "CONSENT": "YES+cb"}
has_ck = False
if cookies_enc and len(secret_key_env) == 64:
    try:
        raw_enc = base64.b64decode(cookies_enc)
        pt = AESGCM(bytes.fromhex(secret_key_env)).decrypt(raw_enc[:12], raw_enc[12:], None).decode("utf-8", errors="replace")
        if "youtube.com" in pt or "# Netscape" in pt:
            cookie_file.write_text(pt, encoding="utf-8"); has_ck = True
            for ln in pt.splitlines():
                if ln and not ln.startswith("#"):
                    ps = ln.split("\t")
                    if len(ps) >= 7: cookie_dict[ps[5]] = ps[6]
    except Exception:
        pass

UA_STR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
YT_HDRS = {
    "Content-Type": "application/json", "User-Agent": UA_STR,
    "Origin": "https://www.youtube.com", "Referer": "https://www.youtube.com/",
    "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": "2.20261101.00.00",
    "X-Forwarded-For": "212.179.112.1", "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
}
def _yt_ctx(hl="en", gl="IL"):
    return {"client": {"clientName": "WEB", "clientVersion": "2.20261101.00.00", "hl": hl, "gl": gl}}

def _yt_post(endpoint: str, body: dict, hl="en", gl="IL", sess=None, timeout: int = 15):
    payload = {"context": _yt_ctx(hl, gl), **body}
    url = f"https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false"
    return (sess or requests).post(url, headers=None if sess else YT_HDRS, json=payload, timeout=timeout)

def parse_views_text(v_str) -> int:
    if isinstance(v_str, (int, float)): return int(v_str)
    s_clean = str(v_str or "").strip().replace(",", "").replace("\u200f", "").replace("\u200e", "")
    m_he = re.search(r"([\d.]+)\s*(מיליארד|מיליון|אלף)", s_clean)
    if m_he:
        return int(float(m_he.group(1)) * {"אלף": 1_000, "מיליון": 1_000_000, "מיליארד": 1_000_000_000}[m_he.group(2)])
    s = s_clean.upper()
    m = re.search(r"([\d.]+)\s*(MIL\b|[KMB])?", s)
    if not m:
        d = re.sub(r"\D", "", s)
        return int(d) if d else 0
    return int(float(m.group(1)) * {"K": 1_000, "MIL": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get((m.group(2) or "").strip(), 1))

def extract_11char_id(s: str) -> str:
    s = str(s or "").strip()
    if re.match(r"^SIMILAR:([a-zA-Z0-9_-]{11})$", s, re.I): return s.split(":", 1)[1]
    if re.match(r"^[a-zA-Z0-9_-]{11}$", s): return s
    m = re.search(r"(?:\[|v=|youtu\.be/|/shorts/|/embed/)([a-zA-Z0-9_-]{11})", s)
    return m.group(1) if m else ""

def find_tokens(sub_obj):
    toks = []
    if isinstance(sub_obj, dict):
        if "continuationCommand" in sub_obj:
            t = (sub_obj["continuationCommand"] or {}).get("token")
            if t: toks.append(t)
        for v in sub_obj.values(): toks.extend(find_tokens(v))
    elif isinstance(sub_obj, list):
        for it in sub_obj: toks.extend(find_tokens(it))
    return toks

def walk_items(obj, out_vids, out_toks):
    if isinstance(obj, dict):
        if "feedFilterChipBarRenderer" in obj:
            return
        vr = obj.get("videoRenderer") or obj.get("playlistVideoRenderer") or obj.get("compactVideoRenderer") or obj.get("gridVideoRenderer")
        if isinstance(vr, dict):
            vid = vr.get("videoId")
            if vid and len(vid) == 11:
                title = "".join(r.get("text", "") for r in ((vr.get("title") or {}).get("runs") or [])) or (vr.get("title") or {}).get("simpleText", "")
                vc_txt = ((vr.get("viewCountText") or {}).get("simpleText") or "".join(r.get("text", "") for r in ((vr.get("viewCountText") or {}).get("runs") or [])) or (vr.get("videoInfo") or {}).get("simpleText") or "".join(r.get("text", "") for r in ((vr.get("videoInfo") or {}).get("runs") or [])))
                dur_txt = (vr.get("lengthText") or {}).get("simpleText") or ""
                dur_sec = int(vr.get("lengthSeconds") or 0)
                if not dur_sec and ":" in dur_txt:
                    for p in (int(x) for x in dur_txt.split(":") if x.isdigit()): dur_sec = dur_sec * 60 + p
                ch_runs = ((vr.get("ownerText") or vr.get("longBylineText") or vr.get("shortBylineText") or {}).get("runs") or [])
                ch_id = next(((((ri.get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "") for ri in ch_runs if (((ri.get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "").startswith("UC")), "")
                out_vids.append({"id": vid, "title": title.strip(), "channel": "".join(r.get("text", "") for r in ch_runs).strip(), "channel_id": ch_id, "view_count": parse_views_text(vc_txt), "published_rel": ((vr.get("publishedTimeText") or {}).get("simpleText") or "").strip(), "duration": dur_sec})
        if "continuationItemRenderer" in obj:
            for t in find_tokens(obj["continuationItemRenderer"]):
                if t not in out_toks: out_toks.append(t)
        for k, v in obj.items():
            if k != "feedFilterChipBarRenderer": walk_items(v, out_vids, out_toks)
    elif isinstance(obj, list):
        for it in obj: walk_items(it, out_vids, out_toks)

allowed_uc_ids, allowed_ch_names = set(), set()

def fetch_search(q_str: str, sp_param: str = "", target_count: int = 120, must_match_uc: str = "", must_match_name: str = ""):
    if not q_str: return []
    collected, seen_vids, visited = [], set(), set()
    max_pages = max(5, min(20, (target_count // 18) + 3))
    try:
        r = _yt_post("search", {"query": q_str, **({"params": sp_param} if sp_param else {})}, timeout=15)
        if r.status_code != 200: return []
        vids, toks = [], []
        walk_items(r.json(), vids, toks)
        def accept(arr):
            for v in arr:
                if v["id"] in seen_vids: continue
                if must_match_uc and v.get("channel_id") and v["channel_id"] != must_match_uc and v["channel_id"] not in allowed_uc_ids: continue
                if must_match_name and not v.get("channel_id") and v.get("channel") and v["channel"].strip().lower() != must_match_name.strip().lower(): continue
                seen_vids.add(v["id"]); collected.append(v)
        accept(vids); pages = 0
        while toks and len(collected) < target_count and pages < max_pages:
            nt = toks.pop(0)
            if nt in visited: continue
            visited.add(nt); pages += 1
            rn = _yt_post("search", {"continuation": nt}, timeout=15)
            if rn.status_code != 200: break
            mv, mt = [], []
            walk_items(rn.json(), mv, mt); accept(mv)
            for t in mt:
                if t not in visited: toks.append(t)
    except Exception:
        pass
    return collected

def fetch_yt_json(target_url, limit_str, forced_uc: str = "", forced_name: str = ""):
    for use_ck in ([False, True] if has_ck else [False]):
        cmd = ["python3", "-m", "yt_dlp", "--force-ipv4", "--xff", "IL", "--dump-json", "--flat-playlist", "--playlist-end", str(limit_str), "--ignore-errors", "--no-warnings", "--js-runtimes", "deno"] + (["--cookies", str(cookie_file)] if use_ck else []) + [target_url]
        out = []
        for ln in subprocess.run(cmd, capture_output=True, text=True).stdout.splitlines():
            try:
                d = json.loads(ln); vid = str(d.get("id") or "")
                if len(vid) == 11:
                    if forced_uc: d["channel_id"] = forced_uc
                    if forced_name and not d.get("channel"): d["channel"] = forced_name
                    out.append(d)
            except Exception:
                pass
        if out: return out
    return []

is_similar = query.upper().startswith("SIMILAR:")
if is_similar:
    season_info = None; season_filter = "all"; channel_input = ""
direct_vid = extract_11char_id(channel_input) or extract_11char_id(query)
seed_video, related_videos = None, []
if direct_vid:
    try:
        pr = _yt_post("player", {"videoId": direct_vid}, timeout=12)
        vd = (pr.json().get("videoDetails") or {}) if pr.status_code == 200 else {}
        if vd.get("videoId"):
            seed_video = {"id": vd["videoId"], "title": vd.get("title") or direct_vid, "channel": vd.get("author") or "", "channel_id": vd.get("channelId") or "", "view_count": int(vd.get("viewCount") or 0), "duration": int(vd.get("lengthSeconds") or 0)}
            rn = _yt_post("next", {"videoId": direct_vid}, timeout=12)
            if rn.status_code == 200:
                rv, rt = [], []
                walk_items(rn.json(), rv, rt); related_videos.extend(rv)
            if is_similar:
                query = f"{seed_video['channel']} {re.sub(r'\[[a-zA-Z0-9_-]{11}\]|\([^\)]*\)|\|.*', '', seed_video['title']).strip()}".strip()
                channel_input = ""
            else:
                if not channel_input and vd.get("channelId"): channel_input = f"https://www.youtube.com/channel/{vd['channelId']}"
                if query == direct_vid or f"[{direct_vid}]" in query: query = ""
    except Exception:
        pass

def resolve_channel(ch_raw: str):
    ch = ch_raw.strip()
    if not ch: return "", "", ""
    base, name, uc_id = "", ch, ""
    m_uc = re.search(r"(UC[a-zA-Z0-9_-]{22})", ch)
    if m_uc: uc_id, base = m_uc.group(1), f"https://www.youtube.com/channel/{m_uc.group(1)}"
    elif ch.startswith("http"):
        base = re.sub(r"/(videos|shorts|streams|playlists|about|featured)/?$", "", ch.rstrip("/"))
        m_h = re.search(r"(@[a-zA-Z0-9_.-]+)", base)
        name = m_h.group(1) if m_h else base.split("/")[-1]
    elif ch.startswith("@"):
        h = ch.split("/")[0]; base, name = f"https://www.youtube.com/{h}", h
    elif re.match(r"^[a-zA-Z0-9_.-]+$", ch):
        base = f"https://www.youtube.com/@{ch}"
    if base and not uc_id:
        try:
            rr = _yt_post("navigation/resolve_url", {"url": base}, timeout=12)
            if rr.status_code == 200:
                bid = (((rr.json().get("endpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "")
                if bid.startswith("UC"): uc_id = bid
        except Exception: pass
    if base:
        try:
            resp = requests.get(f"{base}/videos", headers={"User-Agent": UA_STR}, cookies=cookie_dict, timeout=15)
            if resp.status_code == 200:
                if not uc_id:
                    me = re.search(r'"(?:externalId|channelId|browseId)"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"', resp.text)
                    if me: uc_id = me.group(1)
                mt = re.search(r'<meta property="og:title" content="([^"]+)"', resp.text)
                if mt and mt.group(1).strip(): name = mt.group(1).strip()
        except Exception: pass
    return base, uc_id, name

def fetch_playlist_browse(browse_id: str, ch_title: str, uc_id: str, max_pages: int = 80, target_count: int = 2500):
    collected, seen_vids, visited = [], set(), set()
    try:
        rp = _yt_post("browse", {"browseId": browse_id}, hl="en", gl="US", timeout=20)
        if rp.status_code != 200: return []
        pv, pt = [], []
        walk_items(rp.json(), pv, pt)
        def _take(arr):
            for v in arr:
                if v["id"] not in seen_vids:
                    seen_vids.add(v["id"]); v["channel"] = ch_title; v["channel_id"] = uc_id; collected.append(v)
        _take(pv); pages = 0
        while pt and len(collected) < target_count and pages < max_pages:
            nt = pt.pop(0)
            if nt in visited: continue
            visited.add(nt); pages += 1
            rn = _yt_post("browse", {"continuation": nt}, hl="en", gl="US", timeout=20)
            if rn.status_code != 200: break
            mv, mt = [], []
            walk_items(rn.json(), mv, mt); _take(mv)
            for t in mt:
                if t not in visited: pt.append(t)
    except Exception:
        pass
    return collected

def fetch_channel_vids(base_url: str, uc_id: str, ch_title: str, sort_mode: str, target_count: int = 800):
    collected, seen_vids = [], set()
    def add_items(arr):
        for v in arr:
            vid = v.get("id")
            if vid and len(vid) == 11 and vid not in seen_vids:
                seen_vids.add(vid); v["channel"] = ch_title; v["channel_id"] = uc_id; collected.append(v)
    if playlist_mode == "streams" and base_url: add_items(fetch_yt_json(f"{base_url}/streams", str(target_count), uc_id, ch_title))
    if uc_id and sort_mode in ("views", "likes", "quality_score", "relevance") and playlist_mode != "uu_all":
        add_items(fetch_playlist_browse("VLUULP" + uc_id[2:], ch_title, uc_id, 30, target_count))
    if uc_id and len(collected) < target_count:
        add_items(fetch_playlist_browse("VLUU" + uc_id[2:], ch_title, uc_id, max(35, min(85, (target_count // 25) + 15)), max(target_count, 800)))
    return collected

def _gtrans_req(q_txt: str, tl: str = "iw", sl: str = "auto", clients=("gtx", "dict-chrome-ex"), timeout: int = 14) -> str:
    for cid in clients:
        try:
            r = requests.post(
                "https://translate.googleapis.com/translate_a/single",
                params={"client": cid, "sl": sl, "tl": tl, "dt": "t", "dj": "1"},
                data={"q": q_txt},
                headers={"User-Agent": UA_STR, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
                timeout=timeout,
            )
            if r.status_code == 200:
                tr = "".join(s.get("trans", "") for s in (r.json().get("sentences") or []) if "trans" in s).strip()
                if tr: return tr
        except Exception:
            pass
    return ""

def gtrans_simple(txt: str, target_lang: str) -> str:
    prep = re.sub(r"ברצלונה\s+אתלטיק|בארסה\s+אתלטיק", "Barça Atlètic", str(txt or ""))
    prep = re.sub(r"לה\s*מאסיה|לה\s*מסיה", "La Masia", prep)
    prep = re.sub(r"האנזי\s*פליק|האנסי\s*פליק", "Hansi Flick", prep)
    prep = re.sub(r"\bדקו\b", "Deco", prep)
    return _gtrans_req(prep, tl=("iw" if target_lang == "he" else target_lang), sl="auto", clients=("gtx",), timeout=10)

clean_q = re.sub(r"[!?\u05be]+", " ", query).strip()
CTYPE_HINTS = {"highlights": {"en": "highlights", "es": "resumen", "he": "תקציר"}, "doc": {"en": "documentary analysis", "es": "documental historia", "he": "דוקומנטרי ניתוח"}, "full": {"en": "full match", "es": "partido completo", "he": "משחק מלא"}, "podcast": {"en": "podcast interview", "es": "entrevista podcast", "he": "פודקאסט ראיון"}, "training": {"en": "training inside", "es": "entrenamiento", "he": "אימון"}}
LANG_NAMES = {"he": "Hebrew", "en": "English", "es": "Spanish", "fr": "French", "it": "Italian", "de": "German", "pt": "Portuguese", "ar": "Arabic"}
STOP_W = {"the","and","for","with","from","this","that","are","was","you","your","not","but","all","can","how","who","why","what","עם","של","על","את","אל","כל","הוא","היא","גם","לא","או","מה","איך"}

expanded_queries, suggested_searches, query_meta_map, ai_refinement_tips = [], [], {}, []
ai_strategy_he = planner_model_used = ""
if clean_q:
    expanded_queries.append(clean_q)
    query_meta_map[clean_q.lower()] = {"angle": "original", "note_he": "השאילתה המקורית שלך"}
    if ai_router.has_any_provider() and not is_similar:
        lang_desc = ", ".join(LANG_NAMES.get(l, l) for l in search_langs[:5])
        _en_hint = gtrans_simple(clean_q, "en") if any("\u0590" <= ch <= "\u05FF" for ch in clean_q) else ""
        _en_hint_line = f"Literal English translation hint: \"{_en_hint}\" (interpret sports/domain terms properly — e.g. 'הצלות' in football = goalkeeper saves / penalty saves, 'בישולים' = assists, 'שערים' = goals, 'נס זלגיריס' = Maccabi Tel Aviv vs Zalgiris 2004 miracle).\n" if _en_hint else ""
        exp_prompt = (
            f"Current date: {datetime.date.today().strftime('%B %Y')}.\n"
            f"User input (short keyword OR free-form natural-language request): \"{clean_q}\"\n"
            + _en_hint_line
            + f"Target Languages: {lang_desc} | Content preference: {content_type}.\n"
            "You are an elite YouTube Research & Discovery Strategist. Turn the user's exact intent into razor-sharp, high-signal YouTube search queries across ANY domain (sports, tech, history, lectures, documentaries, etc.).\n"
            "STRICT ANCHORING RULE: Identify ALL core entities AND action/aspect words in the user's input (e.g. 'הצלות'=saves/goalkeeper, 'שערים'=goals, 'פנדלים'=penalties, 'ראיון'=interview) and keep EVERY query tightly anchored to their intersection! NEVER assume a Hebrew word is a typo, NEVER invent an unrelated role (like 'coach/מאמן' for a goalkeeper), and ensure at least 8 of the 13 queries explicitly target the specific action/aspect requested (in Hebrew, English, and Spanish).\n"
            "NATIVE TERMINOLOGY & DISAMBIGUATION RULE: Always include official local/native terms in the target languages AND strictly disambiguate similar names (e.g. reserve/youth teams vs rival clubs with similar names, homonyms, or distinct public figures).\n"
            "ANTI-HALLUCINATION RULE (CRITICAL FOR HEBREW QUERIES): NEVER invent, guess, or substitute an unrelated athlete/person name based on phonetic similarity (for example, Hebrew sports phrases/events like 'נס זלגיריס' refer to the historic Maccabi Tel Aviv vs Zalgiris game, NOT a player name!). When the user input is in Hebrew, keep at least 4 queries in natural Hebrew preserving the exact Hebrew phrase, and translate to English/Spanish ONLY entities you are 100% certain of.\n"
            "Task 1 - Strategy Explanation (Hebrew): Write 'strategy_he' (2-3 crisp sentences in Hebrew) explaining how you combined ALL parts of the user's request, which specific entities/angles you chose, and why.\n"
            "Task 2 - Search Queries: Generate 13 realistic YouTube search queries (2 to 6 words each — real creator title phrasing!) across the target languages, split into 4 buckets:\n"
            "  - angle='direct' (4 queries): direct analytical breakdowns, interviews, reports, and stories combining the user's exact concepts (include native-language phrasing where relevant).\n"
            "  - angle='entities' (4 queries): SPECIFIC real named people, sub-topics, creators, or key figures directly relevant to THIS exact user input (use actual proper names, not vague filler words).\n"
            "  - angle='community' (3 queries): dedicated community channels, podcasts, and discussion shows in the target languages that specifically discuss THIS exact topic.\n"
            "  - angle='deep' (2 queries): full-length sessions, matches, lectures, documentaries, or deep-dives tightly on THIS exact topic (NEVER gaming/FIFA/PES unless explicitly requested).\n"
            "Each query item MUST be an object: {\"q\": \"...\", \"angle\": \"direct|entities|community|deep\", \"note_he\": \"3-6 Hebrew words explaining what this query hunts for\"}.\n"
            "Task 3 - Clickable YouTube Follow-Up Suggestions (Hebrew): Generate 14 SHORT, punchy YouTube search terms in Hebrew (STRICTLY 2 to 5 words each, NO questions or question marks).\n"
            "Task 4 - Refinement Tips (Hebrew): Generate 2-3 short tips ('refinement_tips_he') referencing the extension's own filters (כגון 'עונה / שנים', 'סוג תוכן', 'מיון לפי תאריך' או 'מילות שלילה') — never tell the user to use YouTube's website filters.\n"
            "Return ONLY JSON: {\"strategy_he\": \"...\", \"queries\": [{\"q\": \"...\", \"angle\": \"...\", \"note_he\": \"...\"}], \"suggestions_he\": [...], \"refinement_tips_he\": [...]}"
        )
        g_exp, planner_model_used = ai_router.call_json(exp_prompt, timeout_sec=24, stage="planner")
        if not isinstance(g_exp, dict):
            compact_exp = (
                f"User YouTube search: \"{clean_q}\" | Languages: {lang_desc}.\n"
                "Disambiguate similar names/entities carefully so unrelated teams, people, or topics are excluded.\n"
                "Generate 10 focused YouTube search queries across the languages (each as {\"q\":\"...\",\"angle\":\"direct|entities|community|deep\",\"note_he\":\"...\"}) + short Hebrew strategy_he + 8 short Hebrew suggestions_he.\n"
                "Return ONLY valid JSON: {\"strategy_he\":\"...\",\"queries\":[...],\"suggestions_he\":[...]}"
            )
            g_exp, planner_model_used = ai_router.call_json(compact_exp, timeout_sec=20, stage="planner_retry")
        if isinstance(g_exp, dict):
            ai_strategy_he = str(g_exp.get("strategy_he") or "").strip()
            if isinstance(g_exp.get("refinement_tips_he"), list):
                ai_refinement_tips = [str(x).strip() for x in g_exp["refinement_tips_he"] if str(x).strip()][:4]
            if expand_queries and isinstance(g_exp.get("queries"), list):
                for q_c in g_exp["queries"]:
                    qs, ang, nh = (str(q_c.get("q") or "").strip(), str(q_c.get("angle") or "direct").strip().lower(), str(q_c.get("note_he") or "").strip()) if isinstance(q_c, dict) else (str(q_c or "").strip(), "direct", "")
                    if qs and qs.lower() not in [x.lower() for x in expanded_queries]:
                        expanded_queries.append(qs)
                        query_meta_map[qs.lower()] = {"angle": ang, "note_he": nh}
            if isinstance(g_exp.get("suggestions_he"), list):
                suggested_searches = [str(x).strip() for x in g_exp["suggestions_he"] if str(x).strip()][:16]
    if len(expanded_queries) < 3:
        def _tr_lg(lg):
            if lg == "he" and any("\u0590" <= ch <= "\u05FF" for ch in clean_q): return ""
            tr = re.sub(r"\bBar[cç]a\s+Athletic\b|\bBarcelona\s+Athletic\b", "Barça Atlètic", gtrans_simple(clean_q, lg), flags=re.I)
            hint = (CTYPE_HINTS.get(content_type) or {}).get(lg, "")
            return f"{tr} {hint}".strip() if tr else ""
        with ThreadPoolExecutor(max_workers=5) as ex:
            for rq in ex.map(_tr_lg, search_langs[:5]):
                if rq and rq.lower() not in [x.lower() for x in expanded_queries]:
                    expanded_queries.append(rq)
                    query_meta_map[rq.lower()] = {"angle": "direct", "note_he": "תרגום שאילתה"}

expanded_queries = expanded_queries[:14]
en_query = expanded_queries[1] if len(expanded_queries) > 1 else ""
sp_code = {"views": "CAMSAhAB", "date_desc": "CAI%3D", "likes": "CAE%3D"}.get(sort_by, "CAMSAhAB")

raw, query_hits_map = [], {}
if seed_video and not is_similar: raw.append(seed_video)
if related_videos: raw.extend(related_videos)
resolved_ch, target_uc_id = channel_input, ""
date_op = f" {season_info[2]}" if season_info else ""

NETWORK_CLUSTERS = {
    "@one-1004": ["@one-1004", "@one4576", "@one5353", "@onepodcasts3641"],
    "@one4576": ["@one4576", "@one-1004", "@one5353"],
    "@one5353": ["@one5353", "@one-1004", "@one4576"],
    "@hapodium_podcast": ["@hapodium_podcast", "@hapodium_sport"],
    "@hapodium_sport": ["@hapodium_sport", "@hapodium_podcast"],
}

def fetch_channel_playlists_videos(uc_id_str: str, ch_title_str: str):
    if not uc_id_str: return []
    pl_ids = []
    try:
        r = _yt_post("browse", {"browseId": uc_id_str, "params": "EglwbGF5bGlzdHPyBgQKAkIA"}, hl="he", gl="IL", timeout=15)
        if r.status_code == 200:
            pl_ids = list(dict.fromkeys(m.group(1) for m in re.finditer(r'"playlistId"\s*:\s*"(PL[a-zA-Z0-9_-]{16,})"', r.text)))
    except Exception: pass
    out_pl = []
    if pl_ids:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for b in ex.map(lambda pid: fetch_playlist_browse("VL" + pid, ch_title_str, uc_id_str, 20, 400), pl_ids[:25]):
                out_pl.extend(b)
    return out_pl

if channel_input:
    ch_base, uc_id, resolved_ch = resolve_channel(channel_input)
    target_uc_id = uc_id
    if uc_id: allowed_uc_ids.add(uc_id)
    if resolved_ch: allowed_ch_names.add(resolved_ch.strip().lower())
    ch_key = channel_input.strip().lower()
    for net_k, net_list in NETWORK_CLUSTERS.items():
        if net_k in ch_key:
            for sib_h in net_list:
                if sib_h.lower() != ch_key:
                    try:
                        s_base, s_uc, s_name = resolve_channel(sib_h)
                        if s_uc: allowed_uc_ids.add(s_uc)
                        if s_name: allowed_ch_names.add(s_name.strip().lower())
                        if season_info and s_uc: raw.extend(fetch_channel_vids(s_base, s_uc, s_name or resolved_ch, sort_by, 350))
                    except Exception: pass
            break
    if season_info or clean_q:
        def build_date_slices(s_min_s: str, s_max_s: str):
            try:
                cur, de, sls = datetime.datetime.strptime(s_min_s, "%Y%m%d"), datetime.datetime.strptime(s_max_s, "%Y%m%d"), []
                while cur < de:
                    nxt = min(de, cur + datetime.timedelta(days=45))
                    sls.append(f"after:{(cur - datetime.timedelta(days=1)).strftime('%Y-%m-%d')} before:{(nxt + datetime.timedelta(days=1)).strftime('%Y-%m-%d')}")
                    cur = nxt + datetime.timedelta(days=1)
                return sls
            except Exception:
                return [date_op.strip()] if date_op.strip() else []
        s_qs = []
        if clean_q:
            for eq in expanded_queries[:4]:
                s_qs += [(eq, f'"{resolved_ch}" {eq}{date_op}', ""), (eq, f'"{resolved_ch}" {eq}{date_op}', sp_code)]
        elif season_info:
            for sl_op in build_date_slices(season_info[0], season_info[1]):
                s_qs += [(resolved_ch, f'"{resolved_ch}" {sl_op}', ""), (resolved_ch, f'"{resolved_ch}" תקציר {sl_op}', "")]
        with ThreadPoolExecutor(max_workers=10) as ex:
            for base_eq, b in ex.map(lambda p: (p[0], fetch_search(p[1], p[2], 220, uc_id, resolved_ch)), s_qs):
                s_set = query_hits_map.setdefault(base_eq, set())
                for it_b in b:
                    it_b["matched_date_op"] = True
                    if base_eq: it_b["source_q"] = base_eq
                    if it_b.get("id"): s_set.add(it_b["id"])
                raw.extend(b)
    q_words = [w.lower() for eq in expanded_queries for w in eq.split() if len(w) >= 3 and w.lower() not in STOP_W] if clean_q else []
    if season_info and uc_id:
        pl_vids = fetch_channel_playlists_videos(uc_id, resolved_ch)
        raw.extend([v for v in pl_vids if not q_words or any(w in str(v.get("title") or "").lower() for w in q_words)])
    ch_all = fetch_channel_vids(ch_base, uc_id, resolved_ch, sort_by, max(max_results + 120, 500))
    raw.extend([v for v in ch_all if not q_words or any(w in str(v.get("title") or "").lower() for w in q_words)])
else:
    jobs = [(eq, f"{eq}{date_op}".strip(), sp) for idx_q, eq in enumerate(expanded_queries) for sp in (("", sp_code) if idx_q < 5 else ("",))]
    per_q_cap = max(55, min(120, (max_results * 2) // max(1, len(expanded_queries)) + 30))
    buckets_by_q = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        results_per_job = list(ex.map(lambda j: (j[0], fetch_search(j[1], j[2], per_q_cap)), jobs))
    for base_eq, b in results_per_job:
        s_set = query_hits_map.setdefault(base_eq, set())
        q_list = buckets_by_q.setdefault(base_eq, [])
        for it_b in b:
            vid_b = it_b.get("id")
            if vid_b and vid_b not in s_set:
                s_set.add(vid_b); it_b["source_q"] = base_eq; q_list.append(it_b)
    q_order = [eq for eq in expanded_queries if eq in buckets_by_q]
    for r_i in range(max((len(buckets_by_q[eq]) for eq in q_order), default=0)):
        for eq in q_order:
            if r_i < len(buckets_by_q[eq]):
                raw.append(buckets_by_q[eq][r_i])

for il_vid in il_seed_ids:
    raw.append({"id": il_vid, "title": il_vid, "channel": "", "channel_id": "", "view_count": 0, "duration": 0, "matched_date_op": True, "is_il_stub": True})

seen_ids = {direct_vid} if (is_similar and direct_vid) else (set() if (channel_input or direct_vid) else set(exclude))
cands = []
for idx_pos, e in enumerate(raw):
    vid, title = e.get("id"), (e.get("title") or "").strip()
    if not vid or vid in seen_ids or len(vid) != 11 or not title: continue
    e_cid, e_ch = str(e.get("channel_id") or "").strip(), str(e.get("channel") or e.get("uploader") or "").strip()
    if target_uc_id and e_cid and e_cid != target_uc_id and e_cid not in allowed_uc_ids: continue
    if channel_input and resolved_ch and not e_cid and e_ch and e_ch.strip().lower() != resolved_ch.strip().lower(): continue
    seen_ids.add(vid)
    cands.append({
        "id": vid, "title": title, "url": f"https://www.youtube.com/watch?v={vid}",
        "channel": resolved_ch if channel_input else (e_ch or resolved_ch), "channel_id": e_cid,
        "views": parse_views_text(e.get("view_count") or 0), "likes": int(e.get("like_count") or 0),
        "upload_date": str(e.get("upload_date") or "").strip().replace("-", ""),
        "published_rel": str(e.get("published_rel") or ""), "max_height": 0, "orig_pos": idx_pos,
        "source_q": str(e.get("source_q") or ""), "is_il_stub": bool(e.get("is_il_stub")),
        "matched_date_op": bool(e.get("matched_date_op")), "duration": int(e.get("duration") or 0),
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
    })

GAMING_RX = re.compile(r"\b(fifa\s*\d*|ea\s*fc\s*\d*|fc\s*2[4567]|efootball|pes\s*\d*|fc\s*mobile|dream\s*league|dls\s*\d*|football\s*manager|fm2[3456]|career\s*mode|pack\s*opening|fut\s*draft|sbc|ultimate\s*team|new\s*showtime|pesmaster|eafc|gameplay)\b", re.I)
def _filter_noise(items):
    if no_gaming: items = [c for c in items if not GAMING_RX.search(f"{c['title']} {c['channel']}")]
    if exclude_terms: items = [c for c in items if not any(w in f"{c['title']} {c['channel']}".lower() for w in exclude_terms)]
    return items

cands = _filter_noise(cands)
cap_pool = max(max_results + 200, 480)
if sort_by in ("views", "likes", "quality_score"):
    cands.sort(key=lambda x: (x["views"], -x["orig_pos"]), reverse=True)
selected_pool = cands[:cap_pool]

thread_local = threading.local()
def get_sess():
    if not hasattr(thread_local, "s"):
        s = requests.Session(); s.headers.update(YT_HDRS); thread_local.s = s
    return thread_local.s

MONTHS = {"jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06", "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12"}
def parse_dt(d_str: str) -> str:
    s = str(d_str or "").strip()
    m1 = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m1: return f"{m1.group(1)}{m1.group(2)}{m1.group(3)}"
    m2 = re.search(r"([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})", s)
    return f"{m2.group(3)}{MONTHS.get(m2.group(1).lower(), '01')}{m2.group(2).zfill(2)}" if m2 else ""

def enrich(c):
    sess, vid = get_sess(), c["id"]
    try:
        rn = _yt_post("next", {"videoId": vid}, sess=sess, timeout=10)
        if rn.status_code == 200:
            rt = rn.text
            try:
                res_contents = ((((rn.json().get("contents") or {}).get("twoColumnWatchNextResults") or {}).get("results") or {}).get("results") or {}).get("contents") or []
                for rc in res_contents:
                    if not isinstance(rc, dict): continue
                    p_info = rc.get("videoPrimaryInfoRenderer")
                    if isinstance(p_info, dict):
                        if not c.get("title") or c.get("title") == vid:
                            tv = "".join(str(x.get("text") or "") for x in ((p_info.get("title") or {}).get("runs") or [])).strip() or str((p_info.get("title") or {}).get("simpleText") or "").strip()
                            if tv: c["title"] = tv
                        if not c.get("upload_date"):
                            raw_dt = str((p_info.get("dateText") or {}).get("simpleText") or "").replace("Premiered ", "").replace("Streamed live on ", "").strip()
                            if raw_dt:
                                pdt = parse_dt(raw_dt)
                                if pdt: c["upload_date"] = pdt
                                else: c["published_rel"] = raw_dt
                        vc_s = str((((p_info.get("viewCount") or {}).get("videoViewCountRenderer") or {}).get("viewCount") or {}).get("simpleText") or "")
                        if vc_s: c["views"] = max(int(c.get("views") or 0), parse_views_text(vc_s))
                        if c["likes"] == 0:
                            va_s = json.dumps(p_info.get("videoActions") or {}, ensure_ascii=False)
                            ml = re.search(r'"likeCount"\s*:\s*"?(\d+)"?', va_s) or re.search(r'along with ([\d,]+)\s+other', va_s, re.I)
                            if ml: c["likes"] = int(ml.group(1).replace(",", ""))
                            else:
                                mtl = re.search(r'"likeButtonViewModel"[\s\S]{0,1600}?"buttonViewModel"\s*:\s*\{[^}]*?"title"\s*:\s*"([^"]+)"', va_s)
                                if mtl and re.search(r"\d", mtl.group(1)): c["likes"] = parse_views_text(mtl.group(1))
                    s_info = rc.get("videoSecondaryInfoRenderer")
                    if isinstance(s_info, dict) and not c.get("channel_id"):
                        bid = str(((((s_info.get("owner") or {}).get("videoOwnerRenderer") or {}).get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "")
                        if bid.startswith("UC"): c["channel_id"] = bid
            except Exception: pass
            if not c.get("channel_id"):
                mc = re.search(r'"videoOwnerRenderer"\s*:\s*\{.*?"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"', rt)
                if mc: c["channel_id"] = mc.group(1)
            if not c.get("title") or c.get("title") == vid:
                mt = re.search(r'"videoPrimaryInfoRenderer"\s*:\s*\{\s*"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"', rt)
                if mt:
                    try: c["title"] = json.loads(f'"{mt.group(1)}"')
                    except Exception: c["title"] = mt.group(1)
            if c["likes"] == 0:
                for pat_l in (r'"likeCountIfIndifferentNumber"\s*:\s*(\d+)', r'"likeCount"\s*:\s*"?(\d+)"?', r'along with ([\d,]+)\s+other'):
                    ml = re.search(pat_l, rt, re.I)
                    if ml: c["likes"] = int(ml.group(1).replace(",", "")); break
                if c["likes"] == 0:
                    ml2 = re.search(r'"expandedLikeCountIfIndifferent"\s*:\s*\{\s*"content"\s*:\s*"([^"]+)"', rt)
                    if ml2 and re.search(r"\d", ml2.group(1)): c["likes"] = parse_views_text(ml2.group(1))
    except Exception: pass
    if not c.get("upload_date") or not c.get("duration") or not c.get("channel_id") or ((high_quality_only or sort_by == "quality_score") and not c.get("max_height")):
        try:
            r = _yt_post("player", {"videoId": vid}, sess=sess, timeout=10)
            if r.status_code == 200:
                pd = r.json(); vd = pd.get("videoDetails") or {}; mf = (pd.get("microformat") or {}).get("playerMicroformatRenderer") or {}
                if vd.get("channelId"): c["channel_id"] = str(vd["channelId"]).strip()
                if vd.get("viewCount"): c["views"] = max(int(c.get("views") or 0), int(vd["viewCount"]))
                if vd.get("lengthSeconds") and not c["duration"]: c["duration"] = int(vd["lengthSeconds"])
                if vd.get("author"): c["channel"] = str(vd["author"]).strip()
                if vd.get("title"): c["title"] = str(vd["title"]).strip()
                dt = parse_dt(mf.get("publishDate") or mf.get("uploadDate") or "")
                if dt: c["upload_date"] = dt
                fmts = (pd.get("streamingData") or {}).get("adaptiveFormats") or []
                if fmts: c["max_height"] = max((int(f.get("height") or 0) for f in fmts), default=0)
        except Exception: pass

if selected_pool:
    enrich_cap = 600 if (channel_input or season_info or min_views > 0) else min(len(selected_pool), 300)
    to_enrich = list(selected_pool[:enrich_cap]) + [c for c in selected_pool[enrich_cap:] if c.get("is_il_stub")][:40]
    with ThreadPoolExecutor(max_workers=32) as ex: list(ex.map(enrich, to_enrich))
    selected_pool = _filter_noise([c for c in selected_pool if not (c.get("is_il_stub") and str(c.get("title") or "").strip() == str(c.get("id") or "").strip())])

if allowed_uc_ids:
    selected_pool = [c for c in selected_pool if c.get("channel_id") in allowed_uc_ids or str(c.get("channel") or "").strip().lower() in allowed_ch_names]
elif channel_input and resolved_ch:
    selected_pool = [c for c in selected_pool if str(c.get("channel") or "").strip().lower() == resolved_ch.strip().lower()]
if season_info:
    s_min, s_max, _ = season_info
    selected_pool = [c for c in selected_pool if (s_min <= str(c.get("upload_date") or "") <= s_max) or (not c.get("upload_date") and c.get("matched_date_op"))]

def match_dur(c):
    d, tl = int(c.get("duration") or 0), str(c.get("title") or "").lower()
    if high_quality_only and ("#shorts" in tl or 0 < d < 65): return False
    if dur_filter == "no_shorts": return d == 0 or d >= 61
    if dur_filter == "clips": return d == 0 or 60 <= d <= 1200
    if dur_filter == "long": return d >= 1200
    if dur_filter == "short5": return 0 < d <= 300
    return True

selected_pool = [c for c in selected_pool if match_dur(c)]
if high_quality_only: selected_pool = [c for c in selected_pool if c.get("max_height", 0) >= 1080 or c.get("max_height", 0) == 0]
if min_views > 0: selected_pool = [c for c in selected_pool if int(c.get("views") or 0) >= min_views]

ai_status, used_models, ai_sent_by_q = "", [], {}
if filter_prompt:
    if not ai_router.has_any_provider():
        ai_status = "⚠️ סינון AI כבוי (חסר מפתח AI ב-Secrets)"
    elif selected_pool:
        ai_slice = selected_pool[:min(len(selected_pool), max(max_results * 2, 165))]
        for it_s in ai_slice:
            sq_s = it_s.get("source_q") or ""
            if sq_s: ai_sent_by_q[sq_s] = ai_sent_by_q.get(sq_s, 0) + 1
        # Iron Rule: Scorer batches capped at 55 items (prevents Groq Request too large)
        chunk_sz = 55
        chunks_ai = [(off, ai_slice[off:off + chunk_sz]) for off in range(0, len(ai_slice), chunk_sz)]

        def _score_ai_chunk(pair, attempt_tag=""):
            offset, sub_items = pair
            compact = [[offset + i, str(it.get("title") or "")[:95], str(it.get("channel") or "")[:36], int(it.get("views") or 0)] for i, it in enumerate(sub_items)]
            ai_prompt = (
                f"Query=\"{query or 'N/A'}\" | Channel=\"{resolved_ch or 'Any'}\" | Type={content_type}\n"
                + (f"Strategy: {ai_strategy_he}\n" if ai_strategy_he else "")
                + f"User Modesty/Focus Rule: {filter_prompt}\n"
                + "IMPORTANT MULTI-CONCEPT SCORING RUBRIC (DO NOT require EVERY query word to appear in the same title!):\n"
                + "  * Score 9-10 (Top ~12%): Directly combines ALL core parts of the user's query.\n"
                + "  * Score 7-8 (Strong): Strongly covers most core concepts or the primary entity/angle of the query.\n"
                + "  * Score 5-6 (Related Gems): Quality video tightly relevant to ONE core angle of this theme (specific key figure, interview, podcast, or deep breakdown).\n"
                + "  * DROP (<5): Confused/similar-named wrong entity, gaming/FIFA/EA FC (unless asked), unrelated topics/celebrities, clickbait spam, or filter-rule violations.\n"
                + "Note: 'ללא דמויות אחרות' means no unrelated people/topics — directly relevant figures within the requested subject are WELCOME!\n"
                + "CRITICAL RECALL TARGET: Aim to keep ~14 to 28 valid items from this 55-item batch! If fewer than 12 items qualify for scores 7-10, actively include strong Tier 3 (score 5-6) related interviews, podcasts, breakdowns, or deep-dive videos so good videos are not over-pruned. Write a crisp Hebrew reason (3-6 words) per kept video.\n"
                + "Return ONLY compact JSON: {\"k\": [[id, score, \"סיבה קצרה בעברית\"]]}\n"
                + f"Items: {json.dumps(compact, ensure_ascii=False)}"
            )
            return ai_router.call_json(ai_prompt, timeout_sec=24, stage=f"scorer_{offset // chunk_sz + 1}{attempt_tag}")

        score_map, reason_map, failed_chunks = {}, {}, []
        def _ingest_ai_resp(g_data, m_used):
            if m_used and m_used not in used_models: used_models.append(m_used)
            rows = g_data if isinstance(g_data, list) else None
            if rows is None and isinstance(g_data, dict):
                for rk in ("k", "keep", "items", "results", "scores", "data"):
                    if isinstance(g_data.get(rk), list):
                        rows = g_data[rk]
                        break
            if rows is None: return False
            for r in rows:
                idx_r, sc_r, rs_r = None, 7, ""
                try:
                    if isinstance(r, list) and len(r) >= 2 and str(r[0]).strip().isdigit():
                        idx_r, sc_r, rs_r = int(str(r[0]).strip()), int(float(r[1] or 7)), (str(r[2] or "").strip() if len(r) >= 3 else "")
                    elif isinstance(r, dict):
                        raw_i = next((r[k] for k in ("i", "id", "idx") if r.get(k) is not None), "")
                        if str(raw_i).strip().isdigit():
                            raw_s = next((r[k] for k in ("s", "score") if r.get(k) is not None), 7)
                            raw_r = next((r[k] for k in ("r", "reason", "why") if r.get(k) is not None), "")
                            idx_r, sc_r, rs_r = int(str(raw_i).strip()), int(float(raw_s)), str(raw_r).strip()
                except Exception:
                    idx_r = None
                if idx_r is not None and sc_r >= 4:
                    score_map[idx_r] = min(10, max(4, sc_r))
                    if rs_r: reason_map[idx_r] = rs_r[:90]
            return True

        if len(chunks_ai) > 1 and (len(ai_router.gemini_keys) >= 2 or ai_router.groq_key or ai_router.cerebras_key or ai_router.openrouter_key):
            scorer_workers = min(len(chunks_ai), max(2, len(ai_router.gemini_keys) * 2 + int(bool(ai_router.groq_key)) + int(bool(ai_router.cerebras_key))), 5)
            with ThreadPoolExecutor(max_workers=scorer_workers) as ex:
                for pair_c, (gd, mu) in zip(chunks_ai, ex.map(_score_ai_chunk, chunks_ai)):
                    if not _ingest_ai_resp(gd, mu): failed_chunks.append(pair_c)
        else:
            for ci, pair_c in enumerate(chunks_ai):
                if ci > 0: time.sleep(0.6)
                if not _ingest_ai_resp(*_score_ai_chunk(pair_c)): failed_chunks.append(pair_c)
        if failed_chunks:
            time.sleep(2.5)
            for pair_c in failed_chunks: _ingest_ai_resp(*_score_ai_chunk(pair_c, "_retry"))

        if score_map:
            filtered = []
            for idx, it in enumerate(ai_slice):
                if idx in score_map:
                    it["ai_score"] = score_map[idx]
                    if idx in reason_map: it["ai_reason"] = reason_map[idx]
                    filtered.append(it)
            m_lbl = used_models[0] if used_models else "ai"
            if filtered:
                selected_pool = filtered
                ai_status = f"🤖 {m_lbl} ({len(filtered)}/{len(ai_slice)})"
            else:
                ai_status = f"🤖 {m_lbl} (מוצגות כל התוצאות)"
        else:
            ai_status = "⚠️ שרתי ה-AI בעומס זמני (מוצגות תוצאות ללא סינון AI)"

SORT_KEYS = {
    "relevance": (lambda x: (int(x.get("ai_score") or 0) * 1.8 + math.log10(max(0, int(x.get("views") or 0)) + 1), int(x.get("views") or 0)), True),
    "likes": (lambda x: (int(x.get("likes") or 0), int(x.get("views") or 0)), True),
    "quality_score": (lambda x: (int(x.get("max_height") or 0) >= 1080, int(x.get("likes") or 0) * 25 + int(x.get("views") or 0)), True),
    "date_desc": (lambda x: (str(x.get("upload_date") or "00000000"), -int(x.get("orig_pos") or 0)), True),
    "date_asc": (lambda x: (str(x.get("upload_date") or "99999999"), int(x.get("orig_pos") or 0)), False),
}
sk_fn, sk_rev = SORT_KEYS.get(sort_by, (lambda x: (int(x.get("views") or 0), int(x.get("likes") or 0)), True))
selected_pool.sort(key=sk_fn, reverse=sk_rev)
pool = selected_pool[:max_results]

ai_passed_by_q = {}
for it_k in selected_pool:
    sq_k = it_k.get("source_q") or ""
    if sq_k: ai_passed_by_q[sq_k] = ai_passed_by_q.get(sq_k, 0) + 1
query_stats = []
for eq in expanded_queries:
    qm = query_meta_map.get(eq.lower()) or {}
    sn, pn = ai_sent_by_q.get(eq, 0), ai_passed_by_q.get(eq, 0)
    query_stats.append({
        "q": eq, "angle": qm.get("angle", "direct"),
        "note_he": (qm.get("note_he", "") + (f" (✓ {pn}/{sn} עברו AI)" if sn > 0 else "")).strip(),
        "hits": len(query_hits_map.get(eq, set())), "sent_to_ai": sn, "passed_ai": pn,
    })

def strip_noise(t: str) -> str:
    s = re.sub("[\u2066-\u2069\u200e\u200f]", "", str(t or ""))
    s = re.sub(r"^\s*\[(?:ESP|ENG|CAT|FR|ITA|DE|PT|AR|HD|4K)\]\s*", "", s, flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"#[a-zA-Z0-9_\u0590-\u05FF]+", "", s)).strip()

HE_POST = [
    ('\\bEXTENDED HIGHLIGHTS\\b', "תקציר מורחב"),
    ('\\b(?:HIGHLIGHTS|HHIHLIGHTS|RESUMEN)\\b', "תקציר"),
    ('\\b(?:FULL MATCH|PARTIDO COMPLETO|PARTIDO ENTERO)\\b', "משחק מלא"),
    ('\\bFIRST TEAM\\b', "הקבוצה הבוגרת"),
    ('\\bBEST OF\\b', "מיטב הרגעים של"),
    ('\\bSKILLS\\s*&\\s*GOALS\\b', "מהלכים ושערים"),
    ('\\bSKILLS\\b', "מהלכים"),
    ('\\b(?:GOALS|GOLES)\\b', "שערים"),
    ('\\bFINAL\\b', "גמר"),
    ('\\bVS\\.?\\b', "נגד"),
    ('\\bLIVESTREAM\\b', "שידור חי"),
    ('\\bINTERVIEW\\b', "ראיון"),
    ('\\b(?:TRAINING|ENTRENAMIENTO)\\b', "אימון"),
    ('\\bACADEMY\\b', "אקדמיה"),
    ('\\bTorneo\\b', "טורניר"),
    ('\\bAlev[ií]n\\b', "ילדים"),
    ('\\bInfantil\\b', "נערים"),
    ('\\bCopa Del Rey Juvenil\\b', "גביע המלך לנוער"),
    ('\\bJuvenil\\b', "נוער"),
    ('\\bCadete\\b', "קדטים"),
    ('\\bBenjam[ií]n\\b', "טרום-ילדים"),
    ('\\bBar[cç]a\\s+Atl[eèé]tic\\b|ברצלונה\\s+ATL[EÈÉ]TIC', "ברצלונה אתלטיק"),
    ('\\bFC Barcelona\\b|\\bBar[cç]a\\b|\\bBarcelona\\b', "ברצלונה"),
    ('\\bRM Castilla\\b', "ריאל מדריד קסטייה"),
    ('\\bReal Madrid\\b', "ריאל מדריד"),
    ('\\bAtl[eé]tico de Madrid\\b', "אתלטיקו מדריד"),
    ('\\bValencia\\b', "ולנסיה"),
    ('\\bSevilla\\b', "סביליה"),
    ('\\bReal Betis\\b', "ריאל בטיס"),
    ('\\bGirona\\s*FC\\b|\\bGirona\\b', "ג'ירונה"),
    ('\\bVillarreal\\b', "ויאריאל"),
    ('\\bMalaga\\s*CF\\b|\\bM[aá]laga\\b', "מלאגה"),
    ('\\bAtalanta\\b', "אטאלנטה"),
    ('\\bAl Ahly\\b', "אל-אהלי"),
    ('\\bHuesca\\b', "הואסקה"),
    ('\\bViktoria Plzen\\b', "ויקטוריה פלזן"),
    ('\\bLa\\s*Mas[ií]a\\b|לה מסיה|לה מאסה', "לה מאסיה"),
    ('\\bLALIGA EA SPORTS\\b|\\bLALIGA\\b', "לה ליגה"),
    ('\\bUEFA Youth League\\b', "ליגת האלופות לנוער"),
    ('\\bOrian Goren\\b', "אוריין גורן"),
    ('\\bLamine Yamal\\b|למין ימל|לאמין ימל', "לאמין ימאל"),
    ('\\bPau Cubars[ií]\\b', "פאו קובארסי"),
    ('\\bJoan Garc[ií]a\\b|חואן גרסיה|חואן גארסיה', "ז'ואן גרסיה"),
    ('\\bThiago Messi\\b', "תיאגו מסי"),
    ('\\bLionel Messi\\b|\\bLeo Messi\\b', "ליונל מסי"),
    ('\\bAnsu Fati\\b', "אנסו פאטי"),
    ('\\bGavi\\b', "גאבי"),
    ('\\bMarc Bernal\\b', "מארק ברנאל"),
    ('\\bDani Olmo\\b', "דני אולמו"),
    ('\\bFerm[ií]n\\b', "פרמין"),
    ('\\bEric Garc[ií]a\\b', "אריק גרסיה"),
    ('\\bAndr[eé]s Iniesta\\b', "אנדרס אינייסטה"),
    ('\\bH[eé]ctor Fort\\b', "הקטור פורט"),
    ('\\bCarles Puyol\\b', "קרלס פויול"),
    ('\\bRiqui Puig\\b', "ריקי פוץ'"),
    ('\\bBalde\\b', "באלדה"),
    ('\\bAdam Qaroual\\b', "אדם קרואל"),
    ('\\bHugo Galdeano\\b', "הוגו גלדיאנו"),
    ('\\bXavi\\b', "צ'אבי"),
    ('\\bPiqu[eé]\\b', "פיקה"),
    ('\\bBusquets\\b', "בוסקטס"),
    ('\\bHansi\\s+Flick\\b|פליק של הנסי|פליק הנסי|הנסי פליק|האנסי פליק', "האנזי פליק"),
    ('\\bFlick\\b|ס[֑-ׇ]*ט[֑-ׇ]*י[֑-ׇ]*ר[֑-ׇ]*ה\\s+ק[֑-ׇ]*ל[֑-ׇ]*ה', "פליק"),
    ('\\bDeco\\b', "דקו"),
    ("\\bDeni\\s+Avdija\\b|דני\\s+אבדיג['’]ה", "דני אבדיה"),
    ("\\bAvdija\\b|אבדיג['’]ה", "אבדיה"),
    ('קאן\\s*11', "כאן 11"),
    ('פ[֑-ׇ]*נ[֑-ׇ]*י[֑-ׇ]*נ[֑-ׇ]*ה', "פנינה"),
    ('\\bדגשים\\b|\\bהבהרה\\b|\\bהבהרות\\b|הבולטים של|נקודות השיא', "תקציר"),
    ('עיר האדם|עיר גבר', "מנצ'סטר סיטי"),
]
KEEP_CAPS = {"FC", "UEFA", "FIFA", "NBA", "NFL", "UFC", "HD", "4K", "U19", "U18", "U17", "U16", "U14", "U12", "PSG", "TV", "VIP"}

def polish_he(t: str) -> str:
    s = strip_noise(t)
    for pat, rep in HE_POST: s = re.sub(pat, rep, s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()

def count_foreign_alpha(txt: str) -> int:
    return sum(1 for ch in str(txt or "") if ch.isalpha() and not ("\u0590" <= ch <= "\u05FF"))

def _decap_latin(s: str) -> str:
    return re.sub(r"\b[A-ZÀÈÌÒÙÁÉÍÓÚÑÇÜ]{2,}\b", lambda m: m.group(0) if m.group(0) in KEEP_CAPS else m.group(0).lower(), str(s or ""))

def _protect_terms_latin(s: str) -> str:
    for pat, tok in ((r"\bhansi\s+flick\b", "XHFLICKX"), (r"\bflick\b", "XFLICKX"), (r"\bbar[cç]a\s+atl[eèé]tic\b", "XBATLETICX"), (r"\bman(?:chester)?\s+city\b", "XMANCITYX")):
        s = re.sub(pat, tok, s, flags=re.I)
    return s

def _restore_terms_he(s: str) -> str:
    for tok, rep in (("XHFLICKX", "האנזי פליק"), ("XFLICKX", "פליק"), ("XBATLETICX", "ברצלונה אתלטיק"), ("XMANCITYX", "מנצ'סטר סיטי")):
        s = re.sub(tok, rep, s, flags=re.I)
    return polish_he(s)

def translate_one_pure_he(orig_s: str) -> str:
    prep = _protect_terms_latin(_decap_latin(orig_s))
    best = _restore_terms_he(_gtrans_req(prep, tl="iw", sl="auto") or prep)
    if count_foreign_alpha(best) < 3:
        return best
    guess = []
    if re.search("[\u0600-\u06FF]", prep): guess.append("ar")
    if re.search(r"[áéíóúñ¡¿çèà]|\b(el|la|los|las|del|en|al|tras|rueda|prensa|completa|entrevista|directo|futuro|frente|gana|contra|partido|torneo|final|goles|juvenil|alev[ií]n|infantil|ni[ñn]o)\b", prep, re.I):
        guess.append("es")
    for lg in ("es", "en", "fr"):
        if lg not in guess: guess.append(lg)
    best_sc = count_foreign_alpha(best)
    for sl in guess:
        cand = _restore_terms_he(_gtrans_req(prep, tl="iw", sl=sl) or "")
        if cand and count_foreign_alpha(cand) < best_sc:
            best, best_sc = cand, count_foreign_alpha(cand)
            if best_sc < 3: break
    if best_sc >= 3:
        rebuilt = best
        for m_sp in re.finditer("[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F0-9\\s'’&.-]{2,}", best):
            sp = m_sp.group(0).strip()
            if count_foreign_alpha(sp) < 3: continue
            tr_sp = _gtrans_req(_decap_latin(sp), tl="iw", sl=guess[0]) or _gtrans_req(_decap_latin(sp), tl="iw", sl="en")
            if tr_sp and count_foreign_alpha(tr_sp) < count_foreign_alpha(sp):
                rebuilt = rebuilt.replace(sp, polish_he(tr_sp), 1)
        if count_foreign_alpha(rebuilt) < best_sc: best = polish_he(rebuilt)
    return best

if translate_titles and pool:
    need_tr = []
    for idx, it in enumerate(pool):
        it["orig_title"] = it["title"]
        src = strip_noise(it["title"])
        it["title_he"] = src
        if count_foreign_alpha(src) >= 3: need_tr.append((idx, src))
    if need_tr:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for (i_idx, _), he_res in zip(need_tr, ex.map(lambda p: translate_one_pure_he(p[1]), need_tr)):
                pool[i_idx]["title_he"] = he_res

def fetch_sharp_webp_thumb(item):
    vid = item.get("id", "")
    if not vid: return
    sess = get_sess()
    for u in (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"):
        try:
            r = sess.get(u, timeout=7)
            if r.status_code == 200 and len(r.content) > 1200:
                im = Image.open(io.BytesIO(r.content)).convert("RGB")
                w, h = im.size
                if (w, h) == (480, 360): im = im.crop((0, 45, 480, 315))
                elif (w, h) == (640, 480): im = im.crop((0, 60, 640, 420))
                im = im.resize((320, 180), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, format="WEBP", quality=82, method=4)
                item["thumbnail"] = f"data:image/webp;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
                return
        except Exception:
            pass

if pool:
    with ThreadPoolExecutor(max_workers=24) as ex:
        list(ex.map(fetch_sharp_webp_thumb, pool[:180]))

if not suggested_searches and (clean_q or resolved_ch):
    bt, yr = clean_q or resolved_ch, datetime.date.today().year
    suggested_searches = [f"{bt} {yr}", f"{bt} ניתוח מעמיק", f"{bt} סיכום", f"{bt} ראיון", f"{bt} פודקאסט", f"{bt} מלא", f"{bt} הסבר", f"{bt} דוקומנטרי"]

for item in pool:
    for k in ("orig_pos", "source_q", "is_il_stub", "matched_date_op", "channel_id"): item.pop(k, None)
    rd = str(item.get("upload_date") or "").strip()
    item["date_formatted"] = f"{rd[6:8]}/{rd[4:6]}/{rd[0:4]}" if (len(rd) == 8 and rd.isdigit()) else item.get("published_rel", "")
    mh = int(item.get("max_height") or 0)
    qb = "4K" if mh >= 2160 else ("1440p" if mh >= 1440 else ("1080p HD" if mh >= 1080 else ("720p" if mh >= 720 else (f"{mh}p" if mh > 0 else ""))))
    item["quality_badge"] = qb
    item["channel"] = " • ".join(p for p in [item["channel"], f"🎬 {qb}" if qb else ""] if p)
    if item.get("title_he"): item["title"] = item["title_he"]

ai_trace = {
    "planner_model": planner_model_used or "",
    "scorer_model": used_models[0] if used_models else "",
    "skipped_models": sorted(ai_router.dead_models),
    "gemini_errors": ai_router.errors[:12],
    "ai_infra": ai_router.export_telemetry(),
    "strategy_he": ai_strategy_he,
    "queries": query_stats,
    "refinement_tips_he": ai_refinement_tips,
    "pipeline": {"raw_total": len(raw), "unique_cands": len(cands), "sent_to_ai": sum(ai_sent_by_q.values()), "ai_kept": len(selected_pool), "final_shown": len(pool)},
    "prompts_summary": {"user_filter_rule": filter_prompt, "langs": search_langs, "content_type": content_type, "ranking_formula": "ai_score * 1.8 + log10(views + 1)" if sort_by == "relevance" else sort_by},
}

payload_bytes = json.dumps({
    "query": query, "en_query": en_query, "expanded_queries": expanded_queries,
    "suggested_searches": suggested_searches, "channel": resolved_ch or channel_input,
    "sort_by": sort_by, "ai_status": ai_status, "ai_trace": ai_trace, "items": pool,
}, ensure_ascii=False).encode("utf-8")
Path("recommendations.json").write_bytes(payload_bytes)

gh_repo, gh_token = os.environ["GH_REPO"], os.environ["GH_TOKEN"]
r = requests.post(f"https://api.github.com/repos/{gh_repo}/git/blobs", headers={"Authorization": f"Bearer {gh_token}", "Accept": "application/vnd.github+json"}, json={"content": base64.b64encode(payload_bytes).decode("ascii"), "encoding": "base64"}, timeout=60)
sha = r.json().get("sha", "") if r.status_code == 201 else ""
tag = f"rec-{req_id}"
rel_p = subprocess.run(["gh", "release", "create", tag, "recommendations.json", "--repo", gh_repo, "--title", tag, "--notes", json.dumps({"blobs": [sha] if sha else [], "count": len(pool)})], capture_output=True, text=True, check=False)
if rel_p.returncode != 0:
    raise SystemExit(f"::error::gh release create failed: {rel_p.stderr[:250]}")
