"use strict";
(() => {
  const el = (id) => document.getElementById(id);
  const FIELDS = ["owner", "repo", "workflow", "ref", "token", "cookieKey", "updateOwner", "updateRepo"];
  async function load() {
    const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!cfg) return;
    for (const f of FIELDS) el(f).value = cfg[f] || "";
  }
  el("genKeyBtn").onclick = () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    el("cookieKey").value = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    el("msg").textContent = "נוצר מפתח COOKIE_KEY חדש! העתק אותו גם ל-GitHub Secrets במאגר שלך.";
  };
  el("save").onclick = async () => {
    const patch = {};
    for (const f of FIELDS) patch[f] = el(f).value.trim();
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });
    el("msg").textContent = "ההגדרות נשמרו בהצלחה!";
  };
  el("reset").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "RESET_CONFIG" });
    await load();
    el("msg").textContent = "אופס לברירת המחדל";
  };
  el("recheck").onclick = async () => {
    el("conn-text").textContent = "בודק חיבור מול GitHub API...";
    const res = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    el("conn-dot").className = "dot " + (res && res.ok ? "is-ok" : "is-fail");
    el("conn-text").textContent = res && res.ok ? ("מחובר בהצלחה: " + res.detail) : ((res && res.error) || "החיבור נכשל");
  };
  el("selfUpdateBtn").onclick = async () => {
    el("msg").textContent = "מפעיל עדכון מהמאגר...";
    const res = await chrome.runtime.sendMessage({ type: "TRIGGER_SELF_UPDATE" });
    el("msg").textContent = res && res.ok ? "התוסף עודכן בהצלחה!" : ((res && res.error) || "שגיאה בעדכון");
  };
  void load();
})();