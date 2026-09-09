"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { npm } = require("./npm-command.cjs");
const { PACKAGE_NAME, validateRuntime } = require("../platform/win32/runtime.cjs");

async function verify(directory) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Real runtime acceptance requires Windows x64.");
  const root = path.resolve(directory);
  const report = JSON.parse(fs.readFileSync(path.join(root, "pack-report.json"), "utf8"));
  const tarball = fs.readFileSync(path.join(root, report.platform.filename));
  let downloads = 0;
  // A read-only loopback registry verifies npm's actual optionalDependency resolution.
  // It accepts no publish requests and never forwards requests to a public registry.
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (request.url === "/runtime.tgz") {
      downloads += 1;
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(tarball);
    } else if (decodeURIComponent(request.url) === `/${PACKAGE_NAME}`) {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "win32-x64/package.json"), "utf8"));
      metadata.dist = { tarball: `http://127.0.0.1:${server.address().port}/runtime.tgz`, integrity: report.platform.integrity, shasum: report.platform.shasum };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: PACKAGE_NAME, "dist-tags": { latest: report.version }, versions: { [report.version]: metadata } }));
    } else response.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const consumer = fs.mkdtempSync(path.join(root, "consumer-"));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const common = ["--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry, "--cache", path.join(consumer, ".npm-cache")];
  try {
    fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"windows-tarball-consumer","version":"0.0.0","private":true}');
    await npm(["install", path.join(root, report.main.filename), "--include=optional", ...common], consumer);
    assert.equal(downloads, 1, "npm must resolve and download the optional platform package from the registry");
    const installed = path.join(consumer, "node_modules", PACKAGE_NAME, "runtime");
    validateRuntime(installed, { version: report.version });
    const smoke = path.join(consumer, "smoke.cjs");
    fs.copyFileSync(path.join(__dirname, "windows-runtime-smoke.cjs"), smoke);
    const child = spawn(process.execPath, [smoke], { cwd: consumer, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(code, 0, output);
    } finally { clearTimeout(timeout); }
    const omitted = fs.mkdtempSync(path.join(root, "omitted-"));
    fs.writeFileSync(path.join(omitted, "package.json"), '{"name":"optional-omitted","version":"0.0.0","private":true}');
    await npm(["install", path.join(root, report.main.filename), "--omit=optional", ...common], omitted);
    const missing = require(path.join(omitted, "node_modules/@cloudcare/electron-native-adapter/platform/win32/runtime.cjs"));
    assert.throws(() => missing.resolveWindowsRuntime(), /Missing optional package.*include=optional/);
    const summary = { consumer, optionalRegistryDownloads: downloads, omittedOptionalError: "passed", nativeSmoke: output.trim(), platformFiles: report.platform.files.map((file) => file.path) };
    fs.writeFileSync(path.join(root, "verify-report.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
if (require.main === module) verify(process.argv[2]).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
