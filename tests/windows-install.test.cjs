"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const tar = require("tar");
const { stageWindowsRuntime } = require("../packaging/windows.cjs");
const installer = () => import(pathToFileURL(path.join(__dirname, "../native/darwin/scripts/lib/install-runtime.mjs")).href);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const sdkVersion = "3.2.1-alpha.1";

// Synthetic headers test the installer contract; they are not runnable native binaries.
async function fixture(t, nested = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-sdk-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "source/runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const manifest = { schemaVersion: 1, platform: "win32", arch: "x64", configuration: "Release", protocolVersion: 1,
    sdkVersion, source: { commit: "a".repeat(40), dirty: false }, crt: { policy: "prerequisite" }, files: {} };
  for (const name of ["guance_windows_electron_bridge.exe", "guance_windows_native.dll"]) {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    fs.writeFileSync(path.join(runtime, name), bytes);
    manifest.files[name] = { size: bytes.length, sha256: hash(bytes) };
  }
  fs.writeFileSync(path.join(runtime, "runtime-manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(runtime, "LICENSE"), "Synthetic test license");
  const archive = path.join(root, "sdk-runtime.tar.gz");
  await tar.create({ gzip: true, portable: true, cwd: nested ? path.dirname(runtime) : runtime, file: archive }, nested ? ["runtime"] : fs.readdirSync(runtime));
  fs.writeFileSync(archive + ".sha256", hash(fs.readFileSync(archive)) + "  sdk-runtime.tar.gz\n");
  const applicationRoot = path.join(root, "application");
  return { root, archive, applicationRoot, output: path.join(applicationRoot, ".cloudcare/native/win32-x64/runtime") };
}

test("Windows online and offline installers consume the same SDK archive", async (t) => {
  const f = await fixture(t);
  const { installManagedRuntime } = await installer();
  const urls = [];
  const options = { sdkVersion, target: "win32-x64", assetName: "sdk-runtime.tar.gz" };
  const output = await installManagedRuntime({ applicationRoot: f.applicationRoot, options, fetchImpl: async (url) => {
    urls.push(url);
    return new Response(fs.readFileSync(url.endsWith(".sha256") ? f.archive + ".sha256" : f.archive));
  } });
  assert.equal(output, f.output);
  assert.equal(urls[1], `https://github.com/GuanceCloud/datakit-windows-desktop/releases/download/${sdkVersion}/sdk-runtime.tar.gz`);
  const offline = await installManagedRuntime({ applicationRoot: path.join(f.root, "offline"),
    options: { sdkVersion, target: "win32-x64", runtimeArchive: f.archive },
    fetchImpl() { throw Error("Offline installation must never use the network"); } });
  for (const name of fs.readdirSync(output)) assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(offline, name)));
  const staged = stageWindowsRuntime({ resourcesDirectory: path.join(f.root, "resources"), nativeDirectory: offline });
  assert.ok(fs.existsSync(path.join(staged, "LICENSE")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, "runtime-manifest.json"))).npmPackageVersion, undefined);
});

test("Windows flat archives install via the public CLI without a Release filename", async (t) => {
  const f = await fixture(t, false);
  fs.mkdirSync(f.applicationRoot, { recursive: true });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/guance-electron-native.mjs"),
    "--sdk-version", sdkVersion, "--target", "win32-x64", "--runtime-archive", f.archive], {
    cwd: f.applicationRoot, encoding: "utf8", env: { ...process.env, GUANCE_NATIVE_RUNTIME_DOWNLOAD_BASE_URL: "https://offline.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(f.output, "guance_windows_native.dll")));
});

test("Windows rejects missing filenames, unsafe targets, wrong versions and missing checksums", async (t) => {
  const f = await fixture(t);
  const { runtimeRelease, installManagedRuntime } = await installer();
  assert.throws(() => runtimeRelease({ sdkVersion, target: "win32-x64" }), /--asset-name/);
  assert.throws(() => runtimeRelease({ sdkVersion, target: "linux" }), /Unsupported runtime target/);
  assert.throws(() => runtimeRelease({ sdkVersion, target: "win32-x64", assetName: "../file.tar.gz" }), /filename/);
  assert.throws(() => runtimeRelease({ sdkVersion, target: "win32-x64", assetName: "file.zip" }), /tar.gz/);
  const options = { target: "win32-x64", runtimeArchive: f.archive, sdkVersion: "1.0.0" };
  await assert.rejects(installManagedRuntime({ applicationRoot: f.applicationRoot, options }), /SDK version/);
  assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(f.archive + ".sha256");
  await assert.rejects(installManagedRuntime({ applicationRoot: f.applicationRoot, options: { ...options, sdkVersion } }), /ENOENT/);
});

test("CLI chooses the platform repository and supports cross-platform targets", async () => {
  const { parseCustomerCLIArguments } = await import(pathToFileURL(path.join(__dirname, "../native/darwin/scripts/lib/customer-cli.mjs")).href);
  const args = ["--sdk-version", sdkVersion, "--asset-name", "sdk.tar.gz"];
  assert.equal(parseCustomerCLIArguments(args, {}, "win32", "x64").installOptions.target, "win32-x64");
  assert.throws(() => parseCustomerCLIArguments(args, {}, "linux", "x64"), /Unsupported host/);
  assert.equal(parseCustomerCLIArguments([...args, "--target", "win32-x64"], {}, "linux", "x64").installOptions.target, "win32-x64");
});
