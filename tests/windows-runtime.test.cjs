"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { PACKAGE_NAME, RUNTIME_SUBDIRECTORY, RUNTIME_FILES, resolveWindowsRuntime, validateRuntime } = require("../platform/win32/runtime.cjs");
const { stageWindowsRuntime } = require("../packaging/windows.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "win-runtime-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, RUNTIME_SUBDIRECTORY);
  fs.mkdirSync(runtime, { recursive: true });
  const manifest = { schemaVersion: 1, platform: "win32", arch: "x64", configuration: "Release", protocolVersion: 1,
    sdkVersion: "0.1.0", npmPackageVersion: "0.0.0-local", source: { commit: "a".repeat(40), dirty: false },
    crt: { policy: "prerequisite" }, files: {} };
  for (const name of RUNTIME_FILES) {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(path.join(runtime, name), bytes);
    manifest.files[name] = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  const save = () => fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), JSON.stringify(manifest));
  save();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0-local" }));
  return { root, runtime, manifest, save, packageRoot: root };
}

test("default package resolution validates native bytes and stages complete runtime outside ASAR", (t) => {
  const f = fixture(t);
  assert.equal(resolveWindowsRuntime({ ...f, resourcesPath: null, arch: "x64" }), f.runtime);
  const destination = stageWindowsRuntime({ nativeDirectory: f.runtime, resourcesDirectory: path.join(f.root, "resources") });
  assert.deepEqual(fs.readFileSync(path.join(destination, RUNTIME_FILES[0])), fs.readFileSync(path.join(f.runtime, RUNTIME_FILES[0])));
  assert.equal(resolveWindowsRuntime({ resourcesPath: path.dirname(destination), arch: "x64", packageRoot: f.root }), destination);
  assert.throws(() => stageWindowsRuntime({ nativeDirectory: f.runtime, resourcesDirectory: path.join(f.root, "app.asar/resources") }), /outside ASAR/);
});

test("bad explicit override never falls back and missing bundle/unsupported architecture are actionable", (t) => {
  const f = fixture(t);
  assert.equal(resolveWindowsRuntime({ directory: path.join(f.root, "missing"), packageRoot: f.root }), path.join(f.root, "missing"));
  assert.throws(() => resolveWindowsRuntime({ directory: "" }), /non-empty/);
  assert.throws(() => resolveWindowsRuntime({ arch: "arm64" }), /does not support arm64/);
  fs.renameSync(f.runtime, path.join(f.root, "exported-runtime"));
  assert.throws(() => resolveWindowsRuntime({ packageRoot: f.root, resourcesPath: null, arch: "x64" }), /Missing bundled Windows runtime/);
  assert.throws(() => resolveWindowsRuntime({ directory: path.join(f.root, "app.asar/runtime") }), /cannot run inside ASAR/);
});

test("missing DLL, tampering, wrong PE architecture and manifest/version mismatches fail before spawn", (t) => {
  const f = fixture(t);
  assert.throws(() => validateRuntime(f.runtime, { version: "9.0.0" }), /version mismatch/);
  f.manifest.protocolVersion = 2; f.save();
  assert.throws(() => validateRuntime(f.runtime), /compatible bridge protocol/);
  f.manifest.protocolVersion = 1; f.save();
  const file = path.join(f.runtime, RUNTIME_FILES[1]);
  const bytes = fs.readFileSync(file); bytes[100] = 1; fs.writeFileSync(file, bytes);
  assert.throws(() => validateRuntime(f.runtime), /integrity mismatch/);
  bytes.writeUInt16LE(0x14c, 68); fs.writeFileSync(file, bytes);
  assert.throws(() => validateRuntime(f.runtime), /invalid x64 PE architecture/);
  fs.unlinkSync(file);
  assert.throws(() => validateRuntime(f.runtime), /runtime is missing/);
});

test("package metadata and stale staged resources cannot silently select another runtime", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "8.0.0" }));
  assert.throws(() => resolveWindowsRuntime({ ...f, arch: "x64", resourcesPath: null }), /runtime version mismatch/);
  const resources = path.join(f.root, "resources"); fs.mkdirSync(path.join(resources, "native"), { recursive: true });
  assert.throws(() => resolveWindowsRuntime({ ...f, arch: "x64", resourcesPath: resources }), /runtime is missing/);
});
