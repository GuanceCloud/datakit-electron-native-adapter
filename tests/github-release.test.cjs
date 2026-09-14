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

test("a successful upload retries registry visibility without publishing twice", async (t) => {
  const f = fixture(t);
  const calls = [];
  const waits = [];
  let views = 0;
  const result = await publishRelease({ ...OPTIONS, directory: f.root, execute: true }, {
    log() {}, wait: async (ms) => waits.push(ms),
    runNpm: async (args) => {
      calls.push(args);
      if (args[0] === "view" && ++views <= 3) throw new Error("npm view failed (1): npm error code E404");
      return JSON.stringify(f.report.package.integrity);
    },
  });
  assert.equal(result.published, true);
  assert.deepEqual(calls.map((args) => args[0]), ["view", "publish", "view", "view", "view"]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.ok(calls.filter((args) => args[0] === "view").every((args) => args.includes("--prefer-online")));
});

test("persistent post-upload E404 reports verification failure and stops retrying", async (t) => {
  const f = fixture(t);
  const calls = [];
  const waits = [];
  const logs = [];
  await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, execute: true }, {
    log: (message) => logs.push(message), wait: async (ms) => waits.push(ms),
    runNpm: async (args) => {
      calls.push(args[0]);
      if (args[0] === "view") throw new Error("npm E404 not found");
      return "upload completed";
    },
  }), /Registry verification failed.*--verify-only[\s\S]*E404/);
  assert.equal(calls.filter((name) => name === "publish").length, 1);
  assert.equal(calls.filter((name) => name === "view").length, 7);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15000]);
  assert.ok(logs.some((message) => message.startsWith("npm publish completed")));
  assert.ok(!logs.some((message) => message.startsWith("Published and verified")));
});

test("verify-only checks existing bytes without uploading or changing dist-tags", async (t) => {
  const f = fixture(t);
  const calls = [];
  const dependencies = { log() {}, runNpm: async (args) => {
    calls.push(args[0]);
    return JSON.stringify(f.report.package.integrity);
  } };
  assert.deepEqual(await publishRelease({ ...OPTIONS, directory: f.root, verifyOnly: true }, dependencies),
    { published: false, verified: true });
  assert.deepEqual(calls, ["view"]);
  await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, verifyOnly: true, execute: true }, dependencies), /cannot be combined/);
  assert.deepEqual(calls, ["view"]);
});

test("post-upload integrity mismatch and authorization errors do not trigger retries", async (t) => {
  const f = fixture(t);
  for (const failure of ["mismatch", "forbidden"]) {
    const calls = [];
    await assert.rejects(publishRelease({ ...OPTIONS, directory: f.root, execute: true }, {
      log() {}, wait: async () => assert.fail("Unexpected retry"),
      runNpm: async (args) => {
        calls.push(args[0]);
        if (calls.length === 1) throw new Error("npm E404 not found");
        if (args[0] === "publish") return "upload completed";
        if (failure === "forbidden") throw new Error("npm E403 forbidden");
        return JSON.stringify("sha512-different");
      },
    }), failure === "forbidden" ? /Registry verification failed[\s\S]*E403/ : /integrity differs/);
    assert.deepEqual(calls, ["view", "publish", "view"]);
  }
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

test("npm pack records the derived Windows filename and supports partial configured overrides", async (t) => {
  const f = fixture(t);
  t.mock.method(console, "log", () => {});
  const output = path.join(f.root, "derived-pack");
  await packRelease({ version: VERSION, output, allowDirty: true, pipelineOnly: true,
    windowsSdkVersion: "vcpkg_0.1.0-alpha.7" });
  const metadata = readReleaseArtifact(output, { allowDirty: true }).metadata;
  assert.deepEqual(metadata.nativeRuntime.targets["win32-x64"], {
    sdkVersion: "vcpkg_0.1.0-alpha.7", assetName: "guance-electron-runtime-0.1.0-alpha.7-win32-x64.tar.gz",
  });
  for (const arch of ["x86", "arm64"]) {
    assert.deepEqual(metadata.nativeRuntime.targets["win32-" + arch], {
      sdkVersion: "vcpkg_0.1.0-alpha.7", assetName: `guance-electron-runtime-0.1.0-alpha.7-win32-${arch}.tar.gz`,
    });
  }
  // Use the actual packed source as a configured project, with source provenance.
  const { execFileSync } = require("node:child_process");
  const source = path.join(output, "main");
  execFileSync("git", ["init", source], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { stdio: "pipe" });
  const fixedOutput = path.join(f.root, "fixed-name-pack");
  await packRelease({ root: source, version: VERSION, output: fixedOutput, pipelineOnly: true,
    windowsAssetName: "fixed-runtime.tar.gz" });
  assert.deepEqual(readReleaseArtifact(fixedOutput).metadata.nativeRuntime.targets["win32-x64"], {
    sdkVersion: "vcpkg_0.1.0-alpha.7", assetName: "fixed-runtime.tar.gz",
  });
  const nextOutput = path.join(f.root, "next-version-pack");
  await packRelease({ root: source, version: VERSION, output: nextOutput, pipelineOnly: true,
    windowsSdkVersion: "nuget_0.1.0-alpha.8" });
  assert.equal(readReleaseArtifact(nextOutput).metadata.nativeRuntime.targets["win32-x64"].assetName,
    "guance-electron-runtime-0.1.0-alpha.8-win32-x64.tar.gz");
  for (const arch of ["x86", "arm64"]) {
    assert.equal(readReleaseArtifact(fixedOutput).metadata.nativeRuntime.targets["win32-" + arch].assetName,
      `guance-electron-runtime-0.1.0-alpha.7-win32-${arch}.tar.gz`);
    assert.equal(readReleaseArtifact(nextOutput).metadata.nativeRuntime.targets["win32-" + arch].assetName,
      `guance-electron-runtime-0.1.0-alpha.8-win32-${arch}.tar.gz`);
  }
});
