"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, VERSION, json } = require("./helpers/release-fixture.cjs");
const { readReleaseArtifact, validatePackageMetadata } = require("../scripts/github-release-artifact.cjs");
const { publishRelease } = require("../scripts/publish-release.cjs");
const { packRelease } = require("../scripts/pack-release.cjs");
const { verifyRelease } = require("../scripts/verify-release.cjs");
const { npm } = require("../scripts/npm-command.cjs");
const { createArchive, sha256 } = require("../runtime/archive.cjs");
const { installedDirectory } = require("../runtime/config.cjs");

const OPTIONS = { registry: "https://registry.npmjs.org/", tag: "alpha", access: "public" };

test("npm preflight and explicit publication do not require native assets", async (t) => {
  const f = fixture(t);
  const calls = [];
  const dependencies = { log() {}, runNpm: async (args) => {
    calls.push(args);
    if (args[0] === "view" && !calls.some((call) => call[0] === "publish")) throw new Error("npm E404 not found");
    return JSON.stringify(f.report.package.integrity);
  } };
  await publishRelease({ ...OPTIONS, directory: f.root }, dependencies);
  assert.equal(calls.length, 0);
  const result = await publishRelease({ ...OPTIONS, directory: f.root, localOnly: true, execute: true }, dependencies);
  assert.equal(result.published, true);
  assert.deepEqual(calls.map((call) => call[0]), ["view", "publish", "view"]);
  assert.equal(calls[1][1], f.tarball);
  await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, tag: "latest" }, dependencies), /prerelease dist-tag/);
});

test("publication retry accepts only identical npm bytes and repairs the requested dist-tag", async (t) => {
  const f = fixture(t);
  const calls = [];
  const dependencies = { log() {}, runNpm: async (args) => { calls.push(args); return JSON.stringify(f.report.package.integrity); } };
  const result = await publishRelease({ ...OPTIONS, directory: f.root, execute: true }, dependencies);
  assert.equal(result.existing, true);
  assert.deepEqual(calls.map((call) => call[0]), ["view", "dist-tag"]);
  await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, execute: true }, {
    ...dependencies, runNpm: async () => JSON.stringify("sha512-different"),
  }), /different integrity/);
  await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, execute: true }, {
    ...dependencies, runNpm: async () => { throw new Error("npm E403 forbidden"); },
  }), /E403/);
});

test("release validation rejects dirty provenance, old reports, tampering and metadata divergence", (t) => {
  const f = fixture(t);
  readReleaseArtifact(f.root);
  f.report.adapterSource.dirty = true;
  json(path.join(f.root, "pack-report.json"), f.report);
  assert.throws(() => readReleaseArtifact(f.root), /Dirty adapter/);
  f.report.adapterSource.dirty = false;
  f.report.schemaVersion = 2;
  json(path.join(f.root, "pack-report.json"), f.report);
  assert.throws(() => readReleaseArtifact(f.root), /schemaVersion 5/);
  f.report.schemaVersion = 5;
  json(path.join(f.root, "pack-report.json"), f.report);
  json(path.join(f.main, "package.json"), { ...f.metadata, description: "changed after npm pack" });
  assert.throws(() => readReleaseArtifact(f.root), /tarball metadata differs/);
  json(path.join(f.main, "package.json"), f.metadata);
  fs.appendFileSync(f.tarball, "tampered");
  assert.throws(() => readReleaseArtifact(f.root), /Tarball integrity mismatch/);
  for (const changes of [{ private: true }, { os: ["win32"] }, { scripts: { postinstall: "node install.cjs" } },
    { optionalDependencies: { [f.metadata.name + "-win32-x64"]: VERSION } },
    { dependencies: { bad: "file:../runtime" } }]) {
    assert.throws(() => validatePackageMetadata({ ...f.metadata, ...changes }, VERSION), /Invalid SDK|Local or separate/);
  }
});

test("real npm pack and install need no native files, manifests or Release URLs", async (t) => {
  const f = fixture(t);
  const output = path.join(f.root, "actual-pack");
  t.mock.method(console, "log", () => {});
  const report = await packRelease({ version: VERSION, output, allowDirty: true, pipelineOnly: true });
  const validated = readReleaseArtifact(output, { allowDirty: true });
  assert.equal(report.package.files.some((file) => /\.(node|dll|exe)$/.test(file.path)), false);
  assert.equal(validated.metadata.repository.url, "git+ssh://git@github.com/GuanceCloud/datakit-electron-native-adapter.git");
  assert.deepEqual(validated.metadata.scripts, { postinstall: "node runtime/postinstall.cjs" });
  const result = await verifyRelease({ directory: output, allowDirty: true, offline: true, skipRuntime: true });
  assert.equal(result.passed, true);
  assert.equal(result.nativeRuntimeValidated, false);
});

test("actual npm postinstall installs a supplied offline SDK archive without skip flags", async (t) => {
  const f = fixture(t);
  const output = path.join(f.root, "automatic-pack");
  const sdkVersion = "9.8.7-test.1";
  const payload = { "guance_electron.node": Buffer.from("synthetic addon"), "Guance.bundle/Info.plist": Buffer.from("synthetic resource") };
  const manifest = { schemaVersion: 1, mode: "managed", platform: "darwin", nativeSDKLinkage: "static", configuration: "release",
    nativeSDK: { version: sdkVersion }, architectures: ["arm64", "x86_64"], nodeAPIVersion: 8, minimumMacOSVersion: "10.14",
    files: Object.fromEntries(Object.entries(payload).map(([name, bytes]) => [name, sha256(bytes)])) };
  const bytes = createArchive([...Object.entries(payload).map(([name, bytes]) => ({ name: "runtime/" + name, bytes, mode: 0o644 })),
    { name: "runtime/runtime-manifest.json", bytes: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }]);
  const archive = path.join(f.root, "sdk.tar.gz");
  fs.writeFileSync(archive, bytes);
  fs.writeFileSync(archive + ".sha256", sha256(bytes));
  t.mock.method(console, "log", () => {});
  await packRelease({ version: VERSION, output, allowDirty: true, macosSdkVersion: sdkVersion, windowsSdkVersion: "3.2.1-test.1", windowsAssetName: "sdk.tar.gz" });
  const { tarball } = readReleaseArtifact(output, { allowDirty: true });
  const consumer = path.join(f.root, "consumer"); fs.mkdirSync(consumer);
  json(path.join(consumer, "package.json"), { name: "offline-consumer", private: true, version: "0.0.0" });
  await npm(["install", tarball, "--offline", "--ignore-scripts=false", "--omit=optional", "--no-audit", "--no-fund"], consumer,
    { environment: { ...process.env, GUANCE_NATIVE_SKIP_DOWNLOAD: "0", GUANCE_NATIVE_RUNTIME_ARCHIVE: archive,
      GUANCE_NATIVE_RUNTIME_TARGET: "darwin-universal", GUANCE_NATIVE_SDK_VERSION: sdkVersion,
      GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL: "https://offline.invalid" } });
  const runtime = installedDirectory(path.join(consumer, "node_modules", f.metadata.name), "darwin-universal");
  assert.deepEqual(fs.readFileSync(path.join(runtime, "guance_electron.node")), payload["guance_electron.node"]);
});
