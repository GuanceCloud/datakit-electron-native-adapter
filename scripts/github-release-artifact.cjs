"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { readArchive } = require("../runtime/archive.cjs");
const { validateDefaults } = require("../runtime/config.cjs");
const PACKAGE_NAME = "@cloudcare/electron-native-adapter";

function validVersion(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value) &&
    !value.split("-").slice(1).join("-").split(".").some((part) => /^0\d+$/.test(part));
}
function validatePackageMetadata(metadata, version) {
  if (!validVersion(version) || metadata.name !== PACKAGE_NAME || metadata.version !== version || metadata.private || metadata.os || metadata.cpu ||
      metadata.scripts?.postinstall !== "node runtime/postinstall.cjs" || Object.keys(metadata.scripts).length !== 1 ||
      metadata.bin?.["guance-electron-native"] !== "bin/guance-electron-native.mjs" ||
      !Array.isArray(metadata.files) || metadata.files.some((name) => name === "runtime-release.json" || /^native\/(win32-x64|darwin-universal)/.test(name))) {
    throw new Error("Invalid SDK installer package metadata or lifecycle scripts.");
  }
  validateDefaults(metadata.nativeRuntime, version);
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(metadata[group] || {})) {
      if (name.startsWith(PACKAGE_NAME + "-") || /^(?:file:|link:|[A-Za-z]:|[\\/]|\.{1,2}[\\/])/.test(spec)) {
        throw new Error("Local or separate platform dependency in single-package publish manifest.");
      }
    }
  }
}
function readReleaseArtifact(directory, { allowDirty = false } = {}) {
  const root = path.resolve(directory);
  const report = JSON.parse(fs.readFileSync(path.join(root, "pack-report.json"), "utf8"));
  if (report.schemaVersion !== 5 || report.distribution !== "sdk-release-installers" || !report.package) {
    throw new Error("Expected an SDK installer pack report (schemaVersion 5). Repack with pack:release.");
  }
  if (!/^[a-f0-9]{40}$/.test(report.adapterSource?.commit || "") || typeof report.adapterSource.dirty !== "boolean") throw new Error("Missing adapter source provenance.");
  if (report.adapterSource.dirty && !allowDirty) throw new Error("Dirty adapter artifacts cannot be published.");
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "main/package.json"), "utf8"));
  validatePackageMetadata(metadata, report.version);
  const record = report.package;
  if (record.name !== PACKAGE_NAME || record.version !== report.version || typeof record.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(record.filename)) throw new Error("Invalid npm tarball identity.");
  const tarball = path.join(root, record.filename);
  if (fs.statSync(tarball).size > 128 * 1024 * 1024) throw new Error("npm tarball is unexpectedly large.");
  const bytes = fs.readFileSync(tarball);
  const actual = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
  if (actual !== record.integrity) throw new Error("Tarball integrity mismatch: " + record.filename);
  const files = readArchive(bytes);
  const manifest = files.find((entry) => entry.name === "package/package.json");
  if (!manifest || !isDeepStrictEqual(JSON.parse(manifest.bytes.toString("utf8")), metadata)) throw new Error("npm tarball metadata differs from the validated package.");
  for (const required of ["runtime/postinstall.cjs", "runtime/config.cjs", "bin/guance-electron-native.mjs", "native/darwin/scripts/lib/customer-cli.mjs", "native/darwin/scripts/lib/install-runtime.mjs", "platform/win32/runtime.cjs"]) {
    if (!files.some((entry) => entry.name === "package/" + required)) throw new Error("Missing npm installer file: " + required);
  }
  if (files.some((entry) => /\.(exe|dll|node|pdb|tar\.gz|tgz)$/i.test(entry.name) || entry.name === "package/runtime-release.json")) throw new Error("npm tarball must contain the installer and no native assets.");
  return { report, metadata, tarball };
}
module.exports = { PACKAGE_NAME, validVersion, readReleaseArtifact, validatePackageMetadata };
