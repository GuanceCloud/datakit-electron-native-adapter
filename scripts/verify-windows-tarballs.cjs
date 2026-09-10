"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { npm } = require("./npm-command.cjs");
const { PACKAGE_NAME, RUNTIME_SUBDIRECTORY, validateRuntime } = require("../platform/win32/runtime.cjs");
const { readReleaseArtifact } = require("./release-artifact.cjs");

async function verify(directory) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Real runtime acceptance requires Windows x64.");
  const root = path.resolve(directory);
  const { report, tarball } = readReleaseArtifact(root, { allowDirty: true });
  const results = [];
  for (const omitOptional of [false, true]) {
    const consumer = fs.mkdtempSync(path.join(root, omitOptional ? "omit-optional-" : "consumer-"));
    fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"windows-single-package-consumer","version":"0.0.0","private":true}');
    // Empty cache, offline, no scripts: all runtime bytes must come from this one tarball.
    await npm(["install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--registry", "http://127.0.0.1:9", "--cache", path.join(consumer, ".npm-cache"),
      ...(omitOptional ? ["--omit=optional"] : [])], consumer);
    const packageRoot = path.join(consumer, "node_modules", PACKAGE_NAME);
    validateRuntime(path.join(packageRoot, RUNTIME_SUBDIRECTORY), { version: report.version });
    assert.equal(fs.existsSync(path.join(consumer, "node_modules", PACKAGE_NAME + "-win32-x64")), false);
    assert.equal(fs.lstatSync(packageRoot).isSymbolicLink(), false);
    const smoke = path.join(consumer, "smoke.cjs");
    fs.copyFileSync(path.join(__dirname, "windows-runtime-smoke.cjs"), smoke);
    const child = spawn(process.execPath, [smoke], { cwd: consumer, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-32000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-32000); });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(code, 0, output);
    } finally { clearTimeout(timeout); }
    results.push({ consumer, omitOptional, nativeSmoke: output.trim() });
  }
  const summary = { distribution: "single-package", version: report.version, offline: true, registryDownloads: 0,
    runtimeFiles: report.package.files.filter((file) => file.path.startsWith(RUNTIME_SUBDIRECTORY + "/")).map((file) => file.path), results };
  fs.writeFileSync(path.join(root, "verify-report.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) verify(process.argv[2]).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
