"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveDarwinRuntime } = require("../platform/darwin/runtime.cjs");
const { collectFiles } = require("../runtime/archive.cjs");

function stageMacOSRuntime({ resourcesDirectory, nativeDirectory, arch = process.arch } = {}) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("macOS runtime staging requires arm64 or x64.");
  if (typeof resourcesDirectory !== "string" || !resourcesDirectory.trim()) throw new Error("resourcesDirectory is required.");
  const source = resolveDarwinRuntime({ directory: nativeDirectory, resourcesPath: null, arch });
  const files = collectFiles(source);
  if (!files.some((file) => file.name === "guance_electron.node") || !files.some((file) => /^[^/]+\.bundle\//.test(file.name))) {
    throw new Error("macOS runtime requires the addon and its resource bundles.");
  }
  const destination = path.resolve(resourcesDirectory, "native");
  if (/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(destination)) throw new Error("resourcesDirectory must be outside ASAR.");
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error("Runtime staging destination must be empty: " + destination);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

module.exports = { stageMacOSRuntime };
