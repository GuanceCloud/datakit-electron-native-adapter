"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { npm } = require("./npm-command.cjs");
const { readReleaseArtifact, PACKAGE_NAME } = require("./github-release-artifact.cjs");
const { argumentsFor, writeJSON } = require("./release-common.cjs");
const { installedDirectory, targetFor } = require("../runtime/config.cjs");

function run(executable, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
    const timeout = setTimeout(() => child.kill(), 60000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve(output) : reject(new Error(`Windows runtime verification failed (${code}): ${output}`));
    });
  });
}

async function verifyWindowsRuntime({ directory, runtimeArchive, sdkVersion, electron, allowDirty = false, offline = false }) {
  const target = targetFor(process.platform, process.arch);
  if (process.platform !== "win32" || !target) throw new Error("Run native acceptance on Windows x64, x86 (ia32), or arm64 with matching Node and Electron architectures.");
  if (!directory || !runtimeArchive) throw new Error("--directory and --runtime-archive are required; supply a trusted SDK build.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root, { allowDirty });
  const consumer = fs.mkdtempSync(path.join(root, "verify-windows-"));
  const environment = { ...process.env, GUANCE_NATIVE_SKIP_DOWNLOAD: "0", GUANCE_NATIVE_RUNTIME_TARGET: target,
    GUANCE_NATIVE_RUNTIME_ARCHIVE: path.resolve(runtimeArchive) };
  // An explicit override is optional: default acceptance exercises the packed SDK tag.
  delete environment.GUANCE_NATIVE_SDK_VERSION;
  if (sdkVersion) environment.GUANCE_NATIVE_SDK_VERSION = sdkVersion;
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    writeJSON(path.join(consumer, "package.json"), { name: "windows-runtime-consumer", version: "0.0.0", private: true });
    await npm(["install", tarball, "--ignore-scripts=false", "--no-audit", "--no-fund", "--omit=optional", ...(offline ? ["--offline"] : [])],
      consumer, { environment });
    const packageRoot = path.join(consumer, "node_modules", PACKAGE_NAME);
    const runtime = installedDirectory(packageRoot, target);
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "runtime-manifest.json")));
    const staging = require(path.join(packageRoot, "packaging/windows.cjs"));
    const staged = staging.stageWindowsRuntime({ nativeDirectory: runtime, resourcesDirectory: path.join(consumer, "resources") });
    for (const script of ["windows-runtime-smoke.cjs", "windows-electron-smoke.cjs"]) {
      fs.copyFileSync(path.join(__dirname, script), path.join(consumer, script));
    }
    const nativeLog = await run(process.execPath, ["windows-runtime-smoke.cjs"], consumer,
      { ...environment, GUANCE_TEST_NATIVE_DIRECTORY: staged });
    const electronLog = electron ? await run(path.resolve(electron), [path.join(consumer, "windows-electron-smoke.cjs")], consumer,
      { ...environment, GUANCE_TEST_NATIVE_DIRECTORY: staged }) : undefined;
    const summary = { passed: true, version: report.version, packageIntegrity: report.package.integrity,
      arch: manifest.arch, sdkVersion: manifest.sdkVersion, sdkSource: manifest.source, nativeRuntimeValidated: true,
      electronValidated: Boolean(electron), nativeLog, electronLog };
    writeJSON(path.join(root, "verify-windows-" + Date.now() + ".json"), summary);
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    const args = argumentsFor(process.argv.slice(2), ["directory", "runtime-archive", "sdk-version", "electron"], ["allow-dirty", "offline"]);
    verifyWindowsRuntime({ ...args, runtimeArchive: args["runtime-archive"], sdkVersion: args["sdk-version"], allowDirty: args["allow-dirty"] })
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyWindowsRuntime };
