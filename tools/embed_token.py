import base64, json, pathlib, secrets

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "extension" / "config.js"

def obfuscate_token(token: str, n: int = 5):
    key = secrets.token_hex(11)
    xored = bytes(b ^ ord(key[i % len(key)]) for i, b in enumerate(token.encode("utf-8")))
    b64 = base64.b64encode(xored).decode("ascii")
    return [b64[i::n] for i in range(n)], key

def main():
    owner = input("GitHub Owner (default: ZVGFFTFGGGG): ").strip() or "ZVGFFTFGGGG"
    repo = input("GitHub Repo (default: SFDF): ").strip() or "SFDF"
    token = input("GitHub Token (github_pat_...): ").strip()
    cookie_key = input("COOKIE_KEY (leave blank to generate): ").strip()
    if not cookie_key:
        cookie_key = secrets.token_hex(32)
        print(f"\nGenerated COOKIE_KEY (add to GitHub Secrets):\n{cookie_key}\n")
    update_owner = input("Update Owner (optional): ").strip()
    update_repo = input("Update Repo (optional): ").strip()
    chunks, key = obfuscate_token(token) if token else ([], "")
    code = f""""use strict";
const _TK_CHUNKS = {json.dumps(chunks)};
const _TK_KEY = {json.dumps(key)};
function _assembleToken(chunks, key) {{
  if (!chunks.length || !key) return "";
  const n = chunks.length;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Array(total);
  for (let i = 0; i < n; i++) for (let j = 0; j < chunks[i].length; j++) out[i + j * n] = chunks[i][j];
  const bin = atob(out.join(""));
  let res = "";
  for (let i = 0; i < bin.length; i++) res += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return res;
}}
self.DEFAULT_CONFIG = {{
  owner: {json.dumps(owner)},
  repo: {json.dumps(repo)},
  workflow: "download.yml",
  ref: "main",
  get token() {{ return _assembleToken(_TK_CHUNKS, _TK_KEY); }},
  cookieKey: {json.dumps(cookie_key)},
  updateOwner: {json.dumps(update_owner)},
  updateRepo: {json.dumps(update_repo)}
}};
"""
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(code, encoding="utf-8")
    print(f"Saved: {CFG_PATH}")

if __name__ == "__main__":
    main()