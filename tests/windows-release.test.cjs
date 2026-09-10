"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { PACKAGE_NAME, RUNTIME_FILES, RUNTIME_SUBDIRECTORY } = require("../platform/win32/runtime.cjs");
const { readReleaseArtifact, validatePackageMetadata } = require("../scripts/release-artifact.cjs");
const { publishWindows } = require("../scripts/publish-windows.cjs");

function artifact(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "single-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "main", RUNTIME_SUBDIRECTORY);
  fs.mkdirSync(runtime, { recursive: true });
  const source = { commit: "a".repeat(40), dirty: false };
  const manifest = { schemaVersion: 1, platform: "win32", arch: "x64", configuration: "Release", protocolVersion: 1,
    sdkVersion: "0.1.0", npmPackageVersion: "0.1.0-alpha.1", source, crt: { policy: "prerequisite" }, files: {} };
  for (const name of RUNTIME_FILES) {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(path.join(runtime, name), bytes);
    manifest.files[name] = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  const metadata = { name: PACKAGE_NAME, version: manifest.npmPackageVersion, files: [RUNTIME_SUBDIRECTORY] };
  fs.writeFileSync(path.join(root, "main/package.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), JSON.stringify(manifest));
  const tarball = path.join(root, "adapter.tgz");
  fs.writeFileSync(tarball, "unit-test artifact bytes; real npm tarballs are tested separately");
  const report = { schemaVersion: 2, distribution: "single-package", version: metadata.version, nativeSource: source,
    adapterSource: { commit: "b".repeat(40), dirty: false },
    package: { name: PACKAGE_NAME, version: metadata.version, filename: "adapter.tgz",
      integrity: "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64") } };
  const save = () => fs.writeFileSync(path.join(root, "pack-report.json"), JSON.stringify(report));
  save();
  return { root, tarball, report, save, metadata, runtime };
}

test("release preflight makes no npm call; explicit execution publishes exactly one checked tarball", async (t) => {
  t.mock.method(console, "log", () => {});
  const f = artifact(t);
  const calls = [];
  const runNpm = async (...args) => { calls.push(args); };
  const options = { directory: f.root, registry: "https://registry.npmjs.org", tag: "next", access: "public" };
  await publishWindows(options, runNpm);
  assert.equal(calls.length, 0);
  await publishWindows({ ...options, execute: true }, runNpm);
  assert.deepEqual(calls, [[["publish", f.tarball, "--registry", options.registry, "--tag", "next", "--access", "public", "--ignore-scripts"], f.root]]);
});

test("release preflight rejects dirty adapter/native sources, old dual reports and tarball tampering", (t) => {
  const f = artifact(t);
  for (const key of ["adapterSource", "nativeSource"]) {
    f.report[key].dirty = true; f.save();
    assert.throws(() => readReleaseArtifact(f.root), /Dirty native or adapter/);
    f.report[key].dirty = false; f.save();
  }
  f.report.schemaVersion = 1; f.save();
  assert.throws(() => readReleaseArtifact(f.root), /single-package pack report/);
  f.report.schemaVersion = 2; f.save();
  fs.appendFileSync(f.tarball, "changed");
  assert.throws(() => readReleaseArtifact(f.root), /Tarball integrity mismatch/);
});

test("single package cannot retain platform dependency, local paths, or a Windows-only install restriction", (t) => {
  const { metadata } = artifact(t);
  for (const change of [
    { optionalDependencies: { [PACKAGE_NAME + "-win32-x64"]: metadata.version } },
    { dependencies: { dependency: "file:C:/development/runtime" } },
    { os: ["win32"] }, { cpu: ["x64"] }, { private: true },
  ]) assert.throws(() => validatePackageMetadata({ ...metadata, ...change }, metadata.version), /Invalid single-package|Local or separate/);
});
