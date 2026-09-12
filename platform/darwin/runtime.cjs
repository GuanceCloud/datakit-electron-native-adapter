"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { installedDirectory, targetFor } = require("../../runtime/config.cjs");

function resolveDarwinRuntime({ directory, resourcesPath = process.resourcesPath, arch = process.arch, packageRoot = path.resolve(__dirname, "../..") } = {}) {
  if (directory === undefined) {
    if (!targetFor("darwin", arch)) throw new Error("Unsupported macOS architecture: " + arch);
    const staged = resourcesPath && path.join(resourcesPath, "native");
    directory = staged && fs.existsSync(staged) ? staged : installedDirectory(packageRoot, "darwin-universal");
  }
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("native.directory is required. Install the SDK runtime with guance-electron-native, then pass its output directory.");
  }
  const resolved = path.resolve(directory);
  if (/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(resolved)) throw new Error("macOS runtime must be outside ASAR.");
  return resolved;
}

module.exports = { resolveDarwinRuntime };
