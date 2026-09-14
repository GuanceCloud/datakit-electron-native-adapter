"use strict";
const path = require("node:path");

const WINDOWS_ARCHES = ["x64", "x86", "arm64"];
const WINDOWS_TARGETS = WINDOWS_ARCHES.map((arch) => "win32-" + arch);
const TARGETS = ["darwin-universal", ...WINDOWS_TARGETS];
function windowsArch(arch) {
  const normalized = arch === "ia32" ? "x86" : arch;
  return WINDOWS_ARCHES.includes(normalized) ? normalized : undefined;
}
function isWindowsTarget(target) { return WINDOWS_TARGETS.includes(target); }
const SDK_TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/;
const WINDOWS_STREAM_TAG = /^(?:nuget|vcpkg)_((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta)\.[1-9][0-9]*)?)$/;
function sdkVersionForTag(tag, target) {
  if (!TARGETS.includes(target)) throw new Error("Unsupported runtime target: " + target);
  if (typeof tag !== "string") throw new Error("Native SDK version is required");
  const stream = isWindowsTarget(target) && WINDOWS_STREAM_TAG.exec(tag);
  if (stream) return stream[1];
  if (!SDK_TAG.test(tag)) throw new Error("Invalid Native SDK version: " + tag);
  return tag.replace(/^v/, "");
}
function defaultAssetName(tag, target) {
  return "guance-electron-runtime-" + sdkVersionForTag(tag, target) + "-" + target + ".tar.gz";
}
function targetFor(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) return "darwin-universal";
  if (platform === "win32" && windowsArch(arch)) return "win32-" + windowsArch(arch);
}
function installedDirectory(packageRoot, target) {
  if (!TARGETS.includes(target)) throw new Error("Unsupported runtime target: " + target);
  return path.join(packageRoot, ".cloudcare", "native", isWindowsTarget(target) ? target : "darwin", "runtime");
}
function validateDefaults(config, version) {
  if (config?.schemaVersion !== 1 || typeof config.pipelineOnly !== "boolean" || !config.targets ||
      typeof config.targets !== "object" || Array.isArray(config.targets)) throw new Error("Invalid nativeRuntime defaults.");
  if (config.pipelineOnly && !version.includes("-")) throw new Error("Pipeline-only packages must use a prerelease version.");
  if (Object.keys(config.targets).some((target) => !TARGETS.includes(target))) throw new Error("Unsupported nativeRuntime target.");
  for (const target of TARGETS) {
    const value = config.targets[target];
    // Older schema-1 packages only declared x64. Keep them readable; new packing
    // expands the Windows SDK tag into all three architecture defaults.
    if (!value && (config.pipelineOnly || target === "win32-x86" || target === "win32-arm64")) continue;
    let validTag = false;
    try { sdkVersionForTag(value?.sdkVersion, target); validTag = true; } catch {}
    if (!value || !validTag ||
        (value.assetName !== undefined && !ASSET_NAME.test(value.assetName))) {
      throw new Error("Provide a fixed SDK tag and an optional valid asset name for " + target + "; use --pipeline-only only for prerelease workflow validation.");
    }
  }
  return config;
}
module.exports = { TARGETS, WINDOWS_ARCHES, WINDOWS_TARGETS, windowsArch, isWindowsTarget, SDK_TAG, ASSET_NAME, sdkVersionForTag, defaultAssetName, targetFor, installedDirectory, validateDefaults };
