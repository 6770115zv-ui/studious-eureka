"use strict";
(function (root) {
  function readU16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function readU32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0; }
  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  function parseZipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
      if (readU32(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Invalid ZIP archive");
    const total = readU16(buf, eocd + 8);
    let cd = readU32(buf, eocd + 16);
    const list = [];
    for (let idx = 0; idx < total; idx++) {
      if (readU32(buf, cd) !== 0x02014b50) break;
      const method = readU16(buf, cd + 10);
      const compSize = readU32(buf, cd + 20);
      const nameLen = readU16(buf, cd + 28);
      const extraLen = readU16(buf, cd + 30);
      const commentLen = readU16(buf, cd + 32);
      const lho = readU32(buf, cd + 42);
      const name = decodeUtf8(buf.subarray(cd + 46, cd + 46 + nameLen));
      cd += 46 + nameLen + extraLen + commentLen;
      const dataStart = lho + 30 + readU16(buf, lho + 26) + readU16(buf, lho + 28);
      list.push({ name, method, raw: buf.subarray(dataStart, dataStart + compSize) });
    }
    return list;
  }
  function unzipSync(data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const out = {};
    for (const item of parseZipEntries(buf)) {
      if (item.method === 0) out[item.name] = new Uint8Array(item.raw);
      else if (item.method === 8 && typeof require === "function") out[item.name] = new Uint8Array(require("zlib").inflateRawSync(item.raw));
      else out[item.name] = new Uint8Array(item.raw);
    }
    return out;
  }
  async function unzipAsync(data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const out = {};
    for (const item of parseZipEntries(buf)) {
      if (item.method === 0) {
        out[item.name] = new Uint8Array(item.raw);
      } else if (item.method === 8) {
        try {
          const stream = new Blob([item.raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          out[item.name] = new Uint8Array(await new Response(stream).arrayBuffer());
        } catch {
          out[item.name] = unzipSync(buf)[item.name];
        }
      } else {
        out[item.name] = new Uint8Array(item.raw);
      }
    }
    return out;
  }
  root.fflate = { unzipSync, unzipAsync };
})(typeof globalThis !== "undefined" ? globalThis : self);