"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { npm } = require("./npm-command.cjs");
const { readReleaseArtifact, PACKAGE_NAME } = require("./github-release-artifact.cjs");
const { argumentsFor, writeJSON } = require("./release-common.cjs");

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("Package acceptance failed: " + output)); });
  });
}
async function verifyRelease({ directory, allowDirty = false, offline = false, skipRuntime = false }) {
  if (!directory) throw new Error("--directory is required.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root, { allowDirty });
  const consumer = fs.mkdtempSync(path.join(root, "verify-package-"));
  try {
    writeJSON(path.join(consumer, "package.json"), { name: "native-release-consumer", version: "0.0.0", private: true });
    // Skipping Native SDK installation must be explicit; normal verification exercises postinstall.
    await npm(["install", tarball, "--ignore-scripts=false", "--no-audit", "--no-fund", "--omit=optional", ...(offline ? ["--offline"] : [])], consumer,
      { environment: { ...process.env, GUANCE_NATIVE_SKIP_DOWNLOAD: skipRuntime ? "1" : "0" } });
    const packageRoot = path.join(consumer, "node_modules", PACKAGE_NAME);
    const output = await runNode([path.join(packageRoot, "bin/guance-electron-native.mjs"), "--help"], consumer);
    if (!output.includes("--runtime-archive") || !output.includes("--sdk-version")) throw new Error("Installed CLI is incomplete.");
    await runNode(["-e", "require(" + JSON.stringify(packageRoot) + ")"], consumer);
    const runtimeInstalled = fs.existsSync(path.join(packageRoot, ".cloudcare"));
    if (skipRuntime && runtimeInstalled) throw new Error("npm install ignored the explicit native installation skip.");
    const summary = { version: report.version, packageIntegrity: report.package.integrity, passed: true,
      checks: "npm install, CLI help, adapter import", runtimeSkipped: skipRuntime, runtimeInstalled, nativeRuntimeValidated: false };
    writeJSON(path.join(root, "verify-package-" + Date.now() + ".json"), summary);
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    const args = argumentsFor(process.argv.slice(2), ["directory"], ["allow-dirty", "offline", "skip-runtime"]);
    verifyRelease({ ...args, allowDirty: args["allow-dirty"], skipRuntime: args["skip-runtime"] }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyRelease };
