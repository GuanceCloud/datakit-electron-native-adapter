"use strict";
const path = require("node:path");

const TARGETS = ["darwin-universal", "win32-x64"];
const SDK_TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/;
function targetFor(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return "darwin-universal";
  if (platform === "win32" && arch === "x64") return "win32-x64";
}
function installedDirectory(packageRoot, target) {
  if (!TARGETS.includes(target)) throw new Error("Unsupported runtime target: " + target);
  return path.join(packageRoot, ".cloudcare", "native", target === "win32-x64" ? target : "darwin", "runtime");
}
function validateDefaults(config, version) {
  if (config?.schemaVersion !== 1 || typeof config.pipelineOnly !== "boolean" || !config.targets ||
      typeof config.targets !== "object" || Array.isArray(config.targets)) throw new Error("Invalid nativeRuntime defaults.");
  if (config.pipelineOnly && !version.includes("-")) throw new Error("Pipeline-only packages must use a prerelease version.");
  if (Object.keys(config.targets).some((target) => !TARGETS.includes(target))) throw new Error("Unsupported nativeRuntime target.");
  for (const target of TARGETS) {
    const value = config.targets[target];
    if (!value && config.pipelineOnly) continue;
    if (!value || !SDK_TAG.test(value.sdkVersion || "") ||
        (target === "win32-x64" && !ASSET_NAME.test(value.assetName || "")) ||
        (value.assetName !== undefined && !ASSET_NAME.test(value.assetName))) {
      throw new Error("Provide a fixed SDK tag and asset name for " + target + "; use --pipeline-only only for prerelease workflow validation.");
    }
  }
  return config;
}
module.exports = { TARGETS, SDK_TAG, ASSET_NAME, targetFor, installedDirectory, validateDefaults };
