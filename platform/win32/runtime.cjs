"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { installedDirectory } = require("../../runtime/config.cjs");
const { PROTOCOL_VERSION } = require("../../core/channels.cjs");
const PACKAGE_NAME = "@cloudcare/electron-native-adapter";
const RUNTIME_SUBDIRECTORY = "native/win32-x64";
const RUNTIME_FILES = Object.freeze([
  "guance_windows_electron_bridge.exe",
  "guance_windows_native.dll",
]);

function assertOutsideAsar(directory) {
  if (/(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(directory)) {
    throw new Error("Windows runtime cannot run inside ASAR. Use stageWindowsRuntime() to copy it to resources/native.");
  }
}

function validateRuntime(directory, { version, requireManifest = true } = {}) {
  assertOutsideAsar(directory);
  for (const name of RUNTIME_FILES) {
    if (!fs.existsSync(path.join(directory, name))) {
      throw new Error(`The installed native runtime is missing: ${path.join(directory, name)}`);
    }
  }
  const manifestPath = path.join(directory, "runtime-manifest.json");
  if (!requireManifest && !fs.existsSync(manifestPath)) return;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (error) { throw new Error(`Invalid or missing Windows runtime manifest: ${manifestPath}. ${error.message}`); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== "win32" || manifest.arch !== "x64" ||
      manifest.configuration !== "Release" || manifest.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Windows runtime requires Release win32-x64 and a compatible bridge protocol. Reinstall the adapter package.");
  }
  if (version && manifest.npmPackageVersion !== version) {
    throw new Error(`Windows runtime version mismatch: expected ${version}, received ${manifest.npmPackageVersion}. Reinstall the adapter package.`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.source?.commit || "") ||
      typeof manifest.source.dirty !== "boolean" || !manifest.sdkVersion ||
      !manifest.crt?.policy || !manifest.files ||
      Object.keys(manifest.files).sort().join() !== [...RUNTIME_FILES].sort().join()) {
    throw new Error("Windows runtime manifest has incomplete source, CRT, or file provenance.");
  }
  for (const name of RUNTIME_FILES) {
    const bytes = fs.readFileSync(path.join(directory, name));
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ" || pe > bytes.length - 6 ||
        bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
      throw new Error(`Windows runtime has invalid x64 PE architecture: ${name}`);
    }
    const record = manifest.files[name];
    if (record.size !== bytes.length || record.sha256 !== crypto.createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`Windows runtime integrity mismatch: ${name}. Reinstall the adapter package.`);
    }
  }
  return manifest;
}

function resolveWindowsRuntime({
  directory,
  resourcesPath = process.resourcesPath,
  arch = process.arch,
  packageRoot = path.resolve(__dirname, "../.."),
} = {}) {
  if (directory !== undefined) {
    if (typeof directory !== "string" || !directory.trim()) throw new Error("native.directory must be a non-empty string.");
    const resolved = path.resolve(directory);
    assertOutsideAsar(resolved);
    // Legacy local/vcpkg overrides need no npm manifest. Their handshake is still checked at startup.
    if (fs.existsSync(path.join(resolved, "runtime-manifest.json"))) validateRuntime(resolved);
    return resolved;
  }
  if (arch !== "x64") throw new Error(`Windows npm managed runtime does not support ${arch}; use an explicit native.directory with a compatible native build.`);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== PACKAGE_NAME || typeof metadata.version !== "string") {
    throw new Error("Invalid Electron adapter package metadata.");
  }
  const version = metadata.version;
  const staged = resourcesPath && path.join(resourcesPath, "native");
  if (staged && fs.existsSync(staged)) {
    validateRuntime(staged);
    return staged;
  }
  const installed = installedDirectory(packageRoot, "win32-x64");
  const runtime = fs.existsSync(installed) ? installed : path.join(packageRoot, RUNTIME_SUBDIRECTORY);
  assertOutsideAsar(runtime);
  if (!fs.existsSync(runtime)) {
    throw new Error(`Missing downloaded Windows runtime in ${PACKAGE_NAME}@${version}. Run npx guance-electron-native --sdk-version <sdk-tag> --target win32-x64, then set native.directory to the installed runtime.`);
  }
  validateRuntime(runtime);
  return runtime;
}

module.exports = { PACKAGE_NAME, RUNTIME_SUBDIRECTORY, RUNTIME_FILES, resolveWindowsRuntime, validateRuntime };
