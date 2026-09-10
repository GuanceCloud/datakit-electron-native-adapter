"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PACKAGE_NAME, RUNTIME_SUBDIRECTORY, validateRuntime } = require("../platform/win32/runtime.cjs");

function validatePackageMetadata(metadata, version) {
  if (metadata.name !== PACKAGE_NAME || metadata.version !== version || metadata.private || metadata.os || metadata.cpu ||
      !metadata.files?.includes(RUNTIME_SUBDIRECTORY)) {
    throw new Error("Invalid single-package release metadata, version or bundled runtime files.");
  }
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
  if (report.schemaVersion !== 2 || report.distribution !== "single-package" || !report.package || report.main || report.platform) {
    throw new Error("Expected a single-package pack report (schemaVersion 2). Repack with the current scripts.");
  }
  for (const source of [report.adapterSource, report.nativeSource]) {
    if (!/^[a-f0-9]{40}$/.test(source?.commit || "") || typeof source.dirty !== "boolean") throw new Error("Missing source provenance.");
    if (source.dirty && !allowDirty) throw new Error("Dirty native or adapter artifacts cannot be published by this release helper.");
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "main/package.json"), "utf8"));
  validatePackageMetadata(metadata, report.version);
  const manifest = validateRuntime(path.join(root, "main", RUNTIME_SUBDIRECTORY), { version: report.version });
  if (manifest.source.commit !== report.nativeSource.commit || manifest.source.dirty !== report.nativeSource.dirty) {
    throw new Error("Native source provenance mismatch.");
  }
  const record = report.package;
  if (record.name !== PACKAGE_NAME || record.version !== report.version || typeof record.filename !== "string" ||
      path.basename(record.filename) !== record.filename || !record.filename.endsWith(".tgz")) {
    throw new Error("Invalid single-package tarball identity.");
  }
  const tarball = path.join(root, record.filename);
  const actual = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
  if (actual !== record.integrity) throw new Error("Tarball integrity mismatch: " + record.filename);
  return { report, metadata, manifest, tarball };
}

module.exports = { readReleaseArtifact, validatePackageMetadata };
