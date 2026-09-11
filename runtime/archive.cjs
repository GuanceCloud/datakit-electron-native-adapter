"use strict";

// Release assets use a small, deterministic USTAR subset: regular files only.
// No platform tar executable, npm dependency, links or extraction hooks are needed.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 4096;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function safePath(name) {
  if (typeof name !== "string" || !name || name.length > 255 ||
      /[\\\x00-\x1f\x7f:]/.test(name) || path.posix.isAbsolute(name) ||
      name.split("/").some((part) => !part || part === "." || part === ".." ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error("Unsafe archive path: " + name);
  }
  return name;
}

function checkNames(files) {
  const names = new Set();
  const directories = new Set();
  if (!files.length || files.length > MAX_FILES) throw new Error("Invalid archive file count.");
  for (const file of files) {
    const key = safePath(file.name).toLowerCase();
    if (names.has(key) || directories.has(key)) throw new Error("Duplicate or conflicting archive path: " + file.name);
    const parents = key.split("/");
    parents.pop();
    while (parents.length) {
      const parent = parents.join("/");
      if (names.has(parent)) throw new Error("Conflicting archive path: " + file.name);
      directories.add(parent);
      parents.pop();
    }
    names.add(key);
  }
}

function collectFiles(root) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Runtime root cannot be a symbolic link.");
  const result = [];
  let total = 0;
  function visit(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = safePath(prefix + entry.name);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name + "/");
      else if (entry.isFile()) {
        const stat = fs.lstatSync(file);
        total += stat.size;
        if (total > MAX_UNPACKED_BYTES || result.length >= MAX_FILES) throw new Error("Runtime export is too large.");
        result.push({ name, bytes: fs.readFileSync(file), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
      } else throw new Error("Runtime export must contain only regular files: " + name);
    }
  }
  visit(root);
  checkNames(result);
  return result;
}

function createArchive(files) {
  checkNames(files);
  const parts = [];
  let total = 1024;
  for (const { name, bytes, mode = 0o644 } of files) {
    const header = Buffer.alloc(512);
    let leaf = name;
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/");
      const prefix = name.slice(0, split);
      leaf = name.slice(split + 1);
      if (split < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100) throw new Error("Archive path is too long: " + name);
      header.write(prefix, 345, 155);
    }
    header.write(leaf, 0, 100);
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
    octal(mode & 0o111 ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6); header.write("00", 263, 2);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
    total += 512 + bytes.length + padding.length;
    if (total > MAX_UNPACKED_BYTES) throw new Error("Runtime archive is too large.");
    parts.push(header, bytes, padding);
  }
  parts.push(Buffer.alloc(1024));
  const compressed = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error("Compressed archive is too large.");
  return compressed;
}

function readArchive(compressed) {
  if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error("Compressed archive is too large.");
  const bytes = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = [];
  const string = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const octal = (header, start, length) => {
    const value = string(header, start, length).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error("Invalid archive numeric field.");
    return parseInt(value, 8);
  };
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0)) throw new Error("Invalid archive trailer.");
      checkNames(files);
      return files;
    }
    const checksum = octal(header, 148, 8);
    const actual = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error("Archive header checksum mismatch.");
    const prefix = string(header, 345, 155);
    const name = safePath((prefix ? prefix + "/" : "") + string(header, 0, 100));
    if (![0, 48].includes(header[156])) throw new Error("Archive contains a link or unsupported entry: " + name);
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    offset += 512;
    if (!Number.isSafeInteger(size) || offset + size > bytes.length || files.length >= MAX_FILES) throw new Error("Truncated or oversized archive.");
    files.push({ name, bytes: bytes.subarray(offset, offset + size), mode: mode & 0o111 ? 0o755 : 0o644 });
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error("Missing archive trailer.");
}

function fileRecords(files) {
  return Object.fromEntries(files.map(({ name, bytes, mode }) => [name, { size: bytes.length, sha256: sha256(bytes), mode: mode & 0o111 ? 0o755 : 0o644 }]));
}

function verifyFiles(files, records) {
  const actual = fileRecords(files);
  if (Object.keys(actual).sort().join("\n") !== Object.keys(records).sort().join("\n")) throw new Error("Runtime file list mismatch.");
  for (const [name, record] of Object.entries(actual)) {
    if (record.size !== records[name].size || record.sha256 !== records[name].sha256 || record.mode !== records[name].mode) {
      throw new Error("Runtime file integrity mismatch: " + name);
    }
  }
}

module.exports = { MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, MAX_FILES, safePath, collectFiles, createArchive, readArchive, fileRecords, verifyFiles, sha256 };
