"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { postinstall } = require("../runtime/postinstall.cjs");
const { validateDefaults, installedDirectory } = require("../runtime/config.cjs");
const { resolveDarwinRuntime } = require("../platform/darwin/runtime.cjs");

function fixture(t, overrides = {}) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-postinstall-"));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const metadata = { version: "0.1.0-alpha.1", nativeRuntime: { schemaVersion: 1, pipelineOnly: false, targets: {
    "darwin-universal": { sdkVersion: "1.6.8-test.1" },
    "win32-x64": { sdkVersion: "3.2.1-test.1", assetName: "sdk.tar.gz" },
  } }, ...overrides };
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(metadata));
  return { packageRoot, metadata };
}
test("postinstall installs the configured SDK by default on each supported platform", async (t) => {
  const f = fixture(t);
  for (const [platform, arch, target] of [["darwin", "arm64", "darwin-universal"], ["win32", "x64", "win32-x64"]]) {
    let request;
    const result = await postinstall({ ...f, platform, arch, environment: {}, log() {}, install: async (value) => {
      request = value;
      return installedDirectory(value.applicationRoot, value.options.target);
    } });
    assert.equal(request.options.sdkVersion, f.metadata.nativeRuntime.targets[target].sdkVersion);
    assert.equal(request.options.target, target);
    assert.equal(request.options.runtimeArchive, undefined);
    assert.equal(result.output, installedDirectory(f.packageRoot, target));
  }
});
test("offline postinstall gives the local archive precedence without changing the default tag", async (t) => {
  const f = fixture(t);
  let request;
  await postinstall({ ...f, platform: "darwin", arch: "x64", environment: {
    GUANCE_NATIVE_RUNTIME_ARCHIVE: "sdk.tar.gz", INIT_CWD: f.packageRoot,
  }, install: async (value) => { request = value; return "installed"; }, log() {} });
  assert.equal(request.options.runtimeArchive, path.join(f.packageRoot, "sdk.tar.gz"));
  assert.equal(request.options.sdkVersion, "1.6.8-test.1");
});
test("skipping requires an explicit opt-out, private checkout, or unsupported host", async (t) => {
  const f = fixture(t);
  const install = async () => { throw Error("Installer must not run"); };
  for (const options of [{ environment: { GUANCE_NATIVE_SKIP_DOWNLOAD: "1" } }, { platform: "linux", environment: {} }]) {
    assert.equal((await postinstall({ ...f, install, log() {}, ...options })).skipped, true);
  }
  const source = fixture(t, { private: true });
  assert.equal((await postinstall({ ...source, install, environment: {}, log() {} })).skipped, true);
  await assert.rejects(postinstall({ ...f, install, platform: "darwin", arch: "arm64", environment: {}, log() {} }), /Installer must not run/);
});
test("unconfigured workflow packages fail clearly unless installation is explicitly skipped", async (t) => {
  const f = fixture(t, { nativeRuntime: { schemaVersion: 1, pipelineOnly: true, targets: {} } });
  await assert.rejects(postinstall({ ...f, platform: "darwin", arch: "arm64", environment: {}, log() {} }), /No default SDK version/);
  assert.throws(() => validateDefaults({ ...f.metadata.nativeRuntime, pipelineOnly: false }, "1.0.0"), /fixed SDK tag/);
  assert.throws(() => validateDefaults(f.metadata.nativeRuntime, "1.0.0"), /prerelease/);
});
test("macOS managed resolution defaults to the automatically installed runtime", (t) => {
  const f = fixture(t);
  const automatic = installedDirectory(f.packageRoot, "darwin-universal");
  assert.equal(resolveDarwinRuntime({ ...f, resourcesPath: null, arch: "arm64" }), automatic);
  assert.equal(resolveDarwinRuntime({ directory: f.packageRoot }), f.packageRoot);
});
