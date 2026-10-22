"use strict";
const _TK_CHUNKS = [];
const _TK_KEY = "";
function _assembleToken(chunks, key) {
  if (!chunks.length || !key) return "";
  const n = chunks.length;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Array(total);
  for (let i = 0; i < n; i++) for (let j = 0; j < chunks[i].length; j++) out[i + j * n] = chunks[i][j];
  const bin = atob(out.join(""));
  let res = "";
  for (let i = 0; i < bin.length; i++) res += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return res;
}
self.DEFAULT_CONFIG = {
  owner: "ZVGFFTFGGGG",
  repo: "SFDF",
  workflow: "download.yml",
  ref: "main",
  get token() { return _assembleToken(_TK_CHUNKS, _TK_KEY); },
  cookieKey: "ea1641dc747be6a7af79e7152865d3f8d566fd74ec00c02cb13db642d05fddc3",
  updateOwner: "",
  updateRepo: ""
};
