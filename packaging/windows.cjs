"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { RUNTIME_FILES, resolveWindowsRuntime, validateRuntime } = require("../platform/win32/runtime.cjs");
const { windowsArch } = require("../runtime/config.cjs");

// Pass the finished application's resources directory (outside app.asar).
// For cross-architecture packaging, pass the target Electron architecture explicitly.
function stageWindowsRuntime({ resourcesDirectory, nativeDirectory, arch = process.arch } = {}) {
  if (!windowsArch(arch)) throw new Error(`Windows npm packaging does not support ${arch}.`);
  if (typeof resourcesDirectory !== "string" || !resourcesDirectory.trim()) {
    throw new Error("resourcesDirectory is required.");
  }
  const source = resolveWindowsRuntime({ directory: nativeDirectory, resourcesPath: null, arch });
  validateRuntime(source, { requireManifest: nativeDirectory === undefined, arch });
  const destination = path.resolve(resourcesDirectory, "native");
  if (/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(destination)) throw new Error("resourcesDirectory must be outside ASAR.");
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    throw new Error(`Runtime staging destination must be empty: ${destination}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const name of [...RUNTIME_FILES, "runtime-manifest.json", "LICENSE"]) {
    const file = path.join(source, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(destination, name));
  }
  validateRuntime(destination, { requireManifest: nativeDirectory === undefined, arch });
  return destination;
}

module.exports = { stageWindowsRuntime };
