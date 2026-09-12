"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const tar = require("tar");
const installModule = () => import(pathToFileURL(path.join(__dirname, "../native/darwin/scripts/lib/install-runtime.mjs")).href);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const sdkVersion = "9.8.7-test.1";

async function fixture(t, manifestOverrides = {}, extraEntry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guance-runtime-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "source/runtime");
  const bundle = "GuanceSDK__GuanceSDKCore.bundle";
  fs.mkdirSync(path.join(runtime, bundle), { recursive: true });
  const files = {
    "guance_electron.node": Buffer.from("fixture addon"),
    [bundle + "/PrivacyInfo.xcprivacy"]: Buffer.from("<plist/>"),
  };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(runtime, name), data);
  const manifest = {
    schemaVersion: 1, mode: "managed", platform: "darwin", nativeSDKLinkage: "static",
    configuration: "release", nativeSDK: { version: sdkVersion },
    architectures: ["arm64", "x86_64"], nodeAPIVersion: 8, minimumMacOSVersion: "10.14",
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, hash(data)])),
    ...manifestOverrides,
  };
  fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), JSON.stringify(manifest));
  if (extraEntry) extraEntry(runtime, root);
  const archive = path.join(root, "runtime.tar.gz");
  await tar.create({ gzip: true, portable: true, cwd: path.dirname(runtime), file: archive }, ["runtime"]);
  fs.writeFileSync(archive + ".sha256", hash(fs.readFileSync(archive)) + "  runtime.tar.gz\n");
  const applicationRoot = path.join(root, "application");
  const output = path.join(applicationRoot, ".cloudcare/native/darwin/runtime");
  return { root, archive, applicationRoot, output };
}

test("installs a Native SDK archive without invoking any native tools", async (t) => {
  const data = await fixture(t);
  const { installManagedRuntime } = await installModule();
  const output = await installManagedRuntime({
    applicationRoot: data.applicationRoot,
    options: { sdkVersion, runtimeArchive: data.archive },
    fetchImpl() { throw new Error("Local installation must not download"); },
  });
  assert.equal(output, data.output);
  assert.equal(fs.readFileSync(path.join(output, "guance_electron.node"), "utf8"), "fixture addon");
});

test("downloads fixed release assets and reuses a verified archive cache", async (t) => {
  const data = await fixture(t);
  const { installManagedRuntime } = await installModule();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(fs.readFileSync(url.endsWith(".sha256") ? data.archive + ".sha256" : data.archive));
  };
  await installManagedRuntime({ applicationRoot: data.applicationRoot, options: { sdkVersion }, fetchImpl });
  assert.equal(urls.length, 2);
  assert.equal(
    urls[1],
    `https://github.com/GuanceCloud/datakit-ios/releases/download/${sdkVersion}/guance-electron-runtime-${sdkVersion}-darwin-universal.tar.gz`,
  );
  await installManagedRuntime({
    applicationRoot: data.applicationRoot,
    options: { sdkVersion },
    fetchImpl() { throw new Error("Verified cache should avoid download"); },
  });
  assert.ok(fs.existsSync(path.join(data.output, "guance_electron.node")));
});

test("checksum failure preserves an existing runtime", async (t) => {
  const data = await fixture(t);
  const { installManagedRuntime } = await installModule();
  fs.mkdirSync(data.output, { recursive: true });
  fs.writeFileSync(path.join(data.output, "previous"), "keep");
  fs.appendFileSync(data.archive, "corruption");
  await assert.rejects(installManagedRuntime({
    applicationRoot: data.applicationRoot, options: { sdkVersion, runtimeArchive: data.archive },
  }), /SHA-256 mismatch/u);
  assert.equal(fs.readFileSync(path.join(data.output, "previous"), "utf8"), "keep");
});

test("rejects a non-Universal runtime, mismatched SDK version, linkage, and file hashes", async (t) => {
  const { installManagedRuntime } = await installModule();
  for (const overrides of [
    { architectures: ["arm64"] }, { nativeSDK: { version: "1.6.7" } },
    { nativeSDKLinkage: "dynamic" }, { files: {} },
  ]) {
    const data = await fixture(t, overrides);
    await assert.rejects(installManagedRuntime({
      applicationRoot: data.applicationRoot, options: { sdkVersion, runtimeArchive: data.archive },
    }), /manifest|checksums/u);
    assert.equal(fs.existsSync(data.output), false);
  }
});

test("rejects archive symlinks before exposing a runtime", { skip: process.platform === "win32" }, async (t) => {
  const data = await fixture(t, {}, (runtime, root) => {
    fs.symlinkSync(root, path.join(runtime, "outside"));
  });
  const { installManagedRuntime } = await installModule();
  await assert.rejects(installManagedRuntime({
    applicationRoot: data.applicationRoot, options: { sdkVersion, runtimeArchive: data.archive },
  }), /Invalid runtime archive entry/u);
  assert.equal(fs.existsSync(data.output), false);
});

test("missing release fails without any source-build fallback", async (t) => {
  const data = await fixture(t);
  const { installManagedRuntime } = await installModule();
  await assert.rejects(installManagedRuntime({
    applicationRoot: data.applicationRoot, options: { sdkVersion },
    fetchImpl: async () => new Response("", { status: 404 }),
  }), /HTTP 404/u);
  assert.equal(fs.existsSync(data.output), false);
  assert.equal(fs.existsSync(path.join(path.dirname(data.output), ".install-lock")), false);
});

test("rejects unsafe version and mirror input before making a request", async () => {
  const { runtimeRelease } = await installModule();
  assert.throws(() => runtimeRelease(), /version is required/u);
  assert.throws(() => runtimeRelease({ sdkVersion: "../../main" }), /Invalid Native SDK version/u);
  assert.throws(() => runtimeRelease({ sdkVersion, downloadBaseURL: "http://example.com" }), /HTTPS/u);
});

test("a downloaded archive with an invalid manifest is not cached", async (t) => {
  const data = await fixture(t, { nativeSDK: { version: "1.6.7" } });
  const { installManagedRuntime } = await installModule();
  await assert.rejects(installManagedRuntime({
    applicationRoot: data.applicationRoot,
    options: { sdkVersion },
    fetchImpl: async (url) => new Response(fs.readFileSync(url.endsWith(".sha256") ? data.archive + ".sha256" : data.archive)),
  }), /manifest/u);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(data.output), ".cache")), []);
});
